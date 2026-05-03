import { config as loadDotEnv } from "dotenv";
import { join } from "path";

// Load .env before anything else
loadDotEnv({ path: join(import.meta.dirname ?? __dirname, "..", ".env") });

import { loadConfig, watchConfig, onConfigChange, expandHome } from "./services/config-loader";
import { startDashboard } from "./dashboard/server";
import { WhatsAppConnector, TelegramConnector, DiscordConnector } from "./connectors";
import type { Connector } from "./connectors";
import { initCrons, stopCrons, setDeliveryFn } from "./services/cron";
import { acquirePid, releasePid } from "./services/pid";
import { logger } from "./services/logger";
import { activeCount, activeJobs, loadPersistedJobs, clearPersistedJobs, type PendingJob } from "./services/pending-jobs";
import { killAllProcesses } from "./services/claude";
import { ensureHooksInstalled } from "./services/localSessions";
import { startMcpStatusWatcher } from "./services/mcp-status";

const log = logger.child({ module: "main" });

const connectors: Connector[] = [];

/**
 * Retry strategy for connector.start() on transient failures (e.g. DNS not yet
 * available when WiFi comes up after the router does).
 *
 * Delays (exponential-ish): 5 s → 15 s → 45 s → 2 min → 5 min.
 * After all attempts are exhausted we log an error and return — we deliberately
 * don't throw so the router keeps running for the other connectors.
 *
 * Callers fire-and-forget this (no await) so it never blocks the main startup
 * path; initCrons / setDeliveryFn run immediately as usual.
 */
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000, 120_000, 300_000];

async function startWithRetry(
  connector: { start: () => Promise<void>; channel: string },
  opts: { attempts?: number; baseDelayMs?: number } = {},
): Promise<void> {
  const maxAttempts = opts.attempts ?? RETRY_DELAYS_MS.length + 1; // 6 total (1 immediate + 5 retries)
  const delays = RETRY_DELAYS_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await connector.start();
      if (attempt > 1) {
        log.info({ channel: connector.channel, attempt }, "Connector started successfully after retry");
      }
      return;
    } catch (err) {
      const isLast = attempt >= maxAttempts;
      if (isLast) {
        log.error(
          { err, channel: connector.channel, attempts: maxAttempts },
          `Connector ${connector.channel} permanently failed to start after ${maxAttempts} attempts`,
        );
        return;
      }
      const delayMs = delays[attempt - 1] ?? delays[delays.length - 1];
      const delaySec = Math.round(delayMs / 1000);
      log.warn(
        { err: (err as Error)?.message, channel: connector.channel, attempt, nextRetryInSec: delaySec },
        `Connector ${connector.channel} failed to start (attempt ${attempt}/${maxAttempts}), retrying in ${delaySec}s`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  log.info("Jarvis Router starting...");

  // PID management
  acquirePid();

  const config = await loadConfig();

  // Start enabled connectors — fire-and-forget with exponential-backoff retry so
  // the router is UP immediately even if a channel (e.g. Telegram, Discord) can't
  // reach its API yet because WiFi / DNS came up after us.
  if (config.channels.whatsapp?.enabled) {
    const wa = new WhatsAppConnector(config);
    connectors.push(wa);
    startWithRetry(wa).catch((err) =>
      log.error({ err, channel: "whatsapp" }, "startWithRetry unexpectedly threw"),
    );
  }

  if (config.channels.telegram?.enabled) {
    const tg = new TelegramConnector(config);
    connectors.push(tg);
    startWithRetry(tg).catch((err) =>
      log.error({ err, channel: "telegram" }, "startWithRetry unexpectedly threw"),
    );
  }

  if (config.channels.discord?.enabled) {
    const dc = new DiscordConnector(config);
    connectors.push(dc);
    startWithRetry(dc).catch((err) =>
      log.error({ err, channel: "discord" }, "startWithRetry unexpectedly threw"),
    );
  }

  // Set up cron delivery function
  setDeliveryFn(async (channel: string, target: string, text: string) => {
    for (const c of connectors) {
      if (c.channel === channel) {
        await (c as any).sendMessage?.(target, text);
        return;
      }
    }
    log.warn({ channel, target }, "No connector found for cron delivery");
  });

  // Initialize cron jobs
  initCrons(config);

  // Watch config for hot-reload
  watchConfig();
  onConfigChange((newConfig) => {
    log.info("Config changed — connectors will use new routes on next message");
    initCrons(newConfig);
  });

  // Graceful shutdown — wait for in-flight Claude calls to finish so users get their replies.
  // If they can't finish in time, notify them they'll need to retry.
  let shuttingDown = false;
  const SHUTDOWN_GRACE_MS = 60_000;
  const SHUTDOWN_POLL_MS = 1_000;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Snapshot jobs active at shutdown moment — only wait for THESE.
    // New jobs that sneak in after won't block us (they'll get a "shutdown" notice if still pending).
    const snapshot = new Set(activeJobs().map((j) => j.id));
    log.info({ signal, pending: snapshot.size }, "Shutting down — waiting for in-flight jobs");
    stopCrons();

    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    const stillActive = () => activeJobs().filter((j) => snapshot.has(j.id));
    while (stillActive().length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SHUTDOWN_POLL_MS));
    }

    // Notify anyone still pending — both the snapshot ones that didn't finish,
    // AND any new jobs that started during the grace period (they won't complete either).
    const toNotify = activeJobs();
    if (toNotify.length > 0) {
      log.warn({ count: toNotify.length }, "Grace period expired — notifying users of interruption");
      await Promise.allSettled(toNotify.map((job) => notifyInterruption(job, "shutdown")));
    } else {
      log.info("All in-flight jobs completed before shutdown");
    }

    killAllProcesses();
    releasePid();
    await Promise.allSettled(connectors.map((c) => c.stop()));
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

  log.info("Jarvis Router ready — %d connectors active", connectors.length);

  // Install jarvis-control status hooks for local session discovery.
  // Best-effort — failure just means the dashboard falls back to heuristic status.
  ensureHooksInstalled().catch((err) => log.warn({ err }, "hook install failed"));

  // Cache MCP server health (claude mcp list) so buildSdkOptions can skip
  // needs-auth / failed servers BEFORE spawning sessions, avoiding OAuth
  // popup loops. Refreshes every 60s + on-demand from dashboard endpoints.
  startMcpStatusWatcher();

  // Start dashboard
  startDashboard(3340);

  // Recovery: if the previous process died mid-call, notify affected users.
  // Done after connectors are started so sendMessage() calls work.
  // Small delay to let connectors fully establish (Telegram polling, WhatsApp socket, Discord ready).
  setTimeout(() => { void runRecovery(); }, 5_000);
}

/** Look at persisted pending-jobs from the previous process run and send recovery notices */
async function runRecovery(): Promise<void> {
  const stale = loadPersistedJobs();
  if (stale.length === 0) return;

  // Skip jobs older than 24h — probably the router was down for a long time and the notice would be confusing
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const fresh = stale.filter((j) => j.startedAt >= cutoff);

  if (fresh.length === 0) {
    log.info({ total: stale.length }, "Stale pending jobs found, all >24h old — skipping recovery notices");
    clearPersistedJobs();
    return;
  }

  log.info({ count: fresh.length }, "Sending recovery notices for jobs interrupted by previous shutdown/crash");
  await Promise.allSettled(fresh.map((job) => notifyInterruption(job, "recovery")));
  clearPersistedJobs();
}

/** Notify a user that the router was interrupted mid-call. Safe to call during both shutdown and startup. */
async function notifyInterruption(job: PendingJob, reason: "shutdown" | "recovery"): Promise<void> {
  const connector = connectors.find((c) => c.channel === job.channel) as Connector & {
    sendMessage?: (target: string, text: string) => Promise<void>;
  } | undefined;

  if (!connector?.sendMessage) {
    log.warn({ job, reason }, "No connector with sendMessage — cannot notify");
    return;
  }

  const preview = job.userText ? `\n\n> ${job.userText.slice(0, 120)}${job.userText.length > 120 ? "…" : ""}` : "";
  const text = reason === "shutdown"
    ? `› mi sto riavviando e non ho fatto in tempo a rispondere. Riscrivimi tra pochi secondi.${preview}`
    : `› mi sono riavviato mentre stavo elaborando la tua richiesta. Non sono riuscito a completare la risposta — riscrivimi quando vuoi.${preview}`;

  try {
    await connector.sendMessage(job.target, text);
    log.info({ channel: job.channel, target: job.target, reason }, "Interruption notice sent");
  } catch (err) {
    log.error({ err, job, reason }, "Failed to send interruption notice");
  }
}

main().catch((err) => {
  log.fatal({ err }, "Fatal error");
  releasePid();
  process.exit(1);
});
