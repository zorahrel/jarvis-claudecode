/**
 * MCP Refresh Trigger — proactive OAuth token rotation.
 *
 * Standard OAuth providers (Google, Vercel, Cloudflare, Supabase) issue
 * refresh tokens alongside access tokens. The access token has a short TTL
 * (1h–24h); the refresh token is long-lived (months) and is used to mint
 * a new access token without user interaction.
 *
 * `mcp-remote` (the npx wrapper used by stdio MCPs) HAS this refresh logic
 * built in — but it only fires when an MCP request hits the server and
 * gets a 401. If nobody uses Gmail for 25 hours, the token expires in
 * silence until the next attempt fails.
 *
 * This module fires a lightweight "ping" against each stdio + mcp-remote
 * MCP every 4 hours. The ping is an MCP `initialize` request piped via
 * stdin to a short-lived `npx mcp-remote URL` process. mcp-remote then
 * (a) reads the cached token, (b) makes the upstream request, (c) sees
 * 401 if expired, (d) hits the OAuth refresh endpoint with the refresh
 * token, (e) saves the new access token, (f) returns the response.
 *
 * Net effect: tokens that CAN refresh do so automatically. Tokens whose
 * provider doesn't issue refresh tokens (or whose refresh tokens have
 * also expired) still need manual re-auth via the dashboard — and the
 * health monitor (mcp-health-monitor.ts) tells the user.
 *
 * For type:http MCPs (Claude Code native), Claude Code handles refresh
 * internally when an MCP tool is invoked. We don't ping those — relying
 * on natural usage and the health monitor as the safety net.
 */

import { spawn } from "child_process";
import { logger } from "./logger";
import { listMcpStatus } from "./mcp-status";

const log = logger.child({ module: "mcp-refresh-trigger" });

const POLL_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4h — well under typical 24h TTL
const INITIAL_DELAY_MS = 2 * 60 * 1000; // 2min after boot, after health monitor
const PER_PING_TIMEOUT_MS = 10_000; // kill mcp-remote after 10s

let intervalHandle: NodeJS.Timeout | null = null;
let initialHandle: NodeJS.Timeout | null = null;

/**
 * Fire one MCP `initialize` request through a transient `npx mcp-remote URL`
 * subprocess. Resolves regardless of outcome — we don't propagate errors
 * because partial failures across many servers shouldn't cascade.
 */
async function pingMcpRemote(url: string, name: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["mcp-remote", url], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      log.debug({ name, url }, "[mcp-refresh-trigger] ping timeout — killed");
      resolve();
    }, PER_PING_TIMEOUT_MS);

    // Send a minimal MCP initialize handshake. mcp-remote forwards it to the
    // upstream server, which forces a token check on the way through.
    const init = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agent-conductor-refresh-ping", version: "1.0.0" },
      },
    }) + "\n";

    try {
      child.stdin.write(init);
      child.stdin.end();
    } catch (err) {
      log.debug({ err, name }, "[mcp-refresh-trigger] stdin write failed (mcp-remote may have already exited)");
    }

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!killed) {
        log.debug({ name, code }, "[mcp-refresh-trigger] ping exited");
      }
      resolve();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      log.debug({ err, name }, "[mcp-refresh-trigger] spawn error (npm not installed?)");
      resolve();
    });
  });
}

async function tick(): Promise<void> {
  const servers = listMcpStatus();
  // Only ping stdio + mcp-remote URL. type:http is Claude Code native — refresh
  // happens on natural use, we don't want to spawn `claude --print` for ping.
  const stdioRemote = servers
    .map((s) => {
      const m = s.target.match(/mcp-remote\s+(https?:\/\/\S+)/);
      return m ? { name: s.name, url: m[1] } : null;
    })
    .filter((x): x is { name: string; url: string } => x !== null);

  if (stdioRemote.length === 0) {
    log.debug("[mcp-refresh-trigger] no stdio + mcp-remote servers to ping");
    return;
  }

  log.info({ count: stdioRemote.length }, "[mcp-refresh-trigger] pinging stdio MCP servers for proactive refresh");

  // Run serially to avoid spawning N npx processes simultaneously. Each is
  // ≤ 10s. With ≤5 stdio MCPs this is ≤50s per cycle, fine for a 4h cadence.
  for (const { name, url } of stdioRemote) {
    await pingMcpRemote(url, name);
  }

  log.info({ count: stdioRemote.length }, "[mcp-refresh-trigger] cycle complete");
}

export function startMcpRefreshTrigger(): void {
  if (intervalHandle) return;
  log.info({ intervalMs: POLL_INTERVAL_MS, initialDelayMs: INITIAL_DELAY_MS }, "MCP Refresh Trigger starting");
  initialHandle = setTimeout(() => {
    tick().catch((err) => log.error({ err }, "[mcp-refresh-trigger] initial tick failed"));
  }, INITIAL_DELAY_MS);
  intervalHandle = setInterval(() => {
    tick().catch((err) => log.error({ err }, "[mcp-refresh-trigger] tick failed"));
  }, POLL_INTERVAL_MS);
}

export function stopMcpRefreshTrigger(): void {
  if (initialHandle) {
    clearTimeout(initialHandle);
    initialHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
