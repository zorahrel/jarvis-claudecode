/**
 * MCP Health Monitor — periodic check + alert when servers need re-auth.
 *
 * Polls `claude mcp list` every 6h (configurable) via `refreshMcpStatus`,
 * scans for `auth` / `failed` statuses, and logs a structured alert so the
 * user knows BEFORE the next attempt fails.
 *
 * Pairs with:
 *   - `mcp-auth-backup.ts`  (daily snapshot of token store)
 *   - `mcp-refresh-trigger.ts`  (proactive token refresh via mcp-remote ping)
 *   - dashboard tab `MCP Health`  (one-click re-auth UI)
 *
 * Together they implement the "MCP Auth Manager v2" — Phase 3.1 of Jarvis.
 */

import { logger } from "./logger";
import { listMcpStatus, refreshMcpStatus } from "./mcp-status";

const log = logger.child({ module: "mcp-health-monitor" });

/** How often to poll. 6h is conservative — most OAuth tokens have 24h+ TTL. */
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Initial probe runs this long after boot (lets the router warm up + status cache populate). */
const INITIAL_DELAY_MS = 60_000;

let intervalHandle: NodeJS.Timeout | null = null;
let initialHandle: NodeJS.Timeout | null = null;

/** Notification suppression: don't spam every 6h with the same problem. */
const lastAlerted: Map<string, number> = new Map();
const ALERT_REPEAT_MS = 24 * 60 * 60 * 1000; // re-alert at most once/day per server

async function tick(): Promise<void> {
  try {
    await refreshMcpStatus();
    const servers = listMcpStatus();
    const needsAuth = servers.filter((s) => s.status === "auth");
    const failed = servers.filter((s) => s.status === "failed");

    if (needsAuth.length === 0 && failed.length === 0) {
      log.debug(
        { connected: servers.filter((s) => s.status === "connected").length },
        "[mcp-health] all OK",
      );
      // Reset suppression so a re-occurrence in the future does alert.
      lastAlerted.clear();
      return;
    }

    const now = Date.now();
    const problems = [...needsAuth, ...failed].filter((s) => {
      const last = lastAlerted.get(s.name) ?? 0;
      return now - last > ALERT_REPEAT_MS;
    });

    if (problems.length === 0) {
      log.debug({ needsAuth: needsAuth.length, failed: failed.length }, "[mcp-health] problems exist but already alerted recently");
      return;
    }

    const names = problems.map((s) => `${s.name} (${s.status})`).join(", ");
    const summary = `${problems.length} MCP server(s) need attention: ${names}`;
    log.warn(
      { problems: problems.map((p) => ({ name: p.name, status: p.status })) },
      `🔐 ${summary}. Re-auth in the dashboard Tools tab.`,
    );

    for (const p of problems) lastAlerted.set(p.name, now);
  } catch (err) {
    log.error({ err }, "[mcp-health] poll failed");
  }
}

/** Start the periodic monitor. Safe to call multiple times — idempotent. */
export function startMcpHealthMonitor(): void {
  if (intervalHandle) return;
  log.info({ intervalMs: POLL_INTERVAL_MS, initialDelayMs: INITIAL_DELAY_MS }, "MCP Health Monitor starting");
  initialHandle = setTimeout(tick, INITIAL_DELAY_MS);
  intervalHandle = setInterval(tick, POLL_INTERVAL_MS);
}

/** Stop and clear handles. Used during graceful shutdown. */
export function stopMcpHealthMonitor(): void {
  if (initialHandle) {
    clearTimeout(initialHandle);
    initialHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
