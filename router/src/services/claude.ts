import { spawn, ChildProcess } from "child_process";
import { join } from "path";
import { createInterface, Interface } from "readline";
import { readdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import type { AgentConfig } from "../types";
import { logger } from "./logger";
import { buildContextFromCache } from "./session-cache";
import { readMcpServers } from "./config-loader";

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

function buildSafeEnv(agentEnv?: Record<string, string>): Record<string, string> {
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

// --- Model mapping ---
const MODEL_MAP: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

function resolveModel(name: string | undefined): string {
  if (!name) return MODEL_MAP.opus;
  if (name.includes("claude-")) return name;
  return MODEL_MAP[name] ?? MODEL_MAP.opus;
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
  proc: ChildProcess;
  readline: Interface;
  model: string;
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
}

const processes = new Map<string, PersistentProcess>();

/** Build CLI args and env for spawning Claude Code */
function buildSpawnArgs(opts: {
  model: string;
  tools: string[];
  effort?: "low" | "medium" | "high" | "max";
  streaming: boolean;
  fullAccess?: boolean;
  agentEnv?: Record<string, string>;
  inheritUserScope?: boolean;
}): { args: string[]; env: Record<string, string> } {
  const { model, tools, effort, streaming, fullAccess, inheritUserScope = true } = opts;
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
    "--verbose",
    "--model", model,
    "--setting-sources", settingSources,
    "--exclude-dynamic-system-prompt-sections",
  ];

  if (streaming) {
    args.push("--input-format", "stream-json", "--output-format", "stream-json");
  } else {
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

  const env = buildSafeEnv(opts.agentEnv);

  return { args, env };
}

function spawnPersistentProcess(
  model: string, workspace: string, tools: string[] = [],
  effort?: "low" | "medium" | "high" | "max",
  fullAccess?: boolean,
  agentEnv?: Record<string, string>,
  inheritUserScope?: boolean,
): PersistentProcess {
  const { args, env } = buildSpawnArgs({ model, tools, effort, streaming: true, fullAccess, agentEnv, inheritUserScope });

  const proc = spawn(resolveCliPath(), args, {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });

  const rl = createInterface({ input: proc.stdout! });

  const pp: PersistentProcess = {
    proc,
    readline: rl,
    model,
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
  };

  // Handle NDJSON lines from stdout
  rl.on("line", (line: string) => {
    try {
      const event = JSON.parse(line);

      // Log system/result events for debugging
      if (event.type === "result") {
        log.info({ type: event.type, resultLen: (event.result ?? "").length, resultPreview: (event.result ?? "").slice(0, 80) }, "Claude event: result");
      }

      // Track files created/written by Claude (tool_use events)
      if (event.type === "assistant" && Array.isArray(event.content)) {
        for (const block of event.content) {
          if (block.type === "tool_use" && (block.name === "Write" || block.name === "Edit") && block.input?.file_path) {
            pp.pendingFiles.push(block.input.file_path);
          }
        }
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
  log.info({ key, model, workspace, toolCount: tools.length, mcpCount, fullAccess: !!fullAccess, inheritUserScope: inheritUserScope !== false }, "Spawning new persistent process");
  const pp = spawnPersistentProcess(model, workspace, tools, effort, fullAccess, agentEnv, inheritUserScope);
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
): Promise<ClaudeResponse> {
  const prev = queues.get(key) ?? Promise.resolve();
  let resolveQueue: () => void;
  const myTurn = new Promise<void>((r) => { resolveQueue = r; });
  queues.set(key, prev.then(() => myTurn));
  await prev;

  try {
    return await askClaudeInternal(agent, message, key, images);
  } finally {
    resolveQueue!();
  }
}

async function askClaudeInternal(
  agent: AgentConfig,
  message: string,
  key: string,
  images?: ImageBlock[],
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
      const pp = getOrCreateProcess(key, model, agent.workspace, tools, agent.effort, agent.fullAccess, agent.env, agent.inheritUserScope);

      // If model changed (fallback), need new process
      if (pp.model !== model) {
        killProcess(pp);
        processes.delete(key);
        const newPp = getOrCreateProcess(key, model, agent.workspace, tools, agent.effort, agent.fullAccess, agent.env, agent.inheritUserScope);
        return await doSendWithTimeout(newPp, key, fullMessage, models[i], message.length, startTime, images);
      }

      return await doSendWithTimeout(pp, key, fullMessage, models[i], message.length, startTime, images);
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
    model: modelName,
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

export async function askClaudeFresh(
  workspace: string,
  prompt: string,
  model?: string,
  timeoutMs: number = MESSAGE_TIMEOUT_MS,
): Promise<string> {
  const resolvedModel = resolveModel(model);
  log.info({ workspace, model: resolvedModel }, "Fresh Claude call (cron)");

  const { args, env } = buildSpawnArgs({
    model: resolvedModel, tools: [], streaming: false,
  });

  return new Promise((resolve, reject) => {
    const proc = spawn(resolveCliPath(), args, {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("TIMEOUT"));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        log.error({ code, stderr: stderr.slice(0, 200), workspace }, "Cron Claude call failed");
        resolve(`Error: CLI exited with code ${code}`);
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed.result ?? stdout.trim());
      } catch {
        resolve(stdout.trim());
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      log.error({ err: err.message, workspace }, "Cron Claude call error");
      resolve(`Error: ${err.message}`);
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
