/**
 * Per-MCP tool enumeration for the dashboard MCP Health tab.
 *
 * `claude mcp list` only reports connection status, not the tools each server
 * exposes. To show "what can this MCP actually do", we connect to each server
 * and call `tools/list`. That work is delegated to a standalone helper
 * (`mcp-servers/gateway/introspect.mjs`) which already has the MCP SDK + all
 * client transports installed — no new dependency on the router.
 *
 * Safety: we only introspect servers that `mcp-status` reports as CONNECTED.
 * Auth-pending / failed servers are skipped, so we never trigger an OAuth
 * popup here (the same invariant `mcp-status` protects).
 *
 * Cache: results live in memory, refreshed lazily (TTL) or on explicit request.
 */

import { execFile } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { logger } from "./logger";
import { listMcpStatus } from "./mcp-status";

const log = logger.child({ module: "mcp-tools" });

const HOME = process.env.HOME ?? "";
const JARVIS_ROOT = join(HOME, ".claude/jarvis");
const INTROSPECT = join(JARVIS_ROOT, "mcp-servers/gateway/introspect.mjs");
const TTL_MS = 5 * 60_000;
const EXEC_TIMEOUT_MS = 30_000;

export interface McpToolInfo { name: string; description: string }
export interface McpServerTools { tools: McpToolInfo[]; error: string | null }

let cache: Record<string, McpServerTools> = {};
let lastRefreshedAt = 0;
let inflight: Promise<void> | null = null;

interface Job {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface RawCfg {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** Collect name→config from user scope + every project scope in ~/.claude.json. */
function collectConfigs(): Map<string, RawCfg> {
  const out = new Map<string, RawCfg>();
  try {
    const conf = JSON.parse(readFileSync(join(HOME, ".claude.json"), "utf8")) as {
      mcpServers?: Record<string, RawCfg>;
      projects?: Record<string, { mcpServers?: Record<string, RawCfg> }>;
    };
    for (const [name, cfg] of Object.entries(conf.mcpServers ?? {})) out.set(name, cfg);
    for (const proj of Object.values(conf.projects ?? {})) {
      for (const [name, cfg] of Object.entries(proj.mcpServers ?? {})) {
        if (!out.has(name)) out.set(name, cfg);
      }
    }
  } catch (e) {
    log.warn({ err: String(e) }, "mcp-tools: failed to read ~/.claude.json");
  }
  return out;
}

function toJob(name: string, cfg: RawCfg): Job | null {
  if (cfg.command || cfg.type === "stdio") {
    if (!cfg.command) return null;
    return { name, transport: "stdio", command: cfg.command, args: cfg.args, env: cfg.env };
  }
  if (cfg.url) {
    return { name, transport: cfg.type === "sse" ? "sse" : "http", url: cfg.url, headers: cfg.headers };
  }
  return null;
}

export async function refreshMcpTools(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    if (!existsSync(INTROSPECT)) {
      log.warn({ INTROSPECT }, "mcp-tools: introspect helper not found");
      return;
    }
    // Only introspect connected servers — never poke auth/failed ones.
    const connected = new Set(listMcpStatus().filter(s => s.status === "connected").map(s => s.name));
    const configs = collectConfigs();
    const jobs: Job[] = [];
    for (const name of connected) {
      const cfg = configs.get(name);
      if (!cfg) continue;
      const job = toJob(name, cfg);
      if (job) jobs.push(job);
    }
    if (jobs.length === 0) { lastRefreshedAt = Date.now(); return; }

    const jobsFile = join(tmpdir(), `jarvis-mcp-jobs-${process.pid}.json`);
    writeFileSync(jobsFile, JSON.stringify(jobs));
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile("node", [INTROSPECT, jobsFile], { timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
          (err, out) => (err && !out ? reject(err) : resolve(out as string)));
      });
      cache = JSON.parse(stdout) as Record<string, McpServerTools>;
      lastRefreshedAt = Date.now();
      log.debug({ servers: Object.keys(cache).length }, "mcp-tools refreshed");
    } catch (e) {
      log.warn({ err: String(e) }, "mcp-tools introspection failed");
    }
  })();
  try { await inflight; } finally { inflight = null; }
}

/** Return cached per-server tools, refreshing if stale. */
export async function getMcpTools(): Promise<{ tools: Record<string, McpServerTools>; refreshedAt: number }> {
  if (Date.now() - lastRefreshedAt > TTL_MS) {
    await refreshMcpTools();
  }
  return { tools: cache, refreshedAt: lastRefreshedAt };
}

export function getLastToolsRefreshedAt(): number { return lastRefreshedAt; }
