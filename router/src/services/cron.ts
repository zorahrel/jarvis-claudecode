import cronParser from "cron-parser";
const parseExpression = cronParser.parseExpression;
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import type { CronJob, Config } from "../types";
import { askClaudeFresh } from "./claude";
import { expandHome } from "./config-loader";
import { logger } from "./logger";

const log = logger.child({ module: "cron" });

export interface CronState {
  job: CronJob;
  lastRun: number;
  lastStatus: "ok" | "error" | "running" | "never";
  lastDurationMs: number;
  lastError: string | null;
  lastResult: string | null;
  runCount: number;
}

let cronStates: CronState[] = [];
let ticker: ReturnType<typeof setInterval> | null = null;

/** Delivery callback — set by index.ts to send messages to connectors */
let deliverFn: ((channel: string, target: string, text: string) => Promise<void>) | null = null;

export function setDeliveryFn(fn: (channel: string, target: string, text: string) => Promise<void>): void {
  deliverFn = fn;
}

// ---- Cron stats persistence ----
const CRON_STATS_FILE = `${homedir()}/.claude/jarvis/router/cron-stats.json`;

function loadCronStats(): void {
  try {
    const raw = readFileSync(CRON_STATS_FILE, "utf-8");
    const data = JSON.parse(raw);
    for (const state of cronStates) {
      const saved = data[state.job.name];
      if (saved) {
        state.lastRun = saved.lastRun || 0;
        state.lastStatus = saved.lastStatus || "never";
        state.lastDurationMs = saved.lastDurationMs || 0;
        state.lastError = saved.lastError || null;
        state.lastResult = saved.lastResult || null;
        state.runCount = saved.runCount || 0;
      }
    }
  } catch { /* first run or corrupt file */ }
}

function persistCronStats(): void {
  try {
    const data: Record<string, any> = {};
    for (const s of cronStates) {
      data[s.job.name] = {
        lastRun: s.lastRun,
        lastStatus: s.lastStatus,
        lastDurationMs: s.lastDurationMs,
        lastError: s.lastError,
        lastResult: s.lastResult,
        runCount: s.runCount,
      };
    }
    writeFileSync(CRON_STATS_FILE, JSON.stringify(data), "utf-8");
  } catch { /* ignore write errors */ }
}

/** Initialize cron jobs from config */
export function initCrons(config: Config): void {
  if (ticker) clearInterval(ticker);
  cronStates = [];

  if (!config.crons || config.crons.length === 0) {
    log.info("No cron jobs configured");
    return;
  }

  for (const job of config.crons) {
    cronStates.push({
      job: { ...job, workspace: expandHome(job.workspace) },
      lastRun: 0,
      lastStatus: "never",
      lastDurationMs: 0,
      lastError: null,
      lastResult: null,
      runCount: 0,
    });
    log.info({ name: job.name, schedule: job.schedule }, "Cron job registered");
  }

  // Tick every 60 seconds
  ticker = setInterval(() => tick(), 60_000);
  log.info("Cron ticker started (%d jobs)", cronStates.length);

  // Restore persisted cron stats
  loadCronStats();
}

/** Stop cron ticker */
export function stopCrons(): void {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

/** Get all cron states for dashboard */
export function getCronStates(): CronState[] {
  return cronStates;
}

/** Trigger a cron job manually by name */
export async function triggerCronJob(name: string): Promise<{ ok: boolean; error?: string }> {
  const state = cronStates.find(s => s.job.name === name);
  if (!state) return { ok: false, error: "Job not found: " + name };
  if (state.lastStatus === "running") return { ok: false, error: "Job already running" };
  runJob(state).catch((err) => {
    log.error({ err, name }, "Manual cron trigger failed");
  });
  return { ok: true };
}

/** Check all jobs and run if due */
function tick(): void {
  const now = new Date();

  for (const state of cronStates) {
    if (state.lastStatus === "running") continue;
    try {
      const expr = parseExpression(state.job.schedule, {
        tz: state.job.timezone ?? "UTC",
        currentDate: now,
      });

      const prev = expr.prev().getTime();

      if (prev > state.lastRun && now.getTime() - prev < 90_000) {
        runJob(state).catch((err) => {
          log.error({ err, name: state.job.name }, "Cron job failed");
        });
      }
    } catch (err) {
      log.error({ err, name: state.job.name }, "Cron expression error");
    }
  }
}

/** Execute a single cron job with state tracking */
async function runJob(state: CronState): Promise<void> {
  const job = state.job;
  log.info({ name: job.name }, "Running cron job");

  state.lastStatus = "running";
  state.lastRun = Date.now();
  state.lastError = null;
  const startMs = Date.now();

  try {
    const timeoutMs = (job.timeout ?? 300) * 1000;
    const result = await askClaudeFresh(job.workspace, job.prompt, job.model, timeoutMs);

    state.lastDurationMs = Date.now() - startMs;
    state.lastStatus = "ok";
    state.lastResult = result.length > 500 ? result.slice(0, 500) + "..." : result;
    state.runCount++;
    log.info({ name: job.name, durationMs: state.lastDurationMs, resultLen: result.length }, "Cron job completed");

    if (job.delivery && deliverFn) {
      try {
        await deliverFn(job.delivery.channel, job.delivery.target, result);
        log.info({ name: job.name, channel: job.delivery.channel, target: job.delivery.target }, "Cron result delivered");
      } catch (err) {
        log.error({ err, name: job.name }, "Failed to deliver cron result");
      }
    }
  } catch (err: any) {
    state.lastDurationMs = Date.now() - startMs;
    state.lastStatus = "error";
    state.lastError = err?.message ?? String(err);
    state.runCount++;
    log.error({ err: state.lastError, name: job.name }, "Cron job error");
  }
  persistCronStats();
}
