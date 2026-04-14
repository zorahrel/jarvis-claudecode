/**
 * Pending jobs — tracks in-flight Claude calls so we can notify users
 * if the router restarts before a response is delivered.
 *
 * Flow:
 *  - handler starts a job before askClaude()
 *  - handler ends the job after successful reply (or on error — we already replied)
 *  - On graceful shutdown: index.ts waits for active jobs to finish (up to grace period)
 *  - On startup: index.ts reads any still-pending jobs from disk and sends recovery notices
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { logger } from "./logger";

const log = logger.child({ module: "pending-jobs" });

const FILE = join(process.cwd(), "data", "pending-jobs.json");

export type PendingChannel = "telegram" | "whatsapp" | "discord";

export interface PendingJob {
  id: string;
  channel: PendingChannel;
  /** Platform-specific reply target (chat_id for telegram, jid for whatsapp, channel.id for discord) */
  target: string;
  /** First ~200 chars of user message — lets us reference what we were working on */
  userText: string;
  startedAt: number;
}

/** In-memory mirror — single source of truth while router is running */
const active = new Map<string, PendingJob>();

function ensureDir(): void {
  const dir = dirname(FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function persist(): void {
  try {
    ensureDir();
    writeFileSync(FILE, JSON.stringify([...active.values()]), "utf-8");
  } catch (err) {
    log.error({ err }, "Failed to persist pending jobs");
  }
}

/** Read persisted jobs from disk — used ONLY at startup for recovery */
export function loadPersistedJobs(): PendingJob[] {
  try {
    if (!existsSync(FILE)) return [];
    const raw = readFileSync(FILE, "utf-8");
    const parsed = JSON.parse(raw) as PendingJob[];
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (err) {
    log.error({ err }, "Failed to load pending jobs");
    return [];
  }
}

/** Remove the persisted file — called after recovery notices are sent */
export function clearPersistedJobs(): void {
  try {
    if (existsSync(FILE)) unlinkSync(FILE);
  } catch (err) {
    log.error({ err }, "Failed to clear pending jobs file");
  }
}

export function startJob(job: PendingJob): void {
  active.set(job.id, job);
  persist();
}

export function endJob(id: string): void {
  if (active.delete(id)) {
    persist();
  }
}

export function activeJobs(): PendingJob[] {
  return [...active.values()];
}

export function activeCount(): number {
  return active.size;
}
