/**
 * Claude integration — built on @anthropic-ai/claude-agent-sdk.
 *
 * Pattern (b): one long-running query() per session. The user-message stream
 * is a pushable AsyncIterable we control; turns are consumed inline from the
 * AsyncIterable<SDKMessage> the SDK returns.
 *
 * Auth: inherits from the local `claude` CLI's OAuth token (Pro/Max
 * subscription) or CLAUDE_CODE_OAUTH_TOKEN. No API key required.
 *
 * History: the legacy CLI-spawn implementation lived here as
 * `claude-cli.ts` until 2026-04 — see CHANGELOG and
 * `.planning/audit/sdk-migration.md`.
 */
import { join } from "path";
import { readFileSync, writeFileSync, statSync, watch as fsWatch } from "fs";
import { homedir } from "os";
import {
  query,
  type Options as SdkOptions,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type McpServerConfig as SdkMcpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../types";
import { logger } from "./logger";
import { buildContextFromCache } from "./session-cache";
import { readMcpServers } from "./config-loader";
import { getSkipSet as getMcpSkipSet, refreshMcpStatus } from "./mcp-status";
import { buildMessagingMcps } from "../mcp";
import { MEDIA_DIR } from "./media";
import { issueToken, revokeToken } from "./notify-tokens";
import { resetNotifyBudget, hasNotifyBudget, consumeNotifyBudget } from "./rate-limiter";
import { shouldCompact } from "./context";
import { broadcast, clientCount } from "../dashboard/ws";
import {
  extractTaskNotificationFromEvent,
  formatTaskNotificationMessage,
  formatChildNotificationFooter,
  type TaskNotificationEnvelope,
  type ChildFooterContext,
} from "./task-notification";
import { getDeliveryFn } from "./cron";
import { formatForChannel } from "./formatting";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import {
  recordTaskProgress,
  recordTurnResult,
  clearTaskProgress,
  writeSessionSidecar,
  removeSessionSidecar,
} from "./contextInspector/index.js";

const execFile = promisify(execFileCb);

const log = logger.child({ module: "claude" });

// --- Public types ---

export interface ClaudeResponse {
  text: string;
  model: string;
  durationMs?: number;
  apiDurationMs?: number;
  /** Files created/written by Claude during this turn. */
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

export interface FreshClaudeResult {
  result: string;
  model: string;
  sessionId?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  costUsd?: number;
  exitCode: number | null;
  status: "ok" | "error" | "timeout";
  error?: string;
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
  totalInputTokens: number;
  compactionCount: number;
  nearContextLimit: boolean;
  lastSummaryPreview?: string;
}

const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
// First-event timeout: if the SDK subprocess doesn't emit ANY event within
// this window after the first sendMessage, assume MCP init or model spin-up
// is wedged and kill the session so the caller can retry on a fresh spawn.
// Without this guard a stuck spawn ate the full MESSAGE_TIMEOUT_MS (30 min)
// of silence before the user got an error.
const FIRST_EVENT_TIMEOUT_MS = 90 * 1000;
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
const MESSAGE_TIMEOUT_MS = 30 * 60 * 1000;

const SUBAGENT_SYSTEM_PROMPT =
  "You are a subagent. Respond ONLY to the specific task. No preambles, no personal memory, no brand. Terse, bullet-form when natural, no decorative markdown unless asked.";

// --- Env sanitization ---
// Only forward safe env vars to spawned Claude processes.
// Blocks secrets that could leak via prompt injection.
const ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "NODE_ENV", "TZ", "USER", "SHELL", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "ANTHROPIC_API_KEY",
]);
const ENV_BLOCKLIST_PATTERNS = [/API_KEY/i, /TOKEN/i, /SECRET/i, /PASSWORD/i, /PRIVATE_KEY/i, /CREDENTIAL/i, /AUTH/i];
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
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  for (const key of Object.keys(env)) {
    if (ENV_BLOCKLIST_EXCEPTIONS.has(key)) continue;
    if (ENV_BLOCKLIST_PATTERNS.some(p => p.test(key))) delete env[key];
  }
  if (agentEnv) Object.assign(env, agentEnv);
  env.JARVIS_SPAWN = "1";
  env.ENABLE_TOOL_SEARCH = "true"; // defer stdio MCP tool definitions — reduces baseline context
  if (opts?.isSubagent) env.JARVIS_IS_SUBAGENT = "1";
  if (opts?.notify && !opts.isSubagent) {
    env.JARVIS_SESSION_KEY = opts.notify.sessionKey;
    env.JARVIS_CHANNEL = opts.notify.channel;
    env.JARVIS_REPLY_TARGET = opts.notify.target;
    env.JARVIS_NOTIFY_URL = "http://127.0.0.1:3340/api/notify";
    env.JARVIS_NOTIFY_TOKEN = opts.notify.token;
  }
  return env;
}

function resolveModel(name: string | undefined): string {
  return name && name.trim() ? name : "opus";
}

function loadEnvContext(env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return "";
  const envBlock = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
  return `Environment context:\n${envBlock}`;
}

// --- Persisted usage stats (independent of cli adapter to avoid double-write) ---
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
  } catch { /* first run */ }
}

function persistSessionStats(): void {
  try {
    const obj: Record<string, SessionStat> = {};
    for (const [k, v] of sessionStats) obj[k] = v;
    writeFileSync(SESSION_STATS_FILE, JSON.stringify(obj), "utf-8");
  } catch (err) { log.warn({ err }, "Failed to persist session stats"); }
}

loadPersistedSessionStats();
const persistTimer = setInterval(persistSessionStats, 30_000);
persistTimer.unref();
process.on("beforeExit", persistSessionStats);

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

// --- Pushable async iterable (validated in spike) ---
interface PushQueue<T> {
  iterable: AsyncIterable<T>;
  push: (v: T) => void;
  end: () => void;
}

function makePushable<T>(): PushQueue<T> {
  const queue: T[] = [];
  let resolveNext: ((r: IteratorResult<T>) => void) | null = null;
  let done = false;
  return {
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<T>>((resolve) => {
          if (queue.length) resolve({ value: queue.shift()!, done: false });
          else if (done) resolve({ value: undefined as any, done: true });
          else resolveNext = resolve;
        }),
      }),
    },
    push: (v) => {
      if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: v, done: false }); }
      else queue.push(v);
    },
    end: () => {
      done = true;
      if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined as any, done: true }); }
    },
  };
}

// --- Per-session state ---
interface TurnResult {
  text: string;
  durationMs?: number;
  apiDurationMs?: number;
  createdFiles?: string[];
  inputTokens?: number;
  outputTokens?: number;
  cacheCreation?: number;
  cacheRead?: number;
  costUsd?: number;
}

interface SdkSession {
  sessionKey: string;
  workspace: string;
  model: string;
  resolvedModel: string | null;
  createdAt: number;
  lastActivity: number;
  consecutiveTimeouts: number;
  alive: boolean;
  q: Query;
  pushable: PushQueue<SDKUserMessage>;
  consumer: Promise<void>;
  pendingResolve: ((r: TurnResult) => void) | null;
  pendingReject: ((e: Error) => void) | null;
  /**
   * Optional per-turn callback fired for every assistant text DELTA as it
   * arrives from the SDK. Used by streaming-TTS callers (notch connector
   * with `JARVIS_TTS_LLM_STREAM=1`) to feed the Cartesia WS pipeline before
   * the full reply is ready. Cleared when the turn resolves/rejects so it
   * never leaks across turns. NOT invoked for tool_use, only `block.text`.
   */
  pendingOnChunk?: ((delta: string) => void) | null;
  /** Files created by Write/Edit during the current turn. */
  pendingFiles: string[];
  /** Text accumulated from assistant text blocks during the current turn. */
  currentText: string;
  needsContext: boolean;
  inactivityTimer: NodeJS.Timeout | null;
  lifetimeTimer: NodeJS.Timeout | null;
  notifyToken: string | null;
  isSubagent: boolean;
  /** Captured at spawn time so we can detect agent-config drift on reuse. */
  fullAccess: boolean;
  inheritUserScope: boolean;
  totalInputTokens: number;
  compactionCount: number;
  /** True after the SDK subprocess emits its first event (system init,
   *  assistant chunk, etc.). Used to detect wedged spawns. */
  firstEventReceived: boolean;
  /** Active first-event watchdog timer; cleared on first event or kill. */
  firstEventTimer: NodeJS.Timeout | null;
  lastSummary?: string;
  notifiedTaskIds?: Set<string>;
  bgToolUseStarts?: Map<string, { startedAt: number; kind: string }>;
  pid: number | null;
}

const sessions = new Map<string, SdkSession>();
const pendingSummaries = new Map<string, { summary: string; compactionCount: number }>();

// --- MCP OAuth token hot-reload ---
// `~/Library/Application Support/Claude/fcache` is the encrypted OAuth/MCP
// token cache the bundled `claude` binary writes after `/mcp` auth completes.
// When it changes, live SDK sessions still hold stale MCP connections (started
// before auth → unauthorized / failed). The SDK exposes
// `reconnectMcpServer(name)` on the Query control channel — reconnects the MCP
// without killing the subprocess, so the prompt cache and conversation
// history are preserved.
//
// Implementation notes:
//  - Watch the *parent directory*, not the file itself. fcache is rewritten
//    via tmp+rename (atomic replace), and `fs.watch` on a path holds the
//    inode — after the first replace the file-level watch goes silent.
//  - Only reconnect servers whose status is `failed` or `needs-auth`. Healthy
//    `connected` servers don't benefit from a reconnect and would needlessly
//    drop their tool-side state.
//  - Skip sessions that are mid-turn (pendingResolve != null). Reconnecting
//    underneath an in-flight MCP tool call risks transport errors. The next
//    sweep (or the user's next conversation) will pick them up.
//  - Single in-flight sweep guard with rerun bit, so rapid-fire fcache
//    changes coalesce into at most one trailing sweep.
const FCACHE_DIR = join(homedir(), "Library", "Application Support", "Claude");
const FCACHE_NAME = "fcache";
let fcacheReloadTimer: NodeJS.Timeout | null = null;
let fcacheSweeping = false;
let fcacheRerun = false;

async function reconnectStaleMcpForLiveSessions(): Promise<void> {
  if (fcacheSweeping) { fcacheRerun = true; return; }
  fcacheSweeping = true;
  try {
    do {
      fcacheRerun = false;
      const live = [...sessions.values()].filter((s) => s.alive && s.pendingResolve === null);
      // Dedupe by MCP server name across this sweep — each session holds its own
      // mcp-remote stdio connection, so a needs-auth state on one means it's
      // probably needs-auth on all of them. Reconnecting per-session triggers
      // one OAuth browser popup PER session — bad UX. Pick one session per
      // server name and reconnect there; the others will pick up the refreshed
      // token through fcache on their next status check (or on next user turn).
      const seenServers = new Set<string>();
      for (const s of live) {
        if (!s.alive) continue;
        let stale: string[] = [];
        try {
          const status = await s.q.mcpServerStatus();
          // Only auto-reconnect `failed` (transient, recoverable). `needs-auth`
          // requires the user to actually log in via /mcp — auto-reconnecting
          // it just spawns OAuth popups the user didn't ask for.
          stale = status.filter((m) => m.status === "failed").map((m) => m.name);
        } catch (e) {
          log.debug({ sessionKey: s.sessionKey, err: String(e) }, "mcpServerStatus failed; skipping reconnect for session");
          continue;
        }
        for (const name of stale) {
          if (seenServers.has(name)) continue;
          seenServers.add(name);
          try {
            await s.q.reconnectMcpServer(name);
            log.info({ sessionKey: s.sessionKey, mcp: name }, "MCP reconnected after fcache change");
          } catch (e) {
            log.warn({ sessionKey: s.sessionKey, mcp: name, err: String(e) }, "MCP reconnect failed");
          }
        }
      }
    } while (fcacheRerun);
  } finally {
    fcacheSweeping = false;
  }
}

function startFcacheWatcher(): void {
  if (process.platform !== "darwin") {
    log.debug({ platform: process.platform }, "MCP token watcher only supports darwin (fcache path); skipping");
    return;
  }
  try {
    statSync(FCACHE_DIR);
  } catch {
    log.debug({ path: FCACHE_DIR }, "fcache directory not present; MCP token watcher disabled");
    return;
  }
  try {
    fsWatch(FCACHE_DIR, { persistent: false }, (_event, filename) => {
      if (filename !== FCACHE_NAME) return;
      if (fcacheReloadTimer) clearTimeout(fcacheReloadTimer);
      // Debounce — auth flow emits multiple events (rename + close + chmod).
      fcacheReloadTimer = setTimeout(() => {
        fcacheReloadTimer = null;
        reconnectStaleMcpForLiveSessions().catch((e) =>
          log.warn({ err: String(e) }, "fcache-driven MCP reconnect sweep failed"),
        );
      }, 800);
    });
    log.info({ dir: FCACHE_DIR, file: FCACHE_NAME }, "Watching fcache for MCP OAuth token changes");
  } catch (e) {
    log.warn({ err: String(e) }, "Failed to start fcache watcher");
  }
}

startFcacheWatcher();

// ─── Context Inspector — sidecar lifecycle ───────────────────────────────────
// Per-PID JSON files at ~/.claude/jarvis/active-sessions/<pid>.json link a
// spawned Claude SDK process to its router sessionKey. discovery.ts reads
// these to enrich LocalSession with sessionKey/agent/fullAccess fields.
//
// Why sidecar (not env-var-via-ps): cleaner filesystem read, no shell parsing
// fragility, survives executable-name variation across SDK process variants.
// MAJOR 5 fix from the plan-checker revision.

/** sessionKey -> Set of child PIDs we've registered sidecar files for. */
const sidecarPidsBySession = new Map<string, Set<number>>();

/**
 * Find direct child PIDs of the router process that look like Claude CLI
 * processes. Mirrors the heuristic in localSessions/discovery.ts.
 */
async function findChildClaudePids(): Promise<number[]> {
  try {
    const { stdout } = await execFile("ps", ["-axo", "pid=,ppid=,args="], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const myPid = process.pid;
    const pids: number[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      const ppid = parseInt(m[2], 10);
      const args = m[3];
      if (ppid !== myPid) continue;
      // Skip Electron / Claude.app GUI processes
      if (/Claude\.app\//.test(args) || /Electron/.test(args)) continue;
      // Match Claude CLI signatures (same pattern as discovery.ts isClaudeCliProcess)
      if (
        /(^|\/)claude($|\s)/.test(args) ||
        /@anthropic-ai\/claude-code\//.test(args) ||
        /\/claude-code\/.*cli\.(m?js|cjs)/.test(args)
      ) {
        pids.push(pid);
      }
    }
    return pids;
  } catch {
    return [];
  }
}

/**
 * Register sidecar files for all Claude child processes belonging to this
 * session. Idempotent — re-registering a known PID is a no-op.
 * Called on the FIRST task_progress event (proves SDK process is alive +
 * discoverable via `ps`).
 */
async function registerSessionSidecars(s: SdkSession): Promise<void> {
  const pids = await findChildClaudePids();
  if (pids.length === 0) return;
  let known = sidecarPidsBySession.get(s.sessionKey);
  if (!known) {
    known = new Set();
    sidecarPidsBySession.set(s.sessionKey, known);
  }
  const parsed = parseSessionKey(s.sessionKey);
  const agentName = parsed?.agent ?? "unknown";
  for (const pid of pids) {
    if (known.has(pid)) continue;
    known.add(pid);
    await writeSessionSidecar({
      pid,
      sessionKey: s.sessionKey,
      agent: agentName,
      workspace: s.workspace,
      model: s.model,
      resolvedModel: s.resolvedModel,
      fullAccess: s.fullAccess,
      inheritUserScope: s.inheritUserScope,
      spawnedAt: Date.now(),
    });
  }
}

/** Remove all sidecar files for a session — called from killSession. */
async function unregisterSessionSidecars(sessionKey: string): Promise<void> {
  const known = sidecarPidsBySession.get(sessionKey);
  if (!known) return;
  for (const pid of known) {
    await removeSessionSidecar(pid);
  }
  sidecarPidsBySession.delete(sessionKey);
}

// --- Build SDK Options from agent config ---
function buildSdkOptions(opts: {
  model: string;
  tools: string[];
  workspace: string;
  effort?: "low" | "medium" | "high" | "max";
  fullAccess?: boolean;
  agentEnv?: Record<string, string>;
  inheritUserScope?: boolean;
  isSubagent?: boolean;
  notify?: NotifyEnvContext;
  /** Full agent config (passed through for in-process messaging MCPs). */
  agent?: AgentConfig;
  /** Session key (passed through for in-process messaging MCPs). */
  sessionKey?: string;
}): SdkOptions {
  const isReadonly = !opts.fullAccess && opts.tools.includes("fileAccess:readonly") && !opts.tools.includes("fileAccess:full");
  const permissionMode: "acceptEdits" | "bypassPermissions" = isReadonly ? "acceptEdits" : "bypassPermissions";
  const settingSources: Array<"user" | "project" | "local"> = opts.inheritUserScope === false
    ? ["project", "local"]
    : ["user", "project", "local"];

  // MCP servers: same logic as CLI buildSpawnArgs.
  // We additionally drop servers that `claude mcp list` reports as needs-auth
  // or failed — attaching them anyway just spawns mcp-remote children that
  // pop OAuth dialogs the user never asked for. The user can re-attach via
  // dashboard "Authenticate" (which calls refreshMcpStatus() afterwards).
  const skip = getMcpSkipSet();
  const filterAttachable = (input: Record<string, unknown>): Record<string, SdkMcpServerConfig> => {
    const out: Record<string, SdkMcpServerConfig> = {};
    for (const [name, cfg] of Object.entries(input)) {
      if (skip.has(name)) continue;
      out[name] = cfg as SdkMcpServerConfig;
    }
    return out;
  };

  let mcpServers: Record<string, SdkMcpServerConfig> | undefined;
  if (opts.fullAccess) {
    const all = readMcpServers();
    const usable = filterAttachable(all);
    if (Object.keys(usable).length > 0) mcpServers = usable;
    if (skip.size > 0) {
      const skipped = Object.keys(all).filter(n => skip.has(n));
      if (skipped.length > 0) log.debug({ skipped }, "Skipping unhealthy MCPs at session spawn");
    }
  } else {
    const mcpToolNames = opts.tools.filter(t => t.startsWith("mcp:")).map(t => t.slice(4));
    if (mcpToolNames.length > 0) {
      const all = readMcpServers();
      const filtered: Record<string, unknown> = {};
      for (const name of mcpToolNames) {
        if (all[name]) filtered[name] = all[name];
      }
      const usable = filterAttachable(filtered);
      if (Object.keys(usable).length > 0) mcpServers = usable;
    }
  }

  // In-process messaging MCPs (Discord/WhatsApp/Telegram/Channels). Built only
  // when the agent has the corresponding tool. Subagents inherit nothing here —
  // they're a separate spawn with their own toolset.
  if (opts.agent && opts.sessionKey && !opts.isSubagent) {
    const messagingMcps = buildMessagingMcps({ agent: opts.agent, sessionKey: opts.sessionKey });
    if (Object.keys(messagingMcps).length > 0) {
      mcpServers = { ...(mcpServers ?? {}), ...messagingMcps };
    }
  }

  const disallowedTools = isReadonly
    ? ["Write", "Edit", "NotebookEdit", "Bash(rm:*)", "Bash(mv:*)"]
    : undefined;

  // Subagent: prepend our subagent system prompt via the preset's append.
  const systemPrompt: SdkOptions["systemPrompt"] = {
    type: "preset",
    preset: "claude_code",
    excludeDynamicSections: true,
    ...(opts.isSubagent ? { append: SUBAGENT_SYSTEM_PROMPT } : {}),
  };

  // Grant Read access to the shared media drop for agents that handle user
  // attachments. Connectors save images/voice/docs to MEDIA_DIR and append the
  // absolute paths to the prompt; without this, the Read tool refuses paths
  // outside cwd and the agent ends up apologising for missing access.
  const hasMediaTool = opts.fullAccess
    || opts.tools.includes("vision")
    || opts.tools.includes("voice")
    || opts.tools.includes("documents");
  const additionalDirectories = hasMediaTool ? [MEDIA_DIR] : undefined;

  const sdkOpts: SdkOptions = {
    cwd: opts.workspace,
    permissionMode,
    allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
    model: opts.model,
    settingSources,
    systemPrompt,
    strictMcpConfig: true,
    // Enable token-level delta streaming. Without this, the SDK delivers
    // each turn's reply as one or two `assistant` events with the whole
    // text already concatenated → notch chat fills "tutto in un pezzo".
    // With it, we receive `stream_event` messages carrying
    // `content_block_delta` (BetaTextDelta) chunks and can pipe them to
    // the notch SSE display + Cartesia WS streaming session token-by-token.
    includePartialMessages: true,
    env: buildSafeEnv(opts.agentEnv, { isSubagent: opts.isSubagent, notify: opts.notify }),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(disallowedTools ? { disallowedTools } : {}),
    ...(additionalDirectories ? { additionalDirectories } : {}),
  };
  return sdkOpts;
}

// --- Session key parser (mirror of cli adapter) ---
function parseSessionKey(key: string): { channel: string; target: string; agent?: string } | null {
  const parts = key.split(":");
  if (parts.length < 2) return null;
  const channel = parts[0];
  if (!channel) return null;
  if (parts.length === 2) {
    return parts[1] ? { channel, target: parts[1] } : null;
  }
  // 3+ parts: agent is the trailing segment, target is everything between.
  const agent = parts[parts.length - 1];
  const target = parts.slice(1, -1).join(":");
  if (!target || !agent) return null;
  return { channel, target, agent };
}

// --- Task-notification handler (same body as CLI adapter) ---
function handleTaskNotification(s: SdkSession, env: TaskNotificationEnvelope): void {
  if (!s.alive) return;
  if (s.isSubagent) return;
  if (!env.taskId) return;

  const startInfo = env.toolUseId && s.bgToolUseStarts ? s.bgToolUseStarts.get(env.toolUseId) : undefined;
  if (!startInfo) {
    log.debug({ sessionKey: s.sessionKey, taskId: env.taskId, toolUseId: env.toolUseId }, "Task notification ignored — not a tracked background task");
    return;
  }

  if (!s.notifiedTaskIds) s.notifiedTaskIds = new Set();
  if (s.notifiedTaskIds.has(env.taskId)) return;
  s.notifiedTaskIds.add(env.taskId);
  s.bgToolUseStarts?.delete(env.toolUseId!);

  const parsed = parseSessionKey(s.sessionKey);
  if (!parsed) return;

  const deliver = getDeliveryFn();
  if (!deliver) {
    log.warn({ sessionKey: s.sessionKey, taskId: env.taskId }, "Task notification ready but no delivery fn");
    return;
  }

  if (!hasNotifyBudget(s.sessionKey, 100)) {
    log.warn({ sessionKey: s.sessionKey, taskId: env.taskId }, "Task notification dropped — session budget exhausted");
    return;
  }

  const workspaceParts = s.workspace.split("/");
  const agentsIdx = workspaceParts.lastIndexOf("agents");
  const agentName = agentsIdx >= 0 && workspaceParts[agentsIdx + 1] ? workspaceParts[agentsIdx + 1] : undefined;
  const modelName = s.resolvedModel ?? s.model;
  const durationMs = Math.max(0, Date.now() - startInfo.startedAt);

  const ctx: ChildFooterContext = { durationMs, kind: startInfo.kind };
  if (env.outputFile) {
    try {
      const st = statSync(env.outputFile);
      if (st.isFile()) ctx.outputBytes = st.size;
    } catch { /* ignore */ }
  }
  if (typeof env.totalTokens === "number" && env.totalTokens > 0) ctx.totalTokens = env.totalTokens;
  if (typeof env.toolUsesCount === "number" && env.toolUsesCount > 0) ctx.toolUsesCount = env.toolUsesCount;

  const body = formatTaskNotificationMessage(env);
  const footer = formatChildNotificationFooter(env, agentName, modelName, ctx);
  const text = `${body}\n\n${footer}`;
  const formatted = formatForChannel(text, parsed.channel);

  deliver(parsed.channel, parsed.target, formatted)
    .then(() => {
      consumeNotifyBudget(s.sessionKey);
      log.info({ sessionKey: s.sessionKey, taskId: env.taskId, status: env.status }, "Background task notification delivered");
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
      log.error({ err: err?.message, sessionKey: s.sessionKey, taskId: env.taskId }, "Task notification delivery failed");
    });
}

// --- Session lifecycle ---
function spawnSession(
  key: string,
  model: string,
  workspace: string,
  tools: string[],
  effort?: "low" | "medium" | "high" | "max",
  fullAccess?: boolean,
  agentEnv?: Record<string, string>,
  inheritUserScope?: boolean,
  isSubagent?: boolean,
  agent?: AgentConfig,
): SdkSession {
  let notifyToken: string | null = null;
  let notify: NotifyEnvContext | undefined;
  if (!isSubagent) {
    const parsed = parseSessionKey(key);
    if (parsed) {
      notifyToken = issueToken(parsed.channel, parsed.target);
      notify = { sessionKey: key, channel: parsed.channel, target: parsed.target, token: notifyToken };
    }
  }

  const sdkOpts = buildSdkOptions({
    model, tools, workspace, effort, fullAccess, agentEnv, inheritUserScope, isSubagent, notify,
    agent, sessionKey: key,
  });

  const pushable = makePushable<SDKUserMessage>();
  const q = query({ prompt: pushable.iterable, options: sdkOpts });

  const s: SdkSession = {
    sessionKey: key,
    workspace,
    model,
    resolvedModel: null,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    consecutiveTimeouts: 0,
    alive: true,
    q,
    pushable,
    consumer: Promise.resolve(),
    pendingResolve: null,
    pendingReject: null,
    pendingFiles: [],
    currentText: "",
    needsContext: true,
    inactivityTimer: null,
    lifetimeTimer: null,
    notifyToken,
    isSubagent: !!isSubagent,
    fullAccess: !!fullAccess,
    inheritUserScope: inheritUserScope !== false,
    totalInputTokens: 0,
    compactionCount: 0,
    firstEventReceived: false,
    firstEventTimer: null,
    pid: null,
  };

  s.consumer = (async () => {
    try {
      for await (const ev of q) {
        if (!s.alive) break;
        const e = ev as any;
        if (!s.firstEventReceived) {
          s.firstEventReceived = true;
          if (s.firstEventTimer) { clearTimeout(s.firstEventTimer); s.firstEventTimer = null; }
        }
        if (!s.resolvedModel) {
          const m = e.model ?? e.message?.model;
          if (typeof m === "string" && m.startsWith("claude-")) s.resolvedModel = m;
        }

        // ─── Context Inspector live signals ───────────────────────────────
        // BOTH events feed the live-progress map:
        //  - task_progress: running totalTokens (every step within a turn)
        //  - result: per-field usage breakdown (one per turn, needed for cost)
        // BLOCKER 1 fix from plan-checker: result tap MUST exist or cost calc
        // is always undefined for router-spawned sessions.
        if (e?.type === "system" && e?.subtype === "task_progress") {
          const total = e?.usage?.total_tokens;
          if (typeof total === "number" && total >= 0) {
            recordTaskProgress(s.sessionKey, total);
          }
          // Opportunistic sidecar registration — first task_progress means
          // the SDK process is alive and discoverable via `ps`.
          if (!sidecarPidsBySession.has(s.sessionKey)) {
            registerSessionSidecars(s).catch((err) => {
              log.debug({ err: String(err), sessionKey: s.sessionKey }, "registerSessionSidecars failed (best-effort)");
            });
          }
        }
        if (e?.type === "result" && e?.usage) {
          const u = e.usage;
          if (typeof u.input_tokens === "number" && typeof u.output_tokens === "number") {
            recordTurnResult(s.sessionKey, {
              input_tokens: u.input_tokens ?? 0,
              output_tokens: u.output_tokens ?? 0,
              cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
              cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
            });
          }
        }

        // Typed SDK error on the assistant message — surface it as the
        // canonical RATE_LIMIT/etc. so askClaudeInternal's fallback chain
        // triggers instead of waiting for the iterator to throw with a
        // string that may or may not match the substring checks.
        if (e.type === "assistant" && typeof e.error === "string") {
          if (s.pendingReject) {
            const reject = s.pendingReject;
            s.pendingResolve = null; s.pendingOnChunk = null;
            s.pendingReject = null;
            const errName = e.error === "rate_limit" ? "RATE_LIMIT" : `SDK_ERROR_${e.error}`;
            reject(new Error(errName));
          }
          continue;
        }

        // Token-level streaming via includePartialMessages=true. The SDK
        // wraps Anthropic's BetaRawMessageStreamEvent inside an
        // SDKPartialAssistantMessage. We only fire the chunk callback for
        // text deltas — tool_use deltas, message metadata, signature blocks
        // etc. don't belong in the TTS / chat-display path.
        if (e.type === "stream_event") {
          const ev = (e as any).event;
          if (
            ev?.type === "content_block_delta" &&
            ev?.delta?.type === "text_delta" &&
            typeof ev.delta.text === "string" &&
            ev.delta.text.length > 0 &&
            s.pendingOnChunk
          ) {
            try { s.pendingOnChunk(ev.delta.text); }
            catch (err) { log.warn({ err, key: s.sessionKey }, "pendingOnChunk threw (stream)"); }
          }
          continue;
        }

        // Assistant message: collect text + track tool_use (Write/Edit + bg starts).
        // We do NOT fire pendingOnChunk here when partial-message streaming is
        // active — the deltas have already been delivered above. Falling back
        // to firing on the full block.text would emit duplicate text into
        // Cartesia / the chat display.
        if (e.type === "assistant" && Array.isArray(e.message?.content)) {
          for (const block of e.message.content) {
            if (!block || typeof block !== "object") continue;
            if (block.type === "text" && typeof block.text === "string") {
              s.currentText += block.text;
            }
            if (block.type === "tool_use") {
              if ((block.name === "Write" || block.name === "Edit") && block.input?.file_path) {
                s.pendingFiles.push(block.input.file_path);
              }
              const isBgCapable = block.name === "Bash" || block.name === "Task" || block.name === "Agent";
              if (isBgCapable && block.input?.run_in_background === true && typeof block.id === "string") {
                if (!s.bgToolUseStarts) s.bgToolUseStarts = new Map();
                s.bgToolUseStarts.set(block.id, { startedAt: Date.now(), kind: block.name.toLowerCase() });
                log.debug({ sessionKey: s.sessionKey, toolUseId: block.id, name: block.name }, "Recorded background tool_use start");
              }
            }
          }
        }

        // Task notification — same parser, two paths (system event + synthetic user-event)
        const tn = extractTaskNotificationFromEvent(e);
        if (tn) handleTaskNotification(s, tn);

        // Result event = end of turn. Subtypes other than 'success' are
        // SDKResultError shapes (error_during_execution / error_max_turns /
        // error_max_budget_usd / error_max_structured_output_retries) — reject
        // so callers can surface or recover instead of resolving with empty
        // text.
        if (e.type === "result" && e.subtype && e.subtype !== "success" && s.pendingReject) {
          const reject = s.pendingReject;
          s.pendingResolve = null; s.pendingOnChunk = null;
          s.pendingReject = null;
          const errs = Array.isArray(e.errors) ? e.errors.join("; ") : "";
          reject(new Error(`SDK_RESULT_${e.subtype}${errs ? ": " + errs.slice(0, 200) : ""}`));
          continue;
        }
        if (e.type === "result" && s.pendingResolve) {
          const u = e.usage ?? {};
          const cacheCreation = u.cache_creation_input_tokens ?? 0;
          const cacheRead = u.cache_read_input_tokens ?? 0;
          const inputTokens = (u.input_tokens ?? 0) + cacheCreation + cacheRead;
          const outputTokens = u.output_tokens ?? 0;
          if (inputTokens > s.totalInputTokens) s.totalInputTokens = inputTokens;

          const text = e.result ?? s.currentText;
          if (!text || text === "waiting for message") continue;
          s.consecutiveTimeouts = 0;
          const resolve = s.pendingResolve;
          const files = [...s.pendingFiles];
          s.pendingResolve = null; s.pendingOnChunk = null;
          s.pendingReject = null;
          s.pendingFiles = [];
          s.currentText = "";
          resolve({
            text,
            durationMs: e.duration_ms,
            apiDurationMs: e.duration_api_ms,
            createdFiles: files.length > 0 ? files : undefined,
            inputTokens: inputTokens || undefined,
            outputTokens: outputTokens || undefined,
            cacheCreation: cacheCreation || undefined,
            cacheRead: cacheRead || undefined,
            costUsd: e.total_cost_usd,
          });
        }
      }
    } catch (err: any) {
      log.error({ err: err?.message, key: s.sessionKey }, "SDK consumer error");
      if (s.pendingReject) {
        const reject = s.pendingReject;
        s.pendingResolve = null; s.pendingOnChunk = null;
        s.pendingReject = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      s.alive = false;
      cleanupTimers(s);
    }
  })();

  s.lifetimeTimer = setTimeout(() => {
    log.info({ model }, "Max lifetime reached, killing session");
    killSession(s);
  }, MAX_LIFETIME_MS);

  return s;
}

function cleanupTimers(s: SdkSession): void {
  if (s.inactivityTimer) { clearTimeout(s.inactivityTimer); s.inactivityTimer = null; }
  if (s.lifetimeTimer) { clearTimeout(s.lifetimeTimer); s.lifetimeTimer = null; }
  if (s.firstEventTimer) { clearTimeout(s.firstEventTimer); s.firstEventTimer = null; }
}

function killSession(s: SdkSession): void {
  s.alive = false;
  cleanupTimers(s);
  // Context Inspector cleanup: drop live progress + sidecar files for this session.
  clearTaskProgress(s.sessionKey);
  unregisterSessionSidecars(s.sessionKey).catch((err) => {
    log.debug({ err: String(err), sessionKey: s.sessionKey }, "unregisterSessionSidecars failed (best-effort)");
  });
  // Reject a pending caller now — otherwise an external kill (lifetime timer,
  // killProcessByKey, killAllProcesses) leaves askClaude waiting up to
  // MESSAGE_TIMEOUT_MS for a result that will never arrive.
  if (s.pendingReject) {
    const reject = s.pendingReject;
    s.pendingResolve = null; s.pendingOnChunk = null;
    s.pendingReject = null;
    reject(new Error("PROCESS_DIED"));
  }
  if (s.notifyToken) { revokeToken(s.notifyToken); s.notifyToken = null; }
  resetNotifyBudget(s.sessionKey);
  try {
    // interrupt() stops the active turn cleanly (validated in spike).
    // After end() the iterator drains and the subprocess exits.
    (s.q as any).interrupt?.().catch(() => {});
  } catch {}
  try { s.pushable.end(); } catch {}
}

function resetInactivityTimer(key: string, s: SdkSession): void {
  if (s.inactivityTimer) clearTimeout(s.inactivityTimer);
  s.inactivityTimer = setTimeout(() => {
    log.info({ key }, "Inactivity timeout, killing session");
    killSession(s);
    sessions.delete(key);
  }, INACTIVITY_TIMEOUT_MS);
}

function getOrCreateSession(
  key: string, model: string, workspace: string,
  tools: string[] = [], effort?: "low" | "medium" | "high" | "max",
  fullAccess?: boolean, agentEnv?: Record<string, string>,
  inheritUserScope?: boolean, isSubagent?: boolean,
  agent?: AgentConfig,
): SdkSession {
  const existing = sessions.get(key);
  if (existing && existing.alive) {
    // Agent-config drift detection: if the same key was spawned earlier with a
    // different agent (workspace/fullAccess/inheritUserScope), kill+respawn so
    // we don't leak the previous agent's identity / MCP credentials. With the
    // agent-suffixed sessionKey this should already be impossible, but keep the
    // guard as defense-in-depth in case a caller forgets the suffix.
    const wantInherit = inheritUserScope !== false;
    if (
      existing.workspace !== workspace ||
      existing.fullAccess !== !!fullAccess ||
      existing.inheritUserScope !== wantInherit
    ) {
      log.warn({
        key,
        existing: { workspace: existing.workspace, fullAccess: existing.fullAccess, inheritUserScope: existing.inheritUserScope },
        requested: { workspace, fullAccess: !!fullAccess, inheritUserScope: wantInherit },
      }, "Session agent-config mismatch — respawning to avoid identity leak");
      killSession(existing);
      sessions.delete(key);
    } else {
      return existing;
    }
  } else if (existing) {
    killSession(existing);
    sessions.delete(key);
  }

  const mcpCount = tools.filter(t => t.startsWith("mcp:")).length;
  log.info({ key, model, workspace, toolCount: tools.length, mcpCount, fullAccess: !!fullAccess, inheritUserScope: inheritUserScope !== false, isSubagent: !!isSubagent }, "Spawning new SDK session");

  const s = spawnSession(key, model, workspace, tools, effort, fullAccess, agentEnv, inheritUserScope, isSubagent, agent);
  const pending = pendingSummaries.get(key);
  if (pending) s.compactionCount = pending.compactionCount;
  sessions.set(key, s);
  return s;
}

function sendMessage(
  s: SdkSession,
  message: string,
  images?: ImageBlock[],
  onChunk?: (delta: string) => void,
): Promise<TurnResult> {
  return new Promise((resolve, reject) => {
    if (!s.alive) {
      reject(new Error("PROCESS_DEAD"));
      return;
    }
    // Refuse to overlap turns. The per-session serial queue prevents this for
    // user-driven askClaude calls, but compaction issues two sendMessages
    // sequentially with a Promise.race timeout in between — if the timeout
    // fires while the SDK is still mid-turn, the next sendMessage would
    // overwrite pendingResolve and the late `result` event would resolve the
    // wrong promise. Failing fast here surfaces the bug instead of corrupting
    // state.
    if (s.pendingResolve) {
      reject(new Error("TURN_IN_FLIGHT"));
      return;
    }
    s.pendingResolve = resolve;
    s.pendingReject = reject;
    s.pendingOnChunk = onChunk ?? null;
    s.lastActivity = Date.now();

    // Arm a first-event watchdog only on the first turn of a new SDK
    // subprocess. If the spawn is wedged (e.g. a stdio MCP that never
    // completes its init handshake), tear it down quickly so the caller
    // can fall back / retry instead of waiting MESSAGE_TIMEOUT_MS.
    if (!s.firstEventReceived && !s.firstEventTimer) {
      s.firstEventTimer = setTimeout(() => {
        s.firstEventTimer = null;
        if (s.firstEventReceived || !s.alive) return;
        log.warn({ key: s.sessionKey, model: s.model }, "SDK first-event timeout — killing wedged spawn");
        // Reject with a distinct error so askClaudeInternal can retry the
        // SAME model on a fresh spawn instead of advancing to fallbacks
        // (silently downgrading opus → haiku is unacceptable).
        if (s.pendingReject) {
          const reject = s.pendingReject;
          s.pendingResolve = null; s.pendingOnChunk = null;
          s.pendingReject = null;
          reject(new Error("INIT_TIMEOUT"));
        }
        killSession(s);
        sessions.delete(s.sessionKey);
      }, FIRST_EVENT_TIMEOUT_MS);
    }

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

    const userMsg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "",
    };
    s.pushable.push(userMsg);
  });
}

// --- Compaction ---
const COMPACT_FALLBACK_PROMPT = [
  "Summarize the conversation so far in a structured list:",
  "- Decisions made",
  "- Files/paths touched or referenced",
  "- Open TODOs",
  "- Current task focus",
  "Maximum 20 bullets. No commentary, no preamble. Plain text only.",
].join("\n");

async function compactSession(s: SdkSession, key: string): Promise<void> {
  const tokensBefore = s.totalInputTokens;
  log.info({ key, model: s.model, tokensBefore, threshold: 0.80, compactionCount: s.compactionCount }, "Compacting session (sdk)");

  let summary = "";

  // Try /compact first.
  try {
    const result = await Promise.race([
      sendMessage(s, "/compact"),
      new Promise<TurnResult>((_, reject) => setTimeout(() => reject(new Error("COMPACT_TIMEOUT")), 90_000)),
    ]);
    const text = (result.text ?? "").trim();
    if (text.length > 40 && /[-•*]|summary|decision|file/i.test(text)) {
      summary = text;
    }
  } catch (err: any) {
    log.warn({ key, err: err?.message }, "Native /compact failed — falling back");
  }

  if (!summary && s.alive) {
    try {
      const result = await Promise.race([
        sendMessage(s, COMPACT_FALLBACK_PROMPT),
        new Promise<TurnResult>((_, reject) => setTimeout(() => reject(new Error("COMPACT_TIMEOUT")), 120_000)),
      ]);
      summary = (result.text ?? "").trim();
    } catch (err: any) {
      log.warn({ key, err: err?.message }, "Fallback compaction failed — respawn without summary");
    }
  }

  s.compactionCount++;
  const nextCompactionCount = s.compactionCount;
  if (summary) pendingSummaries.set(key, { summary, compactionCount: nextCompactionCount });
  killSession(s);
  sessions.delete(key);

  if (clientCount() > 0) {
    broadcast({
      type: "session.compacted",
      data: {
        ts: Date.now(), key, tokensBefore, threshold: 0.80, compactionCount: nextCompactionCount,
        summaryPreview: summary ? summary.slice(0, 300) : undefined,
      },
    });
  }
}

function hardResetSession(s: SdkSession, key: string, tokensBefore: number, compactionCount: number): void {
  log.warn({ key, compactionCount, tokensBefore }, "Max compactions reached — hard reset (sdk)");
  pendingSummaries.delete(key);
  killSession(s);
  sessions.delete(key);
  if (clientCount() > 0) {
    broadcast({
      type: "session.compacted",
      data: { ts: Date.now(), key, tokensBefore, threshold: 0.80, compactionCount, hardReset: true },
    });
  }
}

// --- Serial queue (per session) ---
const queues = new Map<string, Promise<void>>();

// --- Public API ---

/**
 * Session key shape: `${channel}:${target}:${agent}` (3 parts) when an agent
 * is known, falling back to `${channel}:${target}` for legacy callers (slash
 * commands resolve before route matching, dashboard notify-budget etc).
 *
 * Including `agent` is a security boundary: two routes that share the same
 * channel:target (e.g. owner messages in a guild routed to a privileged
 * agent, other members in the same guild routed to a scoped agent) MUST
 * get separate sessions, otherwise the first to spawn leaks its identity
 * and MCP credentials to subsequent senders.
 */
export function sessionKey(channel: string, from: string, group?: string, agent?: string): string {
  const target = group ?? from;
  return agent ? `${channel}:${target}:${agent}` : `${channel}:${target}`;
}

export async function askClaude(
  agent: AgentConfig,
  message: string,
  key: string,
  images?: ImageBlock[],
  opts?: {
    isSubagent?: boolean;
    /**
     * Per-turn assistant text DELTA callback. Fires for every text block as it
     * arrives from the SDK, before the full reply is ready. Used by streaming
     * TTS callers (notch connector with `JARVIS_TTS_LLM_STREAM=1`) to feed the
     * Cartesia WS pipeline incrementally. Errors thrown by the callback are
     * caught and logged — they never break turn handling.
     */
    onChunk?: (delta: string) => void;
  },
): Promise<ClaudeResponse> {
  const prev = queues.get(key) ?? Promise.resolve();
  let resolveQueue!: () => void;
  const myTurn = new Promise<void>((r) => { resolveQueue = r; });
  queues.set(key, prev.then(() => myTurn));
  await prev;

  try {
    return await askClaudeInternal(agent, message, key, images, opts);
  } finally {
    resolveQueue();
  }
}

async function askClaudeInternal(
  agent: AgentConfig,
  message: string,
  key: string,
  images?: ImageBlock[],
  opts?: { isSubagent?: boolean; onChunk?: (delta: string) => void },
): Promise<ClaudeResponse> {
  const models = [agent.model, ...(agent.fallbacks ?? [])].filter(Boolean) as string[];
  if (models.length === 0) models.push("opus");
  const startTime = Date.now();
  const envContext = loadEnvContext(agent.env);
  const fullMessage = envContext ? `${envContext}\n\n${message}` : message;

  // Per-spawn init-timeout retry budget: a wedged MCP init can happen on a
  // fresh spawn, but a SECOND wedge in the same call almost certainly means
  // a real environmental problem — surface it to the user instead of looping.
  let initTimeoutRetries = 0;
  const MAX_INIT_TIMEOUT_RETRIES = 1;

  for (let i = 0; i < models.length; i++) {
    const model = resolveModel(models[i]);
    try {
      const tools = agent.tools ?? [];
      let s = getOrCreateSession(key, model, agent.workspace, tools, agent.effort, agent.fullAccess, agent.env, agent.inheritUserScope, opts?.isSubagent, agent);

      if (s.model !== model) {
        killSession(s);
        sessions.delete(key);
        s = getOrCreateSession(key, model, agent.workspace, tools, agent.effort, agent.fullAccess, agent.env, agent.inheritUserScope, opts?.isSubagent, agent);
      }

      if (s.alive && s.totalInputTokens > 0 && shouldCompact(s.totalInputTokens, s.model)) {
        const tokensBefore = s.totalInputTokens;
        if (s.compactionCount >= 5) {
          hardResetSession(s, key, tokensBefore, s.compactionCount);
        } else {
          await compactSession(s, key);
        }
        s = getOrCreateSession(key, model, agent.workspace, tools, agent.effort, agent.fullAccess, agent.env, agent.inheritUserScope, opts?.isSubagent, agent);
      }

      return await doSendWithTimeout(s, key, fullMessage, model, message.length, startTime, agent, images, opts?.onChunk);
    } catch (err: any) {
      const errMsg = err?.message ?? "";
      if (errMsg === "INIT_TIMEOUT") {
        const s = sessions.get(key);
        if (s) { killSession(s); sessions.delete(key); }
        if (initTimeoutRetries < MAX_INIT_TIMEOUT_RETRIES) {
          initTimeoutRetries++;
          log.warn({ key, model, attempt: initTimeoutRetries }, "Init timeout — retrying same model on fresh spawn (no fallback)");
          i--; // retry same model index
          continue;
        }
        log.error({ key, model }, "Init timeout persisted after retry — surfacing to caller");
        throw new Error(`Lo spawn di ${model} è bloccato all'init (probabile MCP wedged). Riprova tra poco — non sto facendo fallback automatico a un modello più debole.`);
      }
      if (errMsg === "TIMEOUT") {
        log.warn({ key, model }, "Message timed out (sdk)");
        const s = sessions.get(key);
        if (s) { killSession(s); sessions.delete(key); }
        throw new Error("Claude took too long (30 min). Process killed — please retry.");
      }
      if (errMsg === "RATE_LIMIT" || errMsg.includes("rate_limit") || errMsg.includes("429") || errMsg.includes("overloaded")) {
        const s = sessions.get(key);
        if (s) { killSession(s); sessions.delete(key); }
        if (i < models.length - 1) {
          log.warn({ key, model, nextModel: models[i + 1] }, "Rate limited, falling back (sdk)");
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
      }
      if (errMsg.startsWith("PROCESS_D") && i < models.length - 1) {
        sessions.delete(key);
        continue;
      }
      log.error({ err: errMsg.slice(0, 200), key, model }, "Message failed (sdk)");
      if (i < models.length - 1) { sessions.delete(key); continue; }
      throw new Error("Sorry, all models are currently unavailable. Please try again later.");
    }
  }
  throw new Error("Sorry, all models are currently unavailable. Please try again later.");
}

async function doSendWithTimeout(
  s: SdkSession,
  key: string,
  inputMessage: string,
  modelName: string,
  charsIn: number,
  startTime: number,
  agent: AgentConfig,
  images?: ImageBlock[],
  onChunk?: (delta: string) => void,
): Promise<ClaudeResponse> {
  let message = inputMessage;
  log.info({ key, model: s.model, alive: s.alive, hasImages: !!images?.length }, "Sending message to SDK session");

  if (s.needsContext) {
    s.needsContext = false;
    const context = buildContextFromCache(key, agent.contextLimits);
    if (context) {
      message = context + "\n" + message;
      log.info({ key, contextLen: context.length }, "Injected session context from cache");
    }
  }

  const pending = pendingSummaries.get(key);
  if (pending) {
    pendingSummaries.delete(key);
    s.lastSummary = pending.summary;
    message = `[CONTEXT RESTORED — previous session summary]\n${pending.summary}\n[NEW TURN]\n${message}`;
    log.info({ key, summaryLen: pending.summary.length, compactionCount: pending.compactionCount }, "Injected compaction summary as first user turn");
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      s.consecutiveTimeouts++;
      if (s.pendingReject) { s.pendingResolve = null; s.pendingOnChunk = null; s.pendingReject = null; }
      reject(new Error("TIMEOUT"));
    }, MESSAGE_TIMEOUT_MS);
  });

  const result = await Promise.race([sendMessage(s, message, images, onChunk), timeoutPromise]);

  resetInactivityTimer(key, s);
  trackUsage(key, charsIn, result.text.length, Date.now() - startTime, {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheCreation: result.cacheCreation,
    cacheRead: result.cacheRead,
    costUsd: result.costUsd,
    apiDurationMs: result.apiDurationMs,
  });
  log.info({ key, model: s.model, responseLen: result.text.length, durationMs: result.durationMs }, "Claude responded (sdk)");

  return {
    text: result.text,
    model: s.resolvedModel ?? modelName,
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

// --- askClaudeFresh: one-shot via SDK (used by cron) ---
export async function askClaudeFresh(
  workspace: string,
  prompt: string,
  model?: string,
  timeoutMs: number = MESSAGE_TIMEOUT_MS,
  opts?: { fullAccess?: boolean; tools?: string[]; agentEnv?: Record<string, string>; inheritUserScope?: boolean; isSubagent?: boolean },
): Promise<FreshClaudeResult> {
  const resolvedModel = resolveModel(model);
  log.info({ workspace, model: resolvedModel, fullAccess: !!opts?.fullAccess, isSubagent: !!opts?.isSubagent }, "Fresh SDK call (cron)");

  const sdkOpts = buildSdkOptions({
    model: resolvedModel,
    tools: opts?.tools ?? [],
    workspace,
    fullAccess: opts?.fullAccess,
    agentEnv: opts?.agentEnv,
    inheritUserScope: opts?.inheritUserScope,
    isSubagent: opts?.isSubagent,
  });
  // One-shot — disable disk persistence so cron runs don't pollute ~/.claude/projects.
  sdkOpts.persistSession = false;

  return new Promise<FreshClaudeResult>((resolve) => {
    let settled = false;
    let q: Query | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { (q as any)?.interrupt?.().catch(() => {}); } catch {}
      resolve({ result: "Error: timeout", model: resolvedModel, exitCode: null, status: "timeout", error: "TIMEOUT" });
    }, timeoutMs);

    (async () => {
      try {
        q = query({ prompt, options: sdkOpts });
        let resultText = "";
        let resultUsage: any = undefined;
        let resultCost: number | undefined;
        let resultSessionId: string | undefined;
        let resultModel: string | undefined;
        let assistantText = "";

        for await (const ev of q) {
          const e = ev as any;
          if (e.session_id && !resultSessionId) resultSessionId = e.session_id;
          if (e.type === "system" && e.subtype === "init" && typeof e.model === "string") resultModel = e.model;
          if (e.type === "assistant" && Array.isArray(e.message?.content)) {
            for (const block of e.message.content) {
              if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
            }
          }
          if (e.type === "result") {
            resultText = e.result ?? assistantText;
            resultUsage = e.usage;
            resultCost = e.total_cost_usd;
            break;
          }
        }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          result: resultText || assistantText,
          model: resultModel || resolvedModel,
          sessionId: resultSessionId,
          usage: resultUsage,
          costUsd: resultCost,
          exitCode: 0,
          status: "ok",
        });
      } catch (err: any) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        log.error({ err: err?.message, workspace }, "Fresh SDK call failed");
        resolve({
          result: `Error: ${err?.message ?? "unknown"}`,
          model: resolvedModel,
          exitCode: null,
          status: "error",
          error: err?.message ?? String(err),
        });
      }
    })();
  });
}

// --- Maintenance / introspection ---
export function clearHistory(key: string): void {
  const s = sessions.get(key);
  if (s) { killSession(s); sessions.delete(key); }
}

/**
 * Clear every session whose key starts with `${channel}:${target}` — used by
 * `/clear` since slash commands run before route resolution and don't know
 * which agent suffix is on the live session.
 *
 * Returns the keys that were cleared so callers can also wipe their own
 * sidecar caches (session-cache disk files).
 */
export function clearHistoryByPrefix(channel: string, target: string): string[] {
  const prefixExact = `${channel}:${target}`;
  const prefixWithAgent = `${prefixExact}:`;
  const cleared: string[] = [];
  for (const key of Array.from(sessions.keys())) {
    if (key === prefixExact || key.startsWith(prefixWithAgent)) {
      const s = sessions.get(key);
      if (s) { killSession(s); sessions.delete(key); }
      cleared.push(key);
    }
  }
  return cleared;
}

export function killAllProcesses(): void {
  for (const [key, s] of sessions) {
    log.info({ key }, "Shutdown: killing SDK session");
    killSession(s);
  }
  sessions.clear();
}

process.on("exit", killAllProcesses);

export function getSessionStats(): { total: number; keys: string[] } {
  return { total: sessions.size, keys: [...sessions.keys()] };
}

export function getUsageStats(): Map<string, SessionStat> {
  return sessionStats;
}

export function killProcessByKey(key: string): boolean {
  const s = sessions.get(key);
  if (!s) return false;
  killSession(s);
  sessions.delete(key);
  return true;
}

export function getProcesses(): ProcessInfo[] {
  const result: ProcessInfo[] = [];
  for (const [key, s] of sessions) {
    const stats = sessionStats.get(key) ?? emptyStat();
    result.push({
      key,
      model: s.model,
      workspace: s.workspace,
      alive: s.alive,
      pid: s.pid,
      pending: s.pendingResolve !== null,
      needsContext: s.needsContext,
      createdAt: s.createdAt,
      lastMessageAt: s.lastActivity,
      inactivityExpiresAt: s.lastActivity + INACTIVITY_TIMEOUT_MS,
      lifetimeExpiresAt: s.createdAt + MAX_LIFETIME_MS,
      messageCount: stats.messages,
      consecutiveTimeouts: s.consecutiveTimeouts,
      pendingFilesCount: s.pendingFiles.length,
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
      totalInputTokens: s.totalInputTokens,
      compactionCount: s.compactionCount,
      nearContextLimit: shouldCompact(s.totalInputTokens, s.model),
      lastSummaryPreview: s.lastSummary ? s.lastSummary.slice(0, 300) : undefined,
    });
  }
  return result;
}

/** No-op for SDK adapter — bundled cli.js is auto-resolved. Kept for parity
 *  with the CLI dispatcher's public surface (used by dashboard diagnostic). */
export function resolveCliPath(): string {
  return "(sdk: bundled cli.js)";
}

// ─── Context Inspector — read-only metadata exports for the API layer ───────

/**
 * Read-only access to a router-spawned session's metadata for the API layer.
 * Returns null if no session by that key (session has been killed or never existed).
 */
export function getSessionMetadata(sessionKey: string): {
  workspace: string;
  model: string;
  resolvedModel: string | null;
  fullAccess: boolean;
  inheritUserScope: boolean;
  totalInputTokens: number;
  compactionCount: number;
  alive: boolean;
} | null {
  const s = sessions.get(sessionKey);
  if (!s) return null;
  return {
    workspace: s.workspace,
    model: s.model,
    resolvedModel: s.resolvedModel,
    fullAccess: s.fullAccess,
    inheritUserScope: s.inheritUserScope,
    totalInputTokens: s.totalInputTokens,
    compactionCount: s.compactionCount,
    alive: s.alive,
  };
}

/** List all live router session keys (used by the cruft endpoint + dashboard). */
export function listSessionKeys(): string[] {
  return [...sessions.keys()];
}
