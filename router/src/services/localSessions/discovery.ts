import { promises as fs } from "fs";
import { homedir } from "os";
import { join, basename } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "../logger";
import { EVENTS_DIR } from "./hooksInstaller";
import type { LocalSession, LocalSessionStatus } from "./types";
import { readSessionSidecar } from "../contextInspector/sidecar.js";

const log = logger.child({ module: "localSessions:discovery" });
const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 2000;
let cache: { at: number; sessions: LocalSession[] } | null = null;

const EVENT_TO_STATUS: Record<string, LocalSessionStatus> = {
  SessionStart: "idle",
  SessionEnd: "finished",
  Stop: "idle",
  UserPromptSubmit: "working",
  SubagentStart: "working",
  PostToolUseFailure: "working",
  PermissionRequest: "waiting",
};

interface HookEvent {
  event: string;
  sessionId: string | null;
  cwd: string | null;
  transcriptPath: string | null;
  ts: number;
}

async function readAllHookEvents(): Promise<Map<number, HookEvent>> {
  const result = new Map<number, HookEvent>();
  let entries: string[];
  try {
    entries = await fs.readdir(EVENTS_DIR);
  } catch {
    return result;
  }
  const now = Date.now();
  const STALE_MS = 24 * 60 * 60 * 1000;

  await Promise.all(
    entries.filter((e) => e.endsWith(".json")).map(async (filename) => {
      const filePath = join(EVENTS_DIR, filename);
      try {
        const st = await fs.stat(filePath);
        if (now - st.mtimeMs > STALE_MS) {
          await fs.unlink(filePath).catch(() => {});
          return;
        }
        const content = (await fs.readFile(filePath, "utf-8")).trim();
        if (!content) return;
        const data = JSON.parse(content) as {
          event?: string;
          session_id?: string;
          cwd?: string;
          transcript_path?: string;
          ts?: number;
        };
        if (!data.event) return;
        const pid = parseInt(filename.replace(/\.json$/, ""), 10);
        if (!Number.isFinite(pid)) return;
        result.set(pid, {
          event: data.event,
          sessionId: data.session_id || null,
          cwd: data.cwd || null,
          transcriptPath: data.transcript_path || null,
          ts: data.ts ?? 0,
        });
      } catch {
        /* skip corrupt / missing */
      }
    }),
  );
  return result;
}

interface ProcInfo {
  pid: number;
  ppid: number;
  command: string;
  cpu: number;
}

/**
 * Match *only* Claude Code CLI processes — not arbitrary processes that happen
 * to have "claude" in their working directory or script name. Two shapes:
 *   1. A direct `claude` binary: first token ends in `/claude` (or is just `claude`)
 *   2. A node invocation of the CLI: any token looks like `.../claude-code/.../cli.js` or `.../@anthropic-ai/claude-code/...`
 * Excludes the Claude Desktop app, Electron helpers, and things like pty-bridge.mjs
 * that live inside `.claude/worktrees/...`.
 */
function isClaudeCliProcess(args: string): boolean {
  if (/Claude\.app\//.test(args)) return false;
  if (/Electron/.test(args)) return false;
  const tokens = args.split(/\s+/);
  if (tokens.length === 0) return false;
  const exe = tokens[0];
  // Direct binary: last path segment is literally "claude"
  if (/(^|\/)claude$/.test(exe)) return true;
  // Node invocation of the Claude CLI entrypoint
  for (const t of tokens) {
    if (/@anthropic-ai\/claude-code\//.test(t)) return true;
    if (/\/claude-code\/.*cli\.(m?js|cjs)$/.test(t)) return true;
    // Global bin shim: `node /path/to/bin/claude`
    if (/\/bin\/claude$/.test(t)) return true;
  }
  return false;
}

async function findClaudeProcesses(): Promise<ProcInfo[]> {
  // `ps -axo pid,ppid,pcpu,comm,args` — grep claude binaries, exclude Claude Desktop
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pcpu=,args="], {
      maxBuffer: 10 * 1024 * 1024,
    });
    const lines = stdout.split("\n");
    const procs: ProcInfo[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+\.\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      const ppid = parseInt(m[2], 10);
      const cpu = parseFloat(m[3]);
      const args = m[4];
      // Match `claude` CLI — exclude Claude.app (Desktop), Electron helpers, Anthropic web clients
      if (!isClaudeCliProcess(args)) continue;
      procs.push({ pid, ppid, cpu, command: args });
    }
    return procs;
  } catch (err) {
    log.warn({ err }, "ps failed");
    return [];
  }
}

const LSOF_BIN = "/usr/sbin/lsof";

async function getCwd(pid: number): Promise<string | null> {
  try {
    // lsof -a -p <pid> -d cwd -Fn   →   p<pid>\nfcwd\nn<path>
    // Use absolute path — under launchd PATH is minimal and may not include /usr/sbin.
    const { stdout } = await execFileAsync(LSOF_BIN, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      maxBuffer: 1024 * 1024,
    });
    for (const line of stdout.split("\n")) {
      if (line.startsWith("n")) return line.slice(1).trim();
    }
  } catch {
    /* process may have died, or lsof not installed */
  }
  return null;
}

async function getTty(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "tty="]);
    const tty = stdout.trim();
    if (!tty || tty === "??") return null;
    return tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
  } catch {
    return null;
  }
}

async function getBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: 2000,
    });
    const branch = stdout.trim();
    return branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

async function readJsonlTail(path: string, maxBytes = 64_000): Promise<string[]> {
  try {
    const fh = await fs.open(path, "r");
    try {
      const st = await fh.stat();
      const start = Math.max(0, st.size - maxBytes);
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      return buf.toString("utf-8").split("\n").filter((l) => l.trim());
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

interface JsonlEntry {
  type?: string;
  message?: { role?: string; content?: unknown };
}

function extractPreview(lines: string[]): { lastUserMessage: string | null; lastAssistantText: string | null } {
  let lastUser: string | null = null;
  let lastAssistant: string | null = null;
  // Iterate reverse, stop when we have both
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lastUser && lastAssistant) break;
    try {
      const e = JSON.parse(lines[i]) as JsonlEntry;
      const role = e.message?.role;
      if (role === "user" && !lastUser) {
        lastUser = extractText(e.message?.content);
      } else if (role === "assistant" && !lastAssistant) {
        lastAssistant = extractText(e.message?.content);
      }
    } catch {
      /* skip malformed */
    }
  }
  const clip = (s: string | null) => (s && s.length > 200 ? s.slice(0, 200) + "…" : s);
  return { lastUserMessage: clip(lastUser), lastAssistantText: clip(lastAssistant) };
}

function extractText(content: unknown): string | null {
  if (!content) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === "object" && (c as { type?: string }).type === "text") {
        return (c as { text?: string }).text || null;
      }
    }
  }
  return null;
}

function statusFromEvent(event: string | null): LocalSessionStatus {
  if (!event) return "unknown";
  return EVENT_TO_STATUS[event] ?? "unknown";
}

/**
 * Discover all running `claude` CLI processes on the host. Combines:
 *  1. Process table (ps) to get PIDs + parent command
 *  2. lsof to get each PID's working directory
 *  3. Hook events dir (~/.claude/jarvis/events/<pid>.json) for status + transcript path
 *  4. Git for branch info
 *  5. JSONL tail for preview
 *
 * Cached for 2s to avoid spamming ps/lsof.
 */
export async function discoverLocalSessions(): Promise<LocalSession[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.sessions;

  const [procs, hookEvents] = await Promise.all([findClaudeProcesses(), readAllHookEvents()]);
  if (procs.length === 0) {
    cache = { at: Date.now(), sessions: [] };
    return [];
  }

  const sessions = await Promise.all(
    procs.map(async (p): Promise<LocalSession | null> => {
      const hook = hookEvents.get(p.pid);
      // Prefer cwd from hook (authoritative — it's what Claude thinks its cwd is)
      let cwd = hook?.cwd ?? (await getCwd(p.pid));
      if (!cwd) return null;
      // Expand ~
      if (cwd.startsWith("~")) cwd = cwd.replace(/^~/, homedir());

      const [branch, tty] = await Promise.all([getBranch(cwd), getTty(p.pid)]);

      let preview: LocalSession["preview"] = { lastUserMessage: null, lastAssistantText: null };
      let lastActivity = hook?.ts ? hook.ts * 1000 : Date.now();
      if (hook?.transcriptPath) {
        try {
          const st = await fs.stat(hook.transcriptPath);
          lastActivity = st.mtimeMs;
          const lines = await readJsonlTail(hook.transcriptPath);
          preview = extractPreview(lines);
        } catch { /* transcript gone */ }
      }

      // Context Inspector: read sidecar by PID for sessionKey/agent linkage.
      // Sidecar is written by claude.ts registerSessionSidecars after the
      // first task_progress event; removed by killSession. MAJOR 5 fix.
      const sidecar = await readSessionSidecar(p.pid);

      return {
        pid: p.pid,
        cwd,
        repoName: basename(cwd),
        branch,
        status: statusFromEvent(hook?.event ?? null),
        hookEvent: hook?.event ?? null,
        sessionId: hook?.sessionId ?? null,
        transcriptPath: hook?.transcriptPath ?? null,
        lastActivity,
        tty,
        parentCommand: p.command,
        preview,
        isRouterSpawned:
          sidecar !== null ||
          /JARVIS_SPAWN=1/.test(p.command) ||
          p.command.includes(".claude/jarvis/router"),
        sessionKey: sidecar?.sessionKey,
        agent: sidecar?.agent,
        fullAccess: sidecar?.fullAccess,
        inheritUserScope: sidecar?.inheritUserScope,
      };
    }),
  );

  const filtered = sessions.filter((s): s is LocalSession => s !== null);
  cache = { at: Date.now(), sessions: filtered };
  return filtered;
}

export function invalidateLocalSessionsCache(): void {
  cache = null;
}
