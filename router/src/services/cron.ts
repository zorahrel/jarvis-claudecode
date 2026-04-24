import cronParser from "cron-parser";
const parseExpression = cronParser.parseExpression;
import { readFileSync, appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";
import type { CronJob, Config } from "../types";
import { askClaudeFresh, sessionKey } from "./claude";
import { expandHome, getAgentRegistry } from "./config-loader";
import { recordExchange } from "./session-cache";
import { logger } from "./logger";

const log = logger.child({ module: "cron" });

/** One line in the per-job JSONL run log. Fields mirror OpenClaw's schema so
 *  future tooling can stay consistent. The JSONL is the single source of truth
 *  for a job's history — in-memory state is rebuilt from it at boot. */
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
  /** Full Claude output (ok runs). Readers truncate for previews. */
  result?: string;
  /** Error message (non-ok runs). */
  error?: string;
  delivery?: { channel: string; target: string; ok: boolean; error?: string };
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  costUsd?: number;
}

/** In-memory snapshot of a job's latest status. Rehydrated from JSONL at boot;
 *  updated after each run. Not persisted separately — JSONL is the truth. */
export interface CronState {
  job: CronJob;
  lastRun: number;
  lastStatus: "ok" | "error" | "running" | "never";
  lastDurationMs: number;
  lastError: string | null;
  runCount: number;
  consecutiveErrors: number;
  lastDeliveryStatus: "ok" | "error" | "not-delivered" | null;
}

let cronStates: CronState[] = [];
let ticker: ReturnType<typeof setInterval> | null = null;

/** Delivery callback — set by index.ts to send messages to connectors. */
let deliverFn: ((channel: string, target: string, text: string) => Promise<void>) | null = null;

export function setDeliveryFn(fn: (channel: string, target: string, text: string) => Promise<void>): void {
  deliverFn = fn;
}

/** Expose the current delivery function — consumed by the notify endpoint so
 *  proactive notifications go through the same connector routing as cron. */
export function getDeliveryFn(): ((channel: string, target: string, text: string) => Promise<void>) | null {
  return deliverFn;
}

// ---- Paths ----
const CRON_RUNS_DIR = `${homedir()}/.claude/jarvis/router/cron/runs`;

/** Soft cap on JSONL file size. When exceeded, the file is rotated to `.1`. */
const RUNS_FILE_SOFT_CAP_BYTES = 2 * 1024 * 1024; // ~5k runs

function ensureDirs(): void {
  try { mkdirSync(CRON_RUNS_DIR, { recursive: true }); } catch { /* exists */ }
}

/** Make the job name safe for use as a filename. */
function runFileFor(jobName: string): string {
  const safe = jobName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(CRON_RUNS_DIR, `${safe}.jsonl`);
}

/** Append one run record to the per-job JSONL log. */
function appendRun(run: CronRun): void {
  ensureDirs();
  const file = runFileFor(run.jobName);
  try {
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
    return recent
      .map(l => { try { return JSON.parse(l) as CronRun; } catch { return null; } })
      .filter((r): r is CronRun => r !== null);
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

/** Rehydrate in-memory state from the tail of the JSONL log. JSONL is the
 *  source of truth; the state is a cache for fast dashboard reads. */
function hydrateFromJsonl(state: CronState): void {
  const runs = listCronRuns(state.job.name, 200);
  if (runs.length === 0) return;
  state.runCount = runs.length;
  // runs are newest-first; count error streak from the head.
  let streak = 0;
  for (const r of runs) {
    if (r.status === "ok") break;
    streak++;
  }
  state.consecutiveErrors = streak;
  const last = runs[0];
  state.lastRun = last.runAtMs;
  state.lastStatus = last.status === "ok" ? "ok" : "error";
  state.lastDurationMs = last.durationMs;
  state.lastError = last.error ?? null;
  state.lastDeliveryStatus = last.delivery
    ? (last.delivery.ok ? "ok" : "error")
    : (state.job.delivery ? "not-delivered" : null);
}

/** Initialize cron jobs from config. */
export function initCrons(config: Config): void {
  if (ticker) clearInterval(ticker);
  cronStates = [];

  if (!config.crons || config.crons.length === 0) {
    log.info("No cron jobs configured");
    return;
  }

  for (const job of config.crons) {
    const state: CronState = {
      job: { ...job, workspace: expandHome(job.workspace) },
      lastRun: 0,
      lastStatus: "never",
      lastDurationMs: 0,
      lastError: null,
      runCount: 0,
      consecutiveErrors: 0,
      lastDeliveryStatus: null,
    };
    hydrateFromJsonl(state);
    cronStates.push(state);
    log.info({ name: job.name, schedule: job.schedule, runs: state.runCount }, "Cron job registered");
  }

  ticker = setInterval(() => tick(), 60_000);
  log.info("Cron ticker started (%d jobs)", cronStates.length);
}

export function stopCrons(): void {
  if (ticker) { clearInterval(ticker); ticker = null; }
}

export function getCronStates(): CronState[] {
  return cronStates;
}

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

/** Check all jobs and run the ones that are due. */
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
    // Cron runs are subagents — no identity of their own, no notify binding.
    isSubagent: true,
  });
  const durationMs = Date.now() - startMs;

  let deliveryRecord: CronRun["delivery"] | undefined;

  if (res.status === "ok") {
    state.lastStatus = "ok";
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
        // sees the cron message as its own previous turn. Uses the chat handler's
        // session-key shape so the cache is unified with the normal thread.
        const isGroup = job.delivery.target.includes("@g.us");
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
}
