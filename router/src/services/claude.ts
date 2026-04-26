import { spawn, ChildProcess } from "child_process";
import { join } from "path";
import { createInterface, Interface } from "readline";
import { readdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import type { AgentConfig } from "../types";
import { logger } from "./logger";
import { buildContextFromCache } from "./session-cache";
import { readMcpServers } from "./config-loader";
import { issueToken, revokeToken } from "./notify-tokens";
import { resetNotifyBudget, hasNotifyBudget, consumeNotifyBudget } from "./rate-limiter";
import { shouldCompact, contextWindowFor } from "./context";
import { broadcast, clientCount } from "../dashboard/ws";
import {
  extractTaskNotificationFromEvent,
  formatTaskNotificationMessage,
  formatChildNotificationFooter,
  type TaskNotificationEnvelope,
} from "./task-notification";
import { getDeliveryFn } from "./cron";
import { formatForChannel } from "./formatting";

const log = logger.child({ module: "claude" });

// --- Constants ---
// Auto-detect latest Claude CLI version. Resolved lazily at each spawn so that
// an auto-update during router boot doesn't leave us stuck on a stale fallback.
const CLI_VERSIONS_DIR = join(process.env.HOME || "", ".local/share/claude/versions");
export function resolveCliPath(): string {
  try {
    const versions = readdirSync(CLI_VERSIONS_DIR)
      .filter((f) => /^\d/.test(f))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions.length > 0) return `${CLI_VERSIONS_DIR}/${versions[0]}`;
  } catch { /* directory not readable — fall through */ }
  // Fallback: use the stable launcher script (exists even if versions dir is transient)
  const launcher = join(process.env.HOME || "", ".local/bin/claude");
  try {
    if (existsSync(launcher)) return launcher;
  } catch {}
  // Last resort — rely on PATH (only works if PATH contains ~/.local/bin)
  return "claude";
}
// --- Env var sanitization ---
// Only forward safe env vars to spawned Claude CLI processes.
// Blocks secrets that could leak via prompt injection.
const ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "NODE_ENV", "TZ", "USER", "SHELL", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "ANTHROPIC_API_KEY",  // Claude CLI needs this to authenticate
]);

const ENV_BLOCKLIST_PATTERNS = [
  /API_KEY/i, /TOKEN/i, /SECRET/i, /PASSWORD/i,
  /PRIVATE_KEY/i, /CREDENTIAL/i, /AUTH/i,
];

const ENV_BLOCKLIST_EXCEPTIONS = new Set(["ANTHROPIC_API_KEY"]);

interface NotifyEnvContext {
  sessionKey: string;
  channel: string;
  target: string;
  token: string;
}

function buildSafeEnv(
  agentEnv?: Record<string, string>,
  opts?: { isSubagent?: boolean; notify?: NotifyEnvContext },
): Record<string, string> {
  const env: Record<string, string> = {};

  // Pass through only allowlisted vars from process.env
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }

  // Double-check blocklist (in case allowlist has a sensitive entry)
  for (const key of Object.keys(env)) {
    if (ENV_BLOCKLIST_EXCEPTIONS.has(key)) continue;
    if (ENV_BLOCKLIST_PATTERNS.some(p => p.test(key))) {
      log.debug({ blockedVar: key }, "Blocked env var from agent spawn");
      delete env[key];
    }
  }

  // Agent-specific env from agent.yaml (explicit = always forwarded)
  if (agentEnv) Object.assign(env, agentEnv);

  env.JARVIS_SPAWN = "1";

  if (opts?.isSubagent) {
    env.JARVIS_IS_SUBAGENT = "1";
  }

  // Notify context — only for primary spawns. Subagents never get a token:
  // they cannot notify, by design. The token binds this CLI process to one
  // (channel, target) pair for proactive replies.
  if (opts?.notify && !opts.isSubagent) {
    env.JARVIS_SESSION_KEY = opts.notify.sessionKey;
    env.JARVIS_CHANNEL = opts.notify.channel;
    env.JARVIS_REPLY_TARGET = opts.notify.target;
    env.JARVIS_NOTIFY_URL = "http://127.0.0.1:3340/api/notify";
    env.JARVIS_NOTIFY_TOKEN = opts.notify.token;
  }

  return env;
}

const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 min
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1000; // 2 ore
const MESSAGE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — generous, crash is handled by process exit event

// Identity flow: two layers, no inline append.
//  1. ~/.claude/CLAUDE.md  → user-global common layer (loaded via --setting-sources user, skipped when agent.inheritUserScope=false)
//  2. <workspace>/CLAUDE.md → per-route agent identity (auto-loaded by Claude Code from cwd)
// External/client agents (inheritUserScope=false) run with project,local only — no user scope leakage.
// Any third layer would risk conflicting with agent-specific rules (e.g. language, scope).
//
// Subagents are the ONE documented exception: spawns flagged `isSubagent=true`
// (e.g. cron jobs) get a third layer via --append-system-prompt because they
// have no identity of their own — no fight to lose. See CLAUDE.md.
const SUBAGENT_SYSTEM_PROMPT = "You are a subagent. Respond ONLY to the specific task. No preambles, no personal memory, no brand. Terse, bullet-form when natural, no decorative markdown unless asked.";

// --- Model resolution ---
// Claude Code CLI resolves aliases ("opus"/"sonnet"/"haiku") to the latest model
// automatically. Pass alias through unchanged, or a pinned ID if agent.yaml sets one.
function resolveModel(name: string | undefined): string {
  return name && name.trim() ? name : "opus";
}

// --- System prompt loading ---
function loadEnvContext(env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return "";
  const envBlock = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
  return `Environment context:\n${envBlock}`;
}

// --- Usage stats ---
interface SessionStat {
  messages: number;
  charsIn: number;
  charsOut: number;
  totalTimeMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  costUsd: number;
  lastDurationMs: number;
  lastApiDurationMs: number;
}

function emptyStat(): SessionStat {
  return { messages: 0, charsIn: 0, charsOut: 0, totalTimeMs: 0, inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0, costUsd: 0, lastDurationMs: 0, lastApiDurationMs: 0 };
}

const sessionStats = new Map<string, SessionStat>();

const SESSION_STATS_FILE = join(homedir(), ".claude/jarvis/router/session-stats.json");

function loadPersistedSessionStats(): void {
  try {
    const raw = readFileSync(SESSION_STATS_FILE, "utf-8");
    const data = JSON.parse(raw) as Record<string, SessionStat>;
    for (const [key, stat] of Object.entries(data)) {
      sessionStats.set(key, { ...emptyStat(), ...stat });
    }
  } catch { /* first run or corrupt — start fresh */ }
}

function persistSessionStats(): void {
  try {
    const obj: Record<string, SessionStat> = {};
    for (const [k, v] of sessionStats) obj[k] = v;
    writeFileSync(SESSION_STATS_FILE, JSON.stringify(obj), "utf-8");
  } catch (err) { log.warn({ err }, "Failed to persist session stats"); }
}

loadPersistedSessionStats();
setInterval(persistSessionStats, 30_000);
process.on("beforeExit", persistSessionStats);
process.on("SIGINT", () => { persistSessionStats(); });
process.on("SIGTERM", () => { persistSessionStats(); });

function trackUsage(key: string, charsIn: number, charsOut: number, timeMs: number, usage?: { inputTokens?: number; outputTokens?: number; cacheCreation?: number; cacheRead?: number; costUsd?: number; apiDurationMs?: number }): void {
  const existing = sessionStats.get(key) ?? emptyStat();
  existing.messages++;
  existing.charsIn += charsIn;
  existing.charsOut += charsOut;
  existing.totalTimeMs += timeMs;
  existing.inputTokens += usage?.inputTokens ?? 0;
  existing.outputTokens += usage?.outputTokens ?? 0;
  existing.cacheCreation += usage?.cacheCreation ?? 0;
  existing.cacheRead += usage?.cacheRead ?? 0;
  existing.costUsd += usage?.costUsd ?? 0;
  existing.lastDurationMs = timeMs;
  existing.lastApiDurationMs = usage?.apiDurationMs ?? 0;
  sessionStats.set(key, existing);
}

// --- Persistent process management ---

interface PersistentProcess {
  /** Session key (channel:target[:group]) — invariant for this process's lifetime. */
  sessionKey: string;
  proc: ChildProcess;
  readline: Interface;
  model: string;
  /** Concrete model ID reported by the CLI stream (e.g. "claude-opus-4-7"). Set after first event. */
  resolvedModel: string | null;
  workspace: string;
  createdAt: number;
  lastActivity: number;
  consecutiveTimeouts: number;
  alive: boolean;
  // Pending message resolver
  pendingResolve: ((result: { text: string; durationMs?: number; apiDurationMs?: number; createdFiles?: string[]; inputTokens?: number; outputTokens?: number; cacheCreation?: number; cacheRead?: number; costUsd?: number }) => void) | null;
  pendingReject: ((err: Error) => void) | null;
  /** Files created/written by Claude during current turn */
  pendingFiles: string[];
  /** Whether this process needs session context injected on first message */
  needsContext: boolean;
  inactivityTimer: ReturnType<typeof setTimeout> | null;
  lifetimeTimer: ReturnType<typeof setTimeout> | null;
  /** Plaintext notify token issued at spawn — revoked on killProcess. */
  notifyToken: string | null;
  /** Whether this process was spawned as a subagent (no notify, dedicated prompt). */
  isSubagent: boolean;
  /**
   * Authoritative cumulative input-token count for this session.
   * Updated after each assistant response to the latest per-call
   * `input_tokens + cache_*` reported by the CLI, which already represents
   * the full conversation size Claude API charged for (i.e. running total
   * of the conversation, not a delta). Used by `shouldCompact`.
   */
  totalInputTokens: number;
  /** Number of times this session has been compacted. Hard reset at 5. */
  compactionCount: number;
  /**
   * Summary captured at the last compaction. Prepended as a USER turn on the
   * first send to the respawned process, then cleared. Never passed via
   * --append-system-prompt (that would collide with agent-specific identity —
   * see CLAUDE.md "two layers only" rule).
   */
  lastSummary?: string;
  /**
   * Task IDs we have already auto-notified for. Background task notifications
   * arrive both as a synthetic user-message (live) AND as a system record
   * (history replay) — without dedup we'd ping the user twice for the same
   * task completion.
   */
  notifiedTaskIds?: Set<string>;
}

const processes = new Map<string, PersistentProcess>();

/**
 * Summaries carried over from compacted sessions, indexed by session key.
 * Populated by `compactSession` just before the old process dies, consumed
 * (and cleared) by `doSendWithTimeout` on the next turn so the summary is
 * injected as the FIRST USER TURN of the respawned process — never via
 * --append-system-prompt (that would collide with agent identity).
 */
const pendingSummaries = new Map<string, { summary: string; compactionCount: number }>();

/** Build CLI args and env for spawning Claude Code */
function buildSpawnArgs(opts: {
  model: string;
  tools: string[];
  effort?: "low" | "medium" | "high" | "max";
  streaming: boolean;
  fullAccess?: boolean;
  agentEnv?: Record<string, string>;
  inheritUserScope?: boolean;
  isSubagent?: boolean;
  notify?: NotifyEnvContext;
}): { args: string[]; env: Record<string, string> } {
  const { model, tools, effort, streaming, fullAccess, inheritUserScope = true, isSubagent, notify } = opts;
  // Readonly routes need acceptEdits mode so --disallowed-tools actually blocks.
  // bypassPermissions skips ALL permission checks including the disallowed list.
  // fullAccess overrides everything → bypassPermissions, no restrictions.
  const isReadonly = !fullAccess && tools.includes("fileAccess:readonly") && !tools.includes("fileAccess:full");
  const permissionMode = isReadonly ? "acceptEdits" : "bypassPermissions";
  // External/client agents skip user-scope so the owner's ~/.claude/CLAUDE.md and hooks don't leak.
  const settingSources = inheritUserScope ? "user,project,local" : "project,local";
  const args: string[] = [
    "--print",
    "--permission-mode", permissionMode,
    "--model", model,
    "--setting-sources", settingSources,
    "--exclude-dynamic-system-prompt-sections",
  ];

  if (streaming) {
    // Streaming mode needs --verbose so the CLI emits per-step events we can parse.
    args.push("--verbose", "--input-format", "stream-json", "--output-format", "stream-json");
  } else {
    // Non-streaming ("fresh") call: plain JSON, no --verbose so we get a single
    // object with `.result` instead of an event array.
    args.push("--output-format", "json");
  }

  if (effort) {
    args.push("--effort", effort);
  }

  // MCP servers:
  //  - fullAccess → inject ALL shared MCP servers
  //  - otherwise → filter by `mcp:<name>` entries in tools
  // Always --strict-mcp-config so nothing leaks from user scope.
  if (fullAccess) {
    const allServers = readMcpServers();
    if (Object.keys(allServers).length > 0) {
      args.push("--mcp-config", JSON.stringify({ mcpServers: allServers }));
    }
    args.push("--strict-mcp-config");
  } else {
    const mcpToolNames = tools.filter(t => t.startsWith("mcp:")).map(t => t.slice(4));
    if (mcpToolNames.length === 0) {
      args.push("--strict-mcp-config");
    } else {
      const allServers = readMcpServers();
      const filtered: Record<string, any> = {};
      for (const name of mcpToolNames) {
        if (allServers[name]) filtered[name] = allServers[name];
      }
      if (Object.keys(filtered).length > 0) {
        args.push("--mcp-config", JSON.stringify({ mcpServers: filtered }));
      }
      args.push("--strict-mcp-config");
    }
  }

  // Tool restrictions: fileAccess:readonly → real disallowed tools
  if (isReadonly) {
    args.push("--disallowed-tools", "Write Edit NotebookEdit Bash(rm:*) Bash(mv:*)");
  }

  // Subagent: append the dedicated system prompt. Only safe here because
  // subagents have no identity of their own (see comment on SUBAGENT_SYSTEM_PROMPT).
  if (isSubagent) {
    args.push("--append-system-prompt", SUBAGENT_SYSTEM_PROMPT);
  }

  const env = buildSafeEnv(opts.agentEnv, { isSubagent, notify });

  return { args, env };
}

/** Parse `channel:target[:group]` session keys into notify binding parts.
 *  Mirror of sessionKey() — kept local so notify context is derived from the
 *  same invariant we use everywhere else. */
function parseSessionKey(key: string): { channel: string; target: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0 || idx === key.length - 1) return null;
  const channel = key.slice(0, idx);
  const target = key.slice(idx + 1);
  return { channel, target };
}

/**
 * Auto-deliver a background-task completion notification to the origin channel.
 *
 * Called from the stream-json parser when we see a <task-notification> marker.
 * Two arrival paths are deduped by taskId:
 *   - synthetic user-message (live, mid-stream)
 *   - system record (history replay on reconnect)
 *
 * Subagents skip — they have no notify token by design (only the primary agent
 * delivers to the user's channel).
 *
 * Reuses the per-session notify budget so a runaway prompt that spawns N
 * background tasks can't flood the channel beyond the existing 100/session cap.
 */
function handleTaskNotification(pp: PersistentProcess, env: TaskNotificationEnvelope): void {
  // Process killed before we got around to delivering — drop the event.
  if (!pp.alive) return;
  // Subagents don't notify the user — only primary agents do.
  if (pp.isSubagent) return;
  // Tasks without an ID can't be deduped reliably; skip rather than risk doubles.
  if (!env.taskId) return;

  if (!pp.notifiedTaskIds) pp.notifiedTaskIds = new Set<string>();
  if (pp.notifiedTaskIds.has(env.taskId)) return;
  pp.notifiedTaskIds.add(env.taskId);

  const parsed = parseSessionKey(pp.sessionKey);
  if (!parsed) return;

  const deliver = getDeliveryFn();
  if (!deliver) {
    log.warn({ sessionKey: pp.sessionKey, taskId: env.taskId }, "Task notification ready but no delivery fn");
    return;
  }

  // Reuse the existing per-session notify budget — same lever the
  // POST /api/notify endpoint uses, so the user has a single guarantee
  // ("max 100 outbound messages per session").
  if (!hasNotifyBudget(pp.sessionKey, 100)) {
    log.warn(
      { sessionKey: pp.sessionKey, taskId: env.taskId },
      "Task notification dropped — session budget exhausted",
    );
    return;
  }

  // Derive agent name from workspace path (".../agents/<name>") for the footer.
  // Falls back to undefined if the workspace doesn't follow that convention.
  const workspaceParts = pp.workspace.split("/");
  const agentsIdx = workspaceParts.lastIndexOf("agents");
  const agentName = agentsIdx >= 0 && workspaceParts[agentsIdx + 1] ? workspaceParts[agentsIdx + 1] : undefined;
  const modelName = pp.resolvedModel ?? pp.model;

  const body = formatTaskNotificationMessage(env);
  const footer = formatChildNotificationFooter(env, agentName, modelName);
  const text = `${body}\n\n${footer}`;
  const formatted = formatForChannel(text, parsed.channel);

  deliver(parsed.channel, parsed.target, formatted)
    .then(() => {
      consumeNotifyBudget(pp.sessionKey);
      log.info(
        { sessionKey: pp.sessionKey, taskId: env.taskId, status: env.status },
        "Background task notification delivered",
      );
      if (clientCount() > 0) {
        broadcast({
          type: "notify.outbound",
          data: {
            channel: parsed.channel,
            target: parsed.target,
            preview: body.slice(0, 120),
            messageId: null,
            ts: Date.now(),
          },
        });
      }
    })
    .catch((err: any) => {
      log.error(
        { err: err?.message, sessionKey: pp.sessionKey, taskId: env.taskId },
        "Task notification delivery failed",
      );
    });
}

function spawnPersistentProcess(
  key: string,
  model: string, workspace: string, tools: string[] = [],
  effort?: "low" | "medium" | "high" | "max",
  fullAccess?: boolean,
  agentEnv?: Record<string, string>,
  inheritUserScope?: boolean,
  isSubagent?: boolean,
): PersistentProcess {
  // Issue a notify token for primary (non-subagent) spawns only. Subagents
  // cannot notify — by design the binding lives on the primary agent.
  let notifyToken: string | null = null;
  let notify: NotifyEnvContext | undefined;
  if (!isSubagent) {
    const parsed = parseSessionKey(key);
    if (parsed) {
      notifyToken = issueToken(parsed.channel, parsed.target);
      notify = {
        sessionKey: key,
        channel: parsed.channel,
        target: parsed.target,
        token: notifyToken,
      };
    }
  }

  const { args, env } = buildSpawnArgs({ model, tools, effort, streaming: true, fullAccess, agentEnv, inheritUserScope, isSubagent, notify });

  const proc = spawn(resolveCliPath(), args, {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  const rl = createInterface({ input: proc.stdout! });

  const pp: PersistentProcess = {
    sessionKey: key,
    proc,
    readline: rl,
    model,
    resolvedModel: null,
    workspace,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    consecutiveTimeouts: 0,
    alive: true,
    pendingResolve: null,
    pendingReject: null,
    pendingFiles: [],
    needsContext: true,
    inactivityTimer: null,
    lifetimeTimer: null,
    notifyToken,
    isSubagent: !!isSubagent,
    totalInputTokens: 0,
    compactionCount: 0,
  };

  // Handle NDJSON lines from stdout
  rl.on("line", (line: string) => {
    try {
      const event = JSON.parse(line);

      // Log system/result events for debugging
      if (event.type === "result") {
        log.info({ type: event.type, resultLen: (event.result ?? "").length, resultPreview: (event.result ?? "").slice(0, 80) }, "Claude event: result");
      }

      // Capture the concrete model ID the CLI chose for alias resolution
      // (system.init emits it; assistant messages carry it on message.model too)
      if (!pp.resolvedModel) {
        const m = event.model ?? event.message?.model;
        if (typeof m === "string" && m.startsWith("claude-")) pp.resolvedModel = m;
      }

      // Track files created/written by Claude (tool_use events)
      if (event.type === "assistant" && Array.isArray(event.content)) {
        for (const block of event.content) {
          if (block.type === "tool_use" && (block.name === "Write" || block.name === "Edit") && block.input?.file_path) {
            pp.pendingFiles.push(block.input.file_path);
          }
        }
      }

      // Background task completion (Bash run_in_background, Task subagent run_in_background).
      // The CLI injects a synthetic user-message with a <task-notification> marker
      // when the task ends — see services/task-notification.ts for the format.
      // We auto-deliver to the origin channel so the user sees a second message
      // without having to "wake up" the agent with a fresh prompt.
      const tn = extractTaskNotificationFromEvent(event);
      if (tn) {
        handleTaskNotification(pp, tn);
      }

      if (event.type === "result" && pp.pendingResolve) {
        // Skip empty or system-noise results
        const resultText = event.result ?? "";
        if (!resultText || resultText === "waiting for message") {
          return;
        }
        pp.consecutiveTimeouts = 0;
        const resolve = pp.pendingResolve;
        const files = [...pp.pendingFiles];
        pp.pendingResolve = null;
        pp.pendingReject = null;
        pp.pendingFiles = [];
        // Extract token usage (sum cache + direct input tokens)
        const u = event.usage ?? {};
        const cacheCreation = u.cache_creation_input_tokens ?? 0;
        const cacheRead = u.cache_read_input_tokens ?? 0;
        const inputTokens = (u.input_tokens ?? 0) + cacheCreation + cacheRead;
        const outputTokens = u.output_tokens ?? 0;
        // `inputTokens` from the CLI is the full per-call conversation size
        // the API charged for — i.e. it grows turn by turn with the running
        // context. Use the MAX seen (not sum) as the authoritative cumulative
        // figure for compaction thresholding.
        if (inputTokens > pp.totalInputTokens) {
          pp.totalInputTokens = inputTokens;
        }
        resolve({
          text: event.result ?? "",
          durationMs: event.duration_ms,
          apiDurationMs: event.duration_api_ms,
          createdFiles: files.length > 0 ? files : undefined,
          inputTokens: inputTokens || undefined,
          outputTokens: outputTokens || undefined,
          cacheCreation: cacheCreation || undefined,
          cacheRead: cacheRead || undefined,
          costUsd: event.total_cost_usd,
        });
      }
      // system, rate_limit_event — ignore (streaming intermediate)
    } catch {
      // non-JSON line, ignore
    }
  });

  // Handle stderr for rate limit detection
  let stderrBuf = "";
  proc.stderr!.on("data", (d: Buffer) => {
    stderrBuf += d.toString();
    // Keep only last 2KB
    if (stderrBuf.length > 2048) stderrBuf = stderrBuf.slice(-2048);

    const chunk = d.toString();
    if ((chunk.includes("rate_limit") || chunk.includes("429") || /overloaded/i.test(chunk)) && pp.pendingReject) {
      // Short-circuit: give 10s grace period then reject (instead of waiting 30min timeout)
      const reject = pp.pendingReject;
      setTimeout(() => {
        if (pp.pendingReject === reject) {
          pp.pendingResolve = null;
          pp.pendingReject = null;
          reject(new Error("RATE_LIMIT"));
        }
        // If pendingReject changed, a result came in — don't reject
      }, 10_000);
    }
  });

  // Handle process exit
  proc.on("close", (code) => {
    pp.alive = false;
    log.info({ model, code }, "Persistent process exited");
    if (pp.pendingReject) {
      const reject = pp.pendingReject;
      pp.pendingResolve = null;
      pp.pendingReject = null;
      reject(new Error(`PROCESS_DIED_${code}`));
    }
    cleanupTimers(pp);
  });

  proc.on("error", (err) => {
    pp.alive = false;
    log.error({ err: err.message, model }, "Persistent process error");
    if (pp.pendingReject) {
      const reject = pp.pendingReject;
      pp.pendingResolve = null;
      pp.pendingReject = null;
      reject(err);
    }
    cleanupTimers(pp);
  });

  // Max lifetime timer
  pp.lifetimeTimer = setTimeout(() => {
    log.info({ model }, "Max lifetime reached, killing process");
    killProcess(pp);
  }, MAX_LIFETIME_MS);

  return pp;
}

function cleanupTimers(pp: PersistentProcess): void {
  if (pp.inactivityTimer) { clearTimeout(pp.inactivityTimer); pp.inactivityTimer = null; }
  if (pp.lifetimeTimer) { clearTimeout(pp.lifetimeTimer); pp.lifetimeTimer = null; }
}

function killProcess(pp: PersistentProcess): void {
  pp.alive = false;
  cleanupTimers(pp);
  if (pp.notifyToken) {
    revokeToken(pp.notifyToken);
    pp.notifyToken = null;
  }
  // Clear the notify session budget so the next spawn of this session starts fresh.
  resetNotifyBudget(pp.sessionKey);
  try { pp.readline.close(); } catch {}
  try { pp.proc.kill("SIGTERM"); } catch {}
  // Force kill after 3s
  setTimeout(() => { try { pp.proc.kill("SIGKILL"); } catch {} }, 3000);
}

function resetInactivityTimer(key: string, pp: PersistentProcess): void {
  if (pp.inactivityTimer) clearTimeout(pp.inactivityTimer);
  pp.inactivityTimer = setTimeout(() => {
    log.info({ key }, "Inactivity timeout, killing process");
    killProcess(pp);
    processes.delete(key);
  }, INACTIVITY_TIMEOUT_MS);
}

function getOrCreateProcess(
  key: string, model: string, workspace: string,
  tools: string[] = [], effort?: "low" | "medium" | "high" | "max",
  fullAccess?: boolean,
  agentEnv?: Record<string, string>,
  inheritUserScope?: boolean,
  isSubagent?: boolean,
): PersistentProcess {
  const existing = processes.get(key);
  if (existing && existing.alive) {
    return existing;
  }
  if (existing) {
    killProcess(existing);
    processes.delete(key);
  }
  const mcpCount = tools.filter(t => t.startsWith("mcp:")).length;
  log.info({ key, model, workspace, toolCount: tools.length, mcpCount, fullAccess: !!fullAccess, inheritUserScope: inheritUserScope !== false, isSubagent: !!isSubagent }, "Spawning new persistent process");
  const pp = spawnPersistentProcess(key, model, workspace, tools, effort, fullAccess, agentEnv, inheritUserScope, isSubagent);
  // Carry forward compaction counter if this session has been compacted before.
  // The pending summary is injected as a user turn in `doSendWithTimeout`,
  // not here — this function stays about process lifecycle only.
  const pending = pendingSummaries.get(key);
  if (pending) {
    pp.compactionCount = pending.compactionCount;
  }
  processes.set(key, pp);
  return pp;
}

function sendMessage(
  pp: PersistentProcess,
  message: string,
  images?: ImageBlock[],
): Promise<{ text: string; durationMs?: number; apiDurationMs?: number; createdFiles?: string[]; inputTokens?: number; outputTokens?: number; cacheCreation?: number; cacheRead?: number; costUsd?: number }> {
  return new Promise((resolve, reject) => {
    if (!pp.alive) {
      reject(new Error("PROCESS_DEAD"));
      return;
    }

    pp.pendingResolve = resolve;
    pp.pendingReject = reject;
    pp.lastActivity = Date.now();

    let content: any;
    if (images && images.length > 0) {
      content = [
        ...images.map(img => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: img.mimeType, data: img.base64 },
        })),
        { type: "text" as const, text: message },
      ];
    } else {
      content = message;
    }

    const input = JSON.stringify({
      type: "user",
      message: { role: "user", content },
    }) + "\n";

    pp.proc.stdin!.write(input);
  });
}

// --- Context-window compaction ---
//
// When cumulative input tokens cross 80% of the model's window (see
// `services/context.ts`), the CLI will start silently truncating responses.
// Fix: ask the current process for a structured summary, kill it, then
// inject that summary as the FIRST USER TURN of the respawned process so
// the conversation continues coherently with a fresh context budget.
//
// Implementation choice:
//  1. Try `/compact` first — it's Claude Code's native slash command and
//     handles the operation idiomatically when it works in stream-json mode.
//  2. Fall back to a custom summarise prompt if `/compact` returns empty /
//     fails. In practice the CLI today often passes `/compact` through as a
//     literal user message (no summary emitted), so the fallback is the
//     path that actually produces usable text. We still try `/compact`
//     first because if a future CLI version handles it natively, we
//     immediately get the better behaviour with zero code change.
//
// Why summary-as-user-turn and NOT --append-system-prompt:
//   CLAUDE.md forbids a third identity layer. The agent's language / scope /
//   branding live in `<workspace>/CLAUDE.md` — injecting a system-prompt
//   append would fight those rules (observed historically with subagent
//   prompts). A user turn is "just context" and leaves identity intact.
const COMPACT_FALLBACK_PROMPT = [
  "Summarize the conversation so far in a structured list:",
  "- Decisions made",
  "- Files/paths touched or referenced",
  "- Open TODOs",
  "- Current task focus",
  "Maximum 20 bullets. No commentary, no preamble. Plain text only.",
].join("\n");

async function compactSession(pp: PersistentProcess, key: string): Promise<void> {
  const tokensBefore = pp.totalInputTokens;
  const window = contextWindowFor(pp.model);
  log.info(
    { key, model: pp.model, tokensBefore, window, threshold: 0.80, compactionCount: pp.compactionCount },
    "Compacting session",
  );

  let summary = "";

  // Step 1: try the native /compact slash command. Wrap in timeout so a
  // non-responsive CLI doesn't block the turn indefinitely.
  try {
    const result = await Promise.race([
      sendMessage(pp, "/compact"),
      new Promise<{ text: string }>((_, reject) =>
        setTimeout(() => reject(new Error("COMPACT_TIMEOUT")), 90_000),
      ),
    ]);
    const text = (result.text ?? "").trim();
    // Heuristic: accept `/compact`'s reply only if it looks like a real
    // summary (has structure / length). Otherwise fall through to the
    // custom prompt.
    if (text.length > 40 && /[-•*]|summary|decision|file/i.test(text)) {
      summary = text;
      log.info({ key, summaryLen: summary.length }, "Native /compact produced summary");
    } else {
      log.info({ key, textLen: text.length }, "Native /compact did not produce usable summary — falling back");
    }
  } catch (err: any) {
    log.warn({ key, err: err?.message }, "Native /compact failed — falling back to custom prompt");
  }

  // Step 2: custom fallback prompt.
  if (!summary && pp.alive) {
    try {
      const result = await Promise.race([
        sendMessage(pp, COMPACT_FALLBACK_PROMPT),
        new Promise<{ text: string }>((_, reject) =>
          setTimeout(() => reject(new Error("COMPACT_TIMEOUT")), 120_000),
        ),
      ]);
      summary = (result.text ?? "").trim();
      log.info({ key, summaryLen: summary.length }, "Fallback compaction produced summary");
    } catch (err: any) {
      log.warn({ key, err: err?.message }, "Fallback compaction failed — session will respawn WITHOUT summary");
    }
  }

  // Step 3: kill the old process, stash summary for the next spawn.
  pp.compactionCount++;
  const nextCompactionCount = pp.compactionCount;
  if (summary) {
    pendingSummaries.set(key, { summary, compactionCount: nextCompactionCount });
  }
  killProcess(pp);
  processes.delete(key);

  // Step 4: broadcast dashboard event so the UI can show the compaction badge.
  if (clientCount() > 0) {
    broadcast({
      type: "session.compacted",
      data: {
        ts: Date.now(),
        key,
        tokensBefore,
        threshold: 0.80,
        compactionCount: nextCompactionCount,
        summaryPreview: summary ? summary.slice(0, 300) : undefined,
      },
    });
  }
}

function hardResetSession(pp: PersistentProcess, key: string, tokensBefore: number, compactionCount: number): void {
  log.warn(
    { key, compactionCount, tokensBefore },
    "Max compactions reached — hard reset without carrying summary",
  );
  pendingSummaries.delete(key); // belt-and-suspenders: don't carry anything over
  killProcess(pp);
  processes.delete(key);
  if (clientCount() > 0) {
    broadcast({
      type: "session.compacted",
      data: {
        ts: Date.now(),
        key,
        tokensBefore,
        threshold: 0.80,
        compactionCount,
        hardReset: true,
      },
    });
  }
}

// --- Serial queue ---
const queues = new Map<string, Promise<void>>();

// --- Cleanup on shutdown ---
// NOTE: SIGINT/SIGTERM are handled by index.ts's graceful shutdown, which
// waits for in-flight askClaude() calls to complete before invoking this.
// We only keep `exit` as a last-resort safety net.
export function killAllProcesses(): void {
  for (const [key, pp] of processes) {
    log.info({ key }, "Shutdown: killing persistent process");
    killProcess(pp);
  }
  processes.clear();
}

process.on("exit", killAllProcesses);

// --- Public API ---

export function sessionKey(channel: string, from: string, group?: string): string {
  return group ? `${channel}:${group}` : `${channel}:${from}`;
}

export interface ClaudeResponse {
  text: string;
  model: string;
  durationMs?: number;
  apiDurationMs?: number;
  /** Files created/written by Claude during this turn */
  createdFiles?: string[];
  inputTokens?: number;
  outputTokens?: number;
  cacheCreation?: number;
  cacheRead?: number;
  costUsd?: number;
}

export interface ImageBlock {
  base64: string;
  mimeType: string;
}

export async function askClaude(
  agent: AgentConfig,
  message: string,
  key: string,
  images?: ImageBlock[],
  opts?: { isSubagent?: boolean },
): Promise<ClaudeResponse> {
  const prev = queues.get(key) ?? Promise.resolve();
  let resolveQueue: () => void;
  const myTurn = new Promise<void>((r) => { resolveQueue = r; });
  queues.set(key, prev.then(() => myTurn));
  await prev;

  try {
    return await askClaudeInternal(agent, message, key, images, opts);
  } finally {
    resolveQueue!();
  }
}

async function askClaudeInternal(
  agent: AgentConfig,
  message: string,
  key: string,
  images?: ImageBlock[],
  opts?: { isSubagent?: boolean },
): Promise<ClaudeResponse> {
  const models = [agent.model, ...(agent.fallbacks ?? [])].filter(Boolean) as string[];
  if (models.length === 0) models.push("opus");

  const startTime = Date.now();
  const envContext = loadEnvContext(agent.env);
  const fullMessage = envContext ? `${envContext}\n\n${message}` : message;

  for (let i = 0; i < models.length; i++) {
    const model = resolveModel(models[i]);
    try {
      const tools = agent.tools ?? [];
      let pp = getOrCreateProcess(key, model, agent.workspace, tools, agent.effort, agent.fullAccess, agent.env, agent.inheritUserScope, opts?.isSubagent);

      // If model changed (fallback), need new process
      if (pp.model !== model) {
        killProcess(pp);
        processes.delete(key);
        pp = getOrCreateProcess(key, model, agent.workspace, tools, agent.effort, agent.fullAccess, agent.env, agent.inheritUserScope, opts?.isSubagent);
      }

      // Context-window guard (turn boundary): if the session is over the
      // compaction threshold, summarise + respawn BEFORE sending the new
      // user turn. Only fires when the process is alive and has real
      // token history (fresh spawns are always safe).
      if (pp.alive && pp.totalInputTokens > 0 && shouldCompact(pp.totalInputTokens, pp.model)) {
        const tokensBefore = pp.totalInputTokens;
        if (pp.compactionCount >= 5) {
          hardResetSession(pp, key, tokensBefore, pp.compactionCount);
        } else {
          await compactSession(pp, key);
        }
        // Respawn for the actual user turn. getOrCreateProcess will pick up
        // the pending summary's compactionCount for budget tracking.
        pp = getOrCreateProcess(key, model, agent.workspace, tools, agent.effort, agent.fullAccess, agent.env, agent.inheritUserScope, opts?.isSubagent);
      }

      return await doSendWithTimeout(pp, key, fullMessage, model, message.length, startTime, images);
    } catch (err: any) {
      const errMsg = err?.message ?? "";

      if (errMsg === "TIMEOUT") {
        log.warn({ key, model }, "Message timed out after 30 min — killing stale process");
        const pp = processes.get(key);
        if (pp) { killProcess(pp); processes.delete(key); }
        throw new Error("Claude took too long (30 min). Process killed — please retry.");
      }

      if (errMsg === "RATE_LIMIT" || errMsg.includes("rate_limit") || errMsg.includes("429")) {
        // Kill process and try next model
        const pp = processes.get(key);
        if (pp) { killProcess(pp); processes.delete(key); }

        if (i < models.length - 1) {
          log.warn({ key, model, nextModel: models[i + 1] }, "Rate limited, falling back");
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
      }

      // Process died — if not last model, try next
      if (errMsg.startsWith("PROCESS_D") && i < models.length - 1) {
        processes.delete(key);
        log.warn({ key, model, nextModel: models[i + 1] }, "Process died, trying next model");
        continue;
      }

      log.error({ err: errMsg.slice(0, 200), key, model }, "Message failed");
      if (i < models.length - 1) {
        processes.delete(key);
        continue;
      }

      throw new Error("Sorry, all models are currently unavailable. Please try again later.");
    }
  }

  throw new Error("Sorry, all models are currently unavailable. Please try again later.");
}

async function doSendWithTimeout(
  pp: PersistentProcess,
  key: string,
  inputMessage: string,
  modelName: string,
  charsIn: number,
  startTime: number,
  images?: ImageBlock[],
): Promise<ClaudeResponse> {
  let message = inputMessage;
  log.info({ key, model: pp.model, alive: pp.alive, hasImages: !!images?.length }, "Sending message to persistent process");

  // Inject session context on first message of a new process
  if (pp.needsContext) {
    pp.needsContext = false;
    const context = buildContextFromCache(key);
    if (context) {
      message = context + "\n" + message;
      log.info({ key, contextLen: context.length }, "Injected session context from cache");
    }
  }

  // Inject compaction summary as the FIRST USER TURN of the respawned
  // process (never via --append-system-prompt — that would fight agent
  // identity rules in CLAUDE.md). Cleared after injection so subsequent
  // turns don't re-prepend it.
  const pending = pendingSummaries.get(key);
  if (pending) {
    pendingSummaries.delete(key);
    pp.lastSummary = pending.summary;
    message = `[CONTEXT RESTORED — previous session summary]\n${pending.summary}\n[NEW TURN]\n${message}`;
    log.info({ key, summaryLen: pending.summary.length, compactionCount: pending.compactionCount }, "Injected compaction summary as first user turn");
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      pp.consecutiveTimeouts++;
      // Don't kill — just reject
      if (pp.pendingReject) {
        pp.pendingResolve = null;
        pp.pendingReject = null;
      }
      reject(new Error("TIMEOUT"));
    }, MESSAGE_TIMEOUT_MS);
  });

  const result = await Promise.race([
    sendMessage(pp, message, images),
    timeoutPromise,
  ]);

  resetInactivityTimer(key, pp);
  trackUsage(key, charsIn, result.text.length, Date.now() - startTime, {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheCreation: result.cacheCreation,
    cacheRead: result.cacheRead,
    costUsd: result.costUsd,
    apiDurationMs: result.apiDurationMs,
  });
  log.info({ key, model: pp.model, responseLen: result.text.length, durationMs: result.durationMs }, "Claude responded");

  return {
    text: result.text,
    model: pp.resolvedModel ?? modelName,
    durationMs: result.durationMs,
    apiDurationMs: result.apiDurationMs,
    createdFiles: result.createdFiles,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheCreation: result.cacheCreation,
    cacheRead: result.cacheRead,
    costUsd: result.costUsd,
  };
}

export interface FreshClaudeResult {
  result: string;
  model: string;
  sessionId?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  costUsd?: number;
  exitCode: number | null;
  status: "ok" | "error" | "timeout";
  error?: string;
}

export async function askClaudeFresh(
  workspace: string,
  prompt: string,
  model?: string,
  timeoutMs: number = MESSAGE_TIMEOUT_MS,
  opts?: { fullAccess?: boolean; tools?: string[]; agentEnv?: Record<string, string>; inheritUserScope?: boolean; isSubagent?: boolean },
): Promise<FreshClaudeResult> {
  const resolvedModel = resolveModel(model);
  log.info({ workspace, model: resolvedModel, fullAccess: !!opts?.fullAccess, isSubagent: !!opts?.isSubagent }, "Fresh Claude call (cron)");

  const { args, env } = buildSpawnArgs({
    model: resolvedModel,
    tools: opts?.tools ?? [],
    streaming: false,
    fullAccess: opts?.fullAccess,
    agentEnv: opts?.agentEnv,
    inheritUserScope: opts?.inheritUserScope,
    isSubagent: opts?.isSubagent,
  });

  return new Promise((resolve) => {
    const proc = spawn(resolveCliPath(), args, {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ result: "Error: timeout", model: resolvedModel, exitCode: code, status: "timeout", error: "TIMEOUT" });
        return;
      }
      if (code !== 0) {
        log.error({ code, stderr: stderr.slice(0, 200), workspace }, "Cron Claude call failed");
        resolve({
          result: `Error: CLI exited with code ${code}`,
          model: resolvedModel,
          exitCode: code,
          status: "error",
          error: stderr.slice(0, 500) || `exit ${code}`,
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve({
          result: parsed.result ?? stdout.trim(),
          model: parsed.model || resolvedModel,
          sessionId: parsed.session_id,
          usage: parsed.usage,
          costUsd: parsed.total_cost_usd,
          exitCode: code,
          status: "ok",
        });
      } catch {
        resolve({ result: stdout.trim(), model: resolvedModel, exitCode: code, status: "ok" });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      log.error({ err: err.message, workspace }, "Cron Claude call error");
      resolve({ result: `Error: ${err.message}`, model: resolvedModel, exitCode: null, status: "error", error: err.message });
    });

    proc.stdin!.write(prompt);
    proc.stdin!.end();
  });
}

export function clearHistory(key: string): void {
  const pp = processes.get(key);
  if (pp) {
    killProcess(pp);
    processes.delete(key);
  }
}

export function getSessionStats(): { total: number; keys: string[] } {
  return { total: processes.size, keys: [...processes.keys()] };
}

export function getUsageStats(): Map<string, SessionStat> {
  return sessionStats;
}

export interface ProcessInfo {
  key: string;
  model: string;
  workspace: string;
  alive: boolean;
  pid: number | null;
  pending: boolean;
  needsContext: boolean;
  createdAt: number;
  lastMessageAt: number;
  inactivityExpiresAt: number;
  lifetimeExpiresAt: number;
  messageCount: number;
  consecutiveTimeouts: number;
  pendingFilesCount: number;
  charsIn: number;
  charsOut: number;
  totalTimeMs: number;
  avgResponseMs: number;
  lastDurationMs: number;
  lastApiDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  costUsd: number;
  /** Authoritative running input-token count for context-window thresholding. */
  totalInputTokens: number;
  /** Times this session has been compacted (hard cap: 5). */
  compactionCount: number;
  /** True when `totalInputTokens >= 80%` of the model's context window. */
  nearContextLimit: boolean;
  /** Preview of the last compaction summary, if any (first 300 chars). */
  lastSummaryPreview?: string;
}

export function getProcesses(): ProcessInfo[] {
  const result: ProcessInfo[] = [];
  for (const [key, pp] of processes) {
    const stats = sessionStats.get(key) ?? emptyStat();
    result.push({
      key,
      model: pp.model,
      workspace: pp.workspace,
      alive: pp.alive,
      pid: pp.proc.pid ?? null,
      pending: pp.pendingResolve !== null,
      needsContext: pp.needsContext,
      createdAt: pp.createdAt,
      lastMessageAt: pp.lastActivity,
      inactivityExpiresAt: pp.lastActivity + INACTIVITY_TIMEOUT_MS,
      lifetimeExpiresAt: pp.createdAt + MAX_LIFETIME_MS,
      messageCount: stats.messages,
      consecutiveTimeouts: pp.consecutiveTimeouts,
      pendingFilesCount: pp.pendingFiles.length,
      charsIn: stats.charsIn,
      charsOut: stats.charsOut,
      totalTimeMs: stats.totalTimeMs,
      avgResponseMs: stats.messages > 0 ? Math.round(stats.totalTimeMs / stats.messages) : 0,
      lastDurationMs: stats.lastDurationMs,
      lastApiDurationMs: stats.lastApiDurationMs,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      cacheCreation: stats.cacheCreation,
      cacheRead: stats.cacheRead,
      costUsd: stats.costUsd,
      totalInputTokens: pp.totalInputTokens,
      compactionCount: pp.compactionCount,
      nearContextLimit: shouldCompact(pp.totalInputTokens, pp.model),
      lastSummaryPreview: pp.lastSummary ? pp.lastSummary.slice(0, 300) : undefined,
    });
  }
  return result;
}

export function killProcessByKey(key: string): boolean {
  const pp = processes.get(key);
  if (!pp) return false;
  killProcess(pp);
  processes.delete(key);
  return true;
}
