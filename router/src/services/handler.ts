import type { IncomingMessage } from "../types";
import { findRoute } from "./router";
import { askClaude, sessionKey } from "./claude";
import { canVoice, canVision } from "./capabilities";
import { logger } from "./logger";
import { checkIncomingRate } from "./rate-limiter";
import { trackMessage, trackResponseTime, pushLog } from "../dashboard/server";
import { addMemory } from "./memory";
import { existsSync, statSync } from "fs";
import { basename, extname } from "path";
import { chunkForDiscord } from "./discord-chunker";
import { formatForChannel } from "./formatting";
import { recordExchange } from "./session-cache";
import { formatTimingFooter } from "./timings";
import { recordCost } from "./cost-tracker";
import { startJob, endJob, type PendingChannel } from "./pending-jobs";
import { randomUUID } from "crypto";
import type { MessageTimings } from "../types/message";

/** Compose full message text including quoted messages and media transcriptions */
function composeFullMessage(msg: IncomingMessage): string {
  const parts: string[] = [];

  // Quoted message context
  if (msg.quotedMessage) {
    if (msg.quotedMessage.text) {
      const from = msg.quotedMessage.from ? ` from ${msg.quotedMessage.from}` : "";
      parts.push(`[Replying to${from}: "${msg.quotedMessage.text.slice(0, 500)}"]`);
    }
    if (msg.quotedMessage.media) {
      for (const m of msg.quotedMessage.media) {
        if (m.processedText) {
          const label = m.type === "voice" || m.type === "audio" ? "Quoted voice" : m.type === "image" ? "Quoted image" : "Quoted document";
          parts.push(`[${label}: ${m.processedText}]`);
        }
      }
    }
  }

  // Media transcriptions/descriptions
  if (msg.media) {
    for (const m of msg.media) {
      if (m.processedText) {
        const label = m.type === "voice" || m.type === "audio"
          ? "Voice message"
          : m.type === "image" ? "Image" : m.type === "video" ? "Video" : "Document";
        parts.push(`[${label}: ${m.processedText}]`);
      }
      if (m.caption) parts.push(m.caption);
    }
  }

  // Original text
  if (msg.text) parts.push(msg.text);

  return parts.join("\n\n") || "[Media without text]";
}

const log = logger.child({ module: "handler" });

/** Dedupe cache: key → timestamp */
const dedupeCache = new Map<string, number>();
const DEDUPE_TTL_MS = 20 * 60 * 1000; // 20 minutes
const DEDUPE_MAX = 5000;

/** Cleanup stale dedupe entries */
function cleanupDedupe(): void {
  const now = Date.now();
  for (const [key, ts] of dedupeCache) {
    if (now - ts > DEDUPE_TTL_MS) dedupeCache.delete(key);
  }
}

// Periodic cleanup every 5 min
setInterval(cleanupDedupe, 5 * 60 * 1000);

/** Process an incoming message: dedupe → rate limit → route → claude → reply */
export async function handleMessage(msg: IncomingMessage): Promise<void> {
  // Dedupe check
  if (msg.messageId) {
    const dedupeKey = `${msg.channel}|${msg.from}|${msg.messageId}`;
    if (dedupeCache.has(dedupeKey)) {
      log.debug({ dedupeKey }, "Duplicate message — skipping");
      return;
    }
    // Evict oldest if at capacity
    if (dedupeCache.size >= DEDUPE_MAX) {
      const oldest = dedupeCache.keys().next().value;
      if (oldest) dedupeCache.delete(oldest);
    }
    dedupeCache.set(dedupeKey, Date.now());
  }

  // Rate limit check
  if (!checkIncomingRate(msg.channel, msg.from)) {
    log.warn({ channel: msg.channel, from: msg.from }, "Incoming rate limit exceeded — dropping");
    return;
  }

  // Owner-only @jarvis override: skip route matching, use the injected agent directly
  const agent = msg.agentOverride ?? (() => {
    const route = findRoute(msg);
    if (!route) {
      log.debug({ channel: msg.channel, from: msg.from }, "No route — ignoring");
      return null;
    }
    if (route.action === "ignore") {
      log.debug({ channel: msg.channel, from: msg.from }, "Route action: ignore");
      return null;
    }
    if (!route.agent) {
      log.warn({ channel: msg.channel, from: msg.from }, "Route matched but no agent configured");
      return null;
    }
    return route.agent;
  })();

  if (!agent) return;

  // Preserve a route-shaped object downstream so existing code referencing `route.agent` still works
  const route = { agent } as { agent: typeof agent; action?: undefined };

  const key = sessionKey(msg.channel, msg.from, msg.group);

  // Initialize timings (media phase already populated by connector if present)
  const timings: MessageTimings = msg.timings ?? { received: Date.now() };
  msg.timings = timings;
  const startTime = timings.received;

  // Start typing indicator & reaction (👀 only if not already sent by connector for media)
  const stopTyping = msg.startTyping?.() ?? (() => {});
  if (!timings.mediaStart) {
    await msg.react?.("👀").catch(() => {});
  }

  try {
    const fullText = composeFullMessage(msg);
    const tools = route.agent.tools ?? [];

    // Vision: Claude Code CLI ignores base64 image content blocks in stream-json,
    // but its Read tool can view image files natively. So we append the local path
    // to the message text instead.
    const imagePaths: string[] = [];
    if (canVision(route.agent)) {
      for (const m of msg.media ?? []) {
        if (m.type === "image" && m.localPath) {
          imagePaths.push(m.localPath);
        }
      }
    } else if (msg.media?.some(m => m.type === "image")) {
      log.warn({ key, channel: msg.channel }, "Image received but vision not enabled — skipping");
    }

    if (!canVoice(route.agent) && msg.media?.some(m => m.type === "voice" || m.type === "audio")) {
      log.warn({ key, channel: msg.channel }, "Voice media received but voice not enabled");
    }

    // Memory scope: derive from tools
    const memoryTool = tools.find(t => t.startsWith("memory:"));
    const memoryScope = memoryTool ? memoryTool.split(":")[1] : null;

    // 🧠 reaction (typing stays ON during Claude call — interval keeps refreshing)
    await msg.react?.("🧠").catch(() => {});

    // Append image file paths so Claude reads them via its Read tool
    let messageForClaude = fullText;
    if (imagePaths.length > 0) {
      const pathList = imagePaths.map(p => `  ${p}`).join("\n");
      messageForClaude += `\n\n[${imagePaths.length} image${imagePaths.length > 1 ? "s" : ""} attached — view with Read tool]\n${pathList}`;
    }

    // Register job so we can notify the user if the router restarts mid-call
    const jobId = randomUUID();
    const replyTarget = msg.replyTarget;
    if (replyTarget) {
      startJob({
        id: jobId,
        channel: msg.channel as PendingChannel,
        target: replyTarget,
        userText: fullText.slice(0, 200),
        startedAt: Date.now(),
      });
    }

    timings.llmStart = Date.now();
    const response = await askClaude(route.agent, messageForClaude, key)
      .finally(() => endJob(jobId));
    timings.llmEnd = Date.now();
    trackMessage(msg.channel);

    // Stop typing right before sending reply
    stopTyping();

    // Convert markdown to platform-native formatting, then append footer
    const formatted = formatForChannel(response.text, msg.channel);
    const model = response.model ?? "—";
    const agentName = basename(route.agent.workspace);
    const footer = formatTimingFooter(timings, agentName, model, response.inputTokens, response.outputTokens);
    const finalResponse = `${formatted}\n\n${footer}`;

    const wallMs = (timings.llmEnd ?? Date.now()) - startTime;
    const apiMs = response.apiDurationMs ?? 0;
    trackResponseTime(key, wallMs, apiMs, model);

    // Persist cost data
    if (response.costUsd !== undefined) {
      recordCost({
        ts: Date.now(),
        route: agentName,
        channel: msg.channel,
        from: String(msg.from),
        model,
        inputTokens: response.inputTokens ?? 0,
        outputTokens: response.outputTokens ?? 0,
        cacheCreation: response.cacheCreation ?? 0,
        cacheRead: response.cacheRead ?? 0,
        costUsd: response.costUsd,
        durationMs: wallMs,
        apiDurationMs: apiMs,
      });
    }

    // Split long responses for platforms with message limits
    const chunks = msg.channel === "discord"
      ? chunkForDiscord(finalResponse)
      : splitMessage(finalResponse, 4000);

    timings.sendStart = Date.now();
    for (const chunk of chunks) {
      await replyWithRetry(msg, chunk);
    }
    timings.sendEnd = Date.now();

    // Send files created by Claude as attachments
    if (msg.sendFile && response.createdFiles?.length) {
      const sendable = filterSendableFiles(response.createdFiles);
      for (const filePath of sendable) {
        try {
          await msg.sendFile(filePath, basename(filePath));
          log.info({ filePath, channel: msg.channel }, "Sent file attachment");
        } catch (e) {
          log.error({ err: e, filePath }, "Failed to send file");
        }
      }
    }

    await msg.react?.("👍").catch(() => {});

    // Persist exchange for session continuity across restarts
    recordExchange(key, fullText, response.text);

    // Save conversation to Mem0 using tool-derived scope
    if (memoryScope) {
      addMemory(`User: ${msg.text}\nAssistant: ${response.text}`, memoryScope).catch(() => {});
    }
  } catch (err) {
    stopTyping();
    await msg.react?.("👎").catch(() => {});

    log.error({ err, channel: msg.channel, from: msg.from }, "Handler error");
    try {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("TIMEOUT")) {
        await msg.reply("› timeout — riprova tra un momento");
      } else if (errMsg.includes("ALL_MODELS_EXHAUSTED")) {
        await msg.reply("› tutti i modelli occupati — riprova tra qualche minuto");
      } else {
        await msg.reply("› errore nell'elaborazione del messaggio");
      }
    } catch (replyErr) {
      log.error({ err: replyErr, channel: msg.channel, from: msg.from }, "Failed to send error reply");
    }
  }
}

/** Max file size to send via chat (10MB) */
const MAX_SEND_FILE_SIZE = 10 * 1024 * 1024;

/** Extensions worth sending as attachments (not source code that Claude edited) */
const SENDABLE_EXTS = new Set([
  ".pdf", ".csv", ".xlsx", ".xls", ".doc", ".docx", ".txt", ".json", ".xml",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  ".mp3", ".mp4", ".wav", ".ogg",
  ".zip", ".tar", ".gz",
  ".html", ".md",
]);

/** Filter created files to only those worth sending as attachments */
function filterSendableFiles(filePaths: string[]): string[] {
  const seen = new Set<string>();
  return filePaths.filter(p => {
    if (seen.has(p)) return false;
    seen.add(p);
    const ext = extname(p).toLowerCase();
    if (!SENDABLE_EXTS.has(ext)) return false;
    try {
      const stat = statSync(p);
      return stat.isFile() && stat.size > 0 && stat.size <= MAX_SEND_FILE_SIZE;
    } catch { return false; }
  });
}

/** Reply with retry — on Discord 50035 (too long), re-chunk and retry; on rate limit, backoff */
async function replyWithRetry(msg: IncomingMessage, text: string, attempt = 0): Promise<void> {
  const MAX_ATTEMPTS = 3;
  try {
    await msg.reply(text);
  } catch (err: any) {
    const code = err?.code ?? err?.rawError?.code;
    const status = err?.status;

    // 50035 = Invalid Form Body (message too long) — re-chunk smaller
    if (code === 50035 && attempt < MAX_ATTEMPTS) {
      log.warn({ len: text.length, attempt }, "Discord rejected message (too long), re-chunking");
      const smaller = chunkForDiscord(text);
      for (const chunk of smaller) {
        await replyWithRetry(msg, chunk, attempt + 1);
      }
      return;
    }

    // 429 = rate limit — backoff and retry
    if ((status === 429 || code === 429) && attempt < MAX_ATTEMPTS) {
      const retryAfter = err?.retryAfter ?? err?.retry_after ?? 1;
      const delay = Math.min(retryAfter * 1000, 30000);
      log.warn({ delay, attempt }, "Discord rate limited, backing off");
      await new Promise(r => setTimeout(r, delay));
      return replyWithRetry(msg, text, attempt + 1);
    }

    // Other error — log and rethrow
    log.error({ err, code, status, textLen: text.length, channel: msg.channel }, "Discord reply failed");
    throw err;
  }
}

/** Split a message into chunks at newline boundaries */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Find last newline before maxLen
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
