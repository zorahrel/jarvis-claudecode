/**
 * MCP server status cache.
 *
 * Pre-spawn knowledge of which external MCP servers are healthy / need auth /
 * have failed, used by `services/claude.ts` `buildSdkOptions()` to filter out
 * unusable servers BEFORE attaching them to a new SDK session. Without this,
 * a `needs-auth` server gets attached → mcp-remote spawns → OAuth popup —
 * even when the user never asked. With ~3 live sessions all attaching the
 * same broken server, you got 3 popups for one click. No more.
 *
 * Source of truth is `claude mcp list` (CLI, parsed). Refreshed:
 *   - On boot
 *   - Every REFRESH_INTERVAL_MS (background tick)
 *   - On explicit `refreshMcpStatus()` call (e.g. after the user clicks
 *     "Authenticate" in the dashboard and we expect state to have changed)
 */

import { execFile } from "child_process";
import { existsSync } from "fs";
import { logger } from "./logger";

const log = logger.child({ module: "mcp-status" });

export type McpStatus = "connected" | "auth" | "failed" | "unknown";

export interface McpServerStatus {
  name: string;
  target: string;
  status: McpStatus;
  statusText: string;
}

const REFRESH_INTERVAL_MS = 60_000;
const CLI_TIMEOUT_MS = 15_000;

let cache: Map<string, McpServerStatus> = new Map();
let lastRefreshedAt = 0;
let refreshInflight: Promise<void> | null = null;
let cliPath: string | null = null;

function resolveCliPath(): string {
  if (cliPath) return cliPath;
  // Prefer explicit env, then known install locations, then PATH.
  // The router runs under launchd which has a minimal PATH that doesn't
  // include ~/.local/bin where the standalone Claude installer puts the
  // binary, so we look for it explicitly.
  if (process.env.CLAUDE_CLI) {
    cliPath = process.env.CLAUDE_CLI;
    return cliPath;
  }
  const home = process.env.HOME ?? "";
  const candidates = [
    `${home}/.local/bin/claude`,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) {
    if (existsSync(c)) { cliPath = c; return cliPath; }
  }
  cliPath = "claude";
  return cliPath;
}

function parseClaudeMcpList(out: string): McpServerStatus[] {
  return out.split("\n")
    .map(l => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .map((l): McpServerStatus | null => {
      const m = l.match(/^(.+?)\s+-\s+([✓✗!])\s+(.*)$/);
      if (!m) return null;
      const [, head, icon, statusText] = m as [string, string, string, string];
      // Names may contain colons; split on FIRST ": ".
      const idx = head.indexOf(": ");
      if (idx < 0) return null;
      const name = head.slice(0, idx).trim();
      const target = head.slice(idx + 2).trim();
      if (!name) return null;
      const status: McpStatus =
        icon === "✓" ? "connected" :
        icon === "!" ? "auth" :
        icon === "✗" ? "failed" : "unknown";
      return { name, target, status, statusText: statusText.trim() };
    })
    .filter((x): x is McpServerStatus => x !== null);
}

export async function refreshMcpStatus(): Promise<void> {
  if (refreshInflight) return refreshInflight;
  refreshInflight = (async () => {
    try {
      const cli = resolveCliPath();
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(cli, ["mcp", "list"], { timeout: CLI_TIMEOUT_MS }, (err, out, errBuf) => {
          if (err && !out) reject(new Error((errBuf as string | Buffer)?.toString() || err.message));
          else resolve(out as string);
        });
      });
      const parsed = parseClaudeMcpList(stdout);
      cache = new Map(parsed.map(s => [s.name, s]));
      lastRefreshedAt = Date.now();
      log.debug({
        count: cache.size,
        connected: parsed.filter(s => s.status === "connected").length,
        auth: parsed.filter(s => s.status === "auth").length,
        failed: parsed.filter(s => s.status === "failed").length,
      }, "mcp-status refreshed");
    } catch (err) {
      log.warn({ err: String(err) }, "mcp-status refresh failed");
    } finally {
      refreshInflight = null;
    }
  })();
  return refreshInflight;
}

export function getMcpStatus(name: string): McpServerStatus | undefined {
  return cache.get(name);
}

export function listMcpStatus(): McpServerStatus[] {
  return [...cache.values()];
}

/**
 * Names of MCP servers that should NOT be attached to fresh SDK sessions
 * because they're known to be broken or awaiting human OAuth. Reduces popup
 * noise and avoids spawning doomed mcp-remote children.
 */
export function getSkipSet(): Set<string> {
  const skip = new Set<string>();
  for (const s of cache.values()) {
    if (s.status === "auth" || s.status === "failed") skip.add(s.name);
  }
  return skip;
}

export function getLastRefreshedAt(): number {
  return lastRefreshedAt;
}

export function startMcpStatusWatcher(): void {
  // Initial refresh fire-and-forget; don't block boot.
  refreshMcpStatus().catch(err => log.warn({ err: String(err) }, "initial mcp-status refresh failed"));
  const t = setInterval(() => {
    refreshMcpStatus().catch(() => {});
  }, REFRESH_INTERVAL_MS);
  t.unref();
}
