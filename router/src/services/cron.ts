import cronParser from "cron-parser";
const parseExpression = cronParser.parseExpression;
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { basename } from "path";
import type { CronJob, Config } from "../types";
import { askClaudeFresh, sessionKey } from "./claude";
import { expandHome, getAgentRegistry } from "./config-loader";
import { recordExchange } from "./session-cache";
import { logger } from "./logger";

const log = logger.child({ module: "cron" });

/** One line in the per-job JSONL run log. Fields mirror OpenClaw's schema
 *  (see ~/.openclaw/cron/runs/*.jsonl) so future tooling can stay consistent. */
export interface CronRun {
  ts: number;
  jobName: string;
  trigger: "schedule" | "manual";
  status: "ok" | "error" | "timeout";
  runAtMs: number;
  durationMs: number;
  nextRunAtMs?: number;
  model?: string;
  sessionId?: string;
  /** Short preview (first ~240 chars) shown collapsed in the UI. */
  summary?: string;
  /** Full Claude output — not length-capped. Shown in the expanded run view. */
  result?: string;
  error?: string;
  delivery?: { channel: string; target: string; ok: boolean; error?: string };
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  costUsd?: number;
}

export interface CronState {
  job: CronJob;
  lastRun: number;
  lastStatus: "ok" | "error" | "running" | "never";
  lastDurationMs: number;
  lastError: string | null;
  lastResult: string | null;
  runCount: number;
  consecutiveErrors: number;
  lastDeliveryStatus: "ok" | "error" | "not-delivered" | null;
}

let cronStates: CronState[] = [];
let ticker: ReturnType<typeof setInterval> | null = null;

/** Delivery callback — set by index.ts to send messages to connectors */
let deliverFn: ((channel: string, target: string, text: string) => Promise<void>) | null = null;

export function setDeliveryFn(fn: (channel: string, target: string, text: string) => Promise<void>): void {
  deliverFn = fn;
}

// ---- Paths ----
const CRON_DIR = `${homedir()}/.claude/jarvis/router/cron`;
const CRON_STATS_FILE = `${CRON_DIR}/stats.json`;
const CRON_RUNS_DIR = `${CRON_DIR}/runs`;
// Legacy path (pre-2026-04-16) — migrated on first load.
const LEGACY_STATS_FILE = `${homedir()}/.claude/jarvis/router/cron-stats.json`;

/** Soft cap on JSONL file size. When exceeded, the file is rotated to `.1`. */
const RUNS_FILE_SOFT_CAP_BYTES = 2 * 1024 * 1024; // 2MB — ~5k runs

function ensureDirs(): void {
  try { mkdirSync(CRON_RUNS_DIR, { recursive: true }); } catch { /* exists */ }
}

/** Make the job name safe for use as a filename. */
function runFileFor(jobName: string): string {
  const safe = jobName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(CRON_RUNS_DIR, `${safe}.jsonl`);
}

// ---- Cron stats persistence ----
function loadCronStats(): void {
  ensureDirs();
  // One-shot migration from the pre-refactor flat file.
  if (!existsSync(CRON_STATS_FILE) && existsSync(LEGACY_STATS_FILE)) {
    try {
      renameSync(LEGACY_STATS_FILE, CRON_STATS_FILE);
      log.info("Migrated legacy cron-stats.json → cron/stats.json");
    } catch (err) {
      log.warn({ err }, "Legacy cron-stats migration failed");
    }
  }
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
        state.consecutiveErrors = saved.consecutiveErrors || 0;
        state.lastDeliveryStatus = saved.lastDeliveryStatus || null;
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
        consecutiveErrors: s.consecutiveErrors,
        lastDeliveryStatus: s.lastDeliveryStatus,
      };
    }
    writeFileSync(CRON_STATS_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch { /* ignore write errors */ }
}

/** Append one run record to the per-job JSONL log. */
function appendRun(run: CronRun): void {
  ensureDirs();
  const file = runFileFor(run.jobName);
  try {
    // Rotate if the file is getting too big.
    if (existsSync(file)) {
      const size = statSync(file).size;
      if (size > RUNS_FILE_SOFT_CAP_BYTES) {
        renameSync(file, `${file}.1`);
        log.info({ jobName: run.jobName }, "Rotated cron runs JSONL (>2MB)");
      }
    }
    appendFileSync(file, JSON.stringify(run) + "\n", "utf-8");
  } catch (err) {
    log.warn({ err, jobName: run.jobName }, "Failed to append cron run");
  }
}

/** Read the last N runs for a job, newest first. */
export function listCronRuns(jobName: string, limit = 50): CronRun[] {
  const file = runFileFor(jobName);
  if (!existsSync(file)) return [];
  try {
    const raw = readFileSync(file, "utf-8");
    const lines = raw.split("\n").filter(l => l.trim().length > 0);
    const recent = lines.slice(-limit).reverse();
    return recent.map(l => {
      try { return JSON.parse(l) as CronRun; } catch { return null; }
    }).filter((r): r is CronRun => r !== null);
  } catch {
    return [];
  }
}

/** Delete all run history for a job. Called when a job is removed from config. */
export function deleteCronRuns(jobName: string): void {
  const file = runFileFor(jobName);
  try {
    if (existsSync(file)) renameSync(file, `${file}.deleted.${Date.now()}`);
    const rotated = `${file}.1`;
    if (existsSync(rotated)) renameSync(rotated, `${rotated}.deleted.${Date.now()}`);
  } catch { /* ignore */ }
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
      consecutiveErrors: 0,
      lastDeliveryStatus: null,
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
  runJob(state, "manual").catch((err) => {
    log.error({ err, name }, "Manual cron trigger failed");
  });
  return { ok: true };
}

/** Compute the next run time for a cron expression, for UI + run record. */
function nextFireMs(state: CronState, after: Date = new Date()): number | undefined {
  try {
    const expr = parseExpression(state.job.schedule, {
      tz: state.job.timezone ?? "UTC",
      currentDate: after,
    });
    return expr.next().getTime();
  } catch { return undefined; }
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
        runJob(state, "schedule").catch((err) => {
          log.error({ err, name: state.job.name }, "Cron job failed");
        });
      }
    } catch (err) {
      log.error({ err, name: state.job.name }, "Cron expression error");
    }
  }
}

/** Execute a single cron job with state tracking */
async function runJob(state: CronState, trigger: "schedule" | "manual"): Promise<void> {
  const job = state.job;
  log.info({ name: job.name, trigger }, "Running cron job");

  state.lastStatus = "running";
  state.lastRun = Date.now();
  state.lastError = null;
  const startMs = Date.now();

  const timeoutMs = (job.timeout ?? 300) * 1000;
  // Cron inherits the agent's tool/permission config from agent.yaml — same model
  // as OpenClaw, where each job points to an agentId and the agent dictates access.
  const agentName = basename(job.workspace);
  const agent = getAgentRegistry()[agentName];
  const res = await askClaudeFresh(job.workspace, job.prompt, job.model ?? agent?.model, timeoutMs, {
    fullAccess: agent?.fullAccess,
    tools: agent?.tools,
    agentEnv: agent?.env,
    inheritUserScope: agent?.inheritUserScope,
  });
  const durationMs = Date.now() - startMs;

  // Core state + run record shared fields.
  let deliveryRecord: CronRun["delivery"] | undefined;

  if (res.status === "ok") {
    state.lastStatus = "ok";
    state.lastResult = res.result;
    state.consecutiveErrors = 0;
    log.info({ name: job.name, durationMs, resultLen: res.result.length }, "Cron job completed");

    if (job.delivery && deliverFn) {
      try {
        // Match the chat footer convention from _shared/AGENTS.md:
        // [t 10.8s | llm 10.7s | tok 22.1k>132 | agent/model]
        const inTok = res.usage?.input_tokens ?? 0;
        const outTok = res.usage?.output_tokens ?? 0;
        const fmtTok = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
        const secs = (durationMs / 1000).toFixed(1);
        const shortModel = (res.model ?? job.model ?? "opus").replace(/^(claude-)?(.*?)(-\d.*)?$/, "$2") || "opus";
        const footer = `\n\n[t ${secs}s | llm ${secs}s | tok ${fmtTok(inTok)}>${fmtTok(outTok)} | ${agentName}/${shortModel}]`;
        await deliverFn(job.delivery.channel, job.delivery.target, res.result + footer);
        deliveryRecord = { channel: job.delivery.channel, target: job.delivery.target, ok: true };
        state.lastDeliveryStatus = "ok";
        log.info({ name: job.name, channel: job.delivery.channel, target: job.delivery.target }, "Cron result delivered");

        // Seed the agent's conversation cache so when the human replies the agent
        // sees the cron message as its own previous turn. Uses the same session
        // key the chat handler derives (channel:group or channel:from) — so the
        // cache is unified with the normal conversation thread.
        const isGroup = job.delivery.target.endsWith("@g.us") || job.delivery.target.includes("@g.us");
        const key = sessionKey(
          job.delivery.channel,
          job.delivery.target,
          isGroup ? job.delivery.target : undefined,
        );
        recordExchange(key, `[cron:${job.name}]`, res.result);
      } catch (err: any) {
        const errMsg = err?.message ?? String(err);
        deliveryRecord = { channel: job.delivery.channel, target: job.delivery.target, ok: false, error: errMsg };
        state.lastDeliveryStatus = "error";
        log.error({ err: errMsg, name: job.name }, "Failed to deliver cron result");
      }
    } else if (job.delivery) {
      state.lastDeliveryStatus = "not-delivered";
    }
  } else {
    state.lastStatus = "error";
    state.lastError = res.error ?? res.result;
    state.consecutiveErrors += 1;
    log.error({ err: state.lastError, name: job.name, status: res.status }, "Cron job error");
  }

  state.lastDurationMs = durationMs;
  state.runCount++;

  // Append the full record to the per-job JSONL (openclaw-style).
  const run: CronRun = {
    ts: Date.now(),
    jobName: job.name,
    trigger,
    status: res.status,
    runAtMs: startMs,
    durationMs,
    nextRunAtMs: nextFireMs(state),
    model: res.model,
    sessionId: res.sessionId,
    summary: res.status === "ok"
      ? (res.result.length > 240 ? res.result.slice(0, 240) + "…" : res.result)
      : undefined,
    result: res.status === "ok" ? res.result : undefined,
    error: res.status !== "ok" ? (res.error ?? res.result) : undefined,
    delivery: deliveryRecord,
    usage: res.usage ? {
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
      total_tokens: res.usage.total_tokens,
    } : undefined,
    costUsd: res.costUsd,
  };
  appendRun(run);

  persistCronStats();
}

/** List JSONL files that no longer correspond to any configured job. */
export function orphanRunFiles(): string[] {
  try {
    if (!existsSync(CRON_RUNS_DIR)) return [];
    const configured = new Set(cronStates.map(s => runFileFor(s.job.name)));
    return readdirSync(CRON_RUNS_DIR)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => join(CRON_RUNS_DIR, f))
      .filter(p => !configured.has(p));
  } catch {
    return [];
  }
}
