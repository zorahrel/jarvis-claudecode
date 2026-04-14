import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, statSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { logger } from "../services/logger";

const log = logger.child({ module: "dashboard" });
const HOME = process.env.HOME!;

// ============================================================
// SHARED STATE
// ============================================================

// ── Persistent log system ──
// Appends each log as a JSON line to disk. Rotates by size.
// On boot, reloads the last MAX_LOGS entries from the current + rotated files.

export interface LogEntry {
  ts: number;
  level: string;
  module: string;
  msg: string;
  extra?: Record<string, unknown>;
}

const LOG_DIR = join(HOME, ".claude/jarvis/router/logs");
const LOG_FILE = join(LOG_DIR, "router.jsonl");
const MAX_LOGS = 500;           // in-memory buffer for dashboard
const MAX_FILE_BYTES = 5_000_000; // 5 MB per file before rotation
const MAX_ROTATED = 4;           // keep router.1.jsonl … router.4.jsonl

// Ensure log dir exists
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

const logEntries: LogEntry[] = [];

/** Rotate log files when current exceeds MAX_FILE_BYTES */
function rotateIfNeeded(): void {
  try {
    if (!existsSync(LOG_FILE)) return;
    const size = statSync(LOG_FILE).size;
    if (size < MAX_FILE_BYTES) return;

    // Shift existing rotated files: 4→delete, 3→4, 2→3, 1→2
    for (let i = MAX_ROTATED; i >= 1; i--) {
      const src = join(LOG_DIR, `router.${i}.jsonl`);
      if (!existsSync(src)) continue;
      if (i === MAX_ROTATED) {
        unlinkSync(src);
      } else {
        renameSync(src, join(LOG_DIR, `router.${i + 1}.jsonl`));
      }
    }
    // Current → 1
    renameSync(LOG_FILE, join(LOG_DIR, "router.1.jsonl"));
  } catch {}
}

/** Append a single log entry to disk */
function appendToDisk(entry: LogEntry): void {
  try {
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {}
}

/** Read the tail of a JSONL file, returning parsed entries */
function readJsonlTail(filePath: string, maxEntries: number): LogEntry[] {
  try {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.trimEnd().split("\n");
    const entries: LogEntry[] = [];
    // Read from the end to get the most recent first
    for (let i = lines.length - 1; i >= 0 && entries.length < maxEntries; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch { /* skip corrupt lines */ }
    }
    return entries.reverse(); // chronological order
  } catch {
    return [];
  }
}

/** Load last MAX_LOGS entries from current + rotated files on boot */
function loadPersistedLogs(): void {
  try {
    const allEntries: LogEntry[] = [];
    // Read rotated files oldest first (highest number = oldest)
    for (let i = MAX_ROTATED; i >= 1; i--) {
      const f = join(LOG_DIR, `router.${i}.jsonl`);
      if (allEntries.length >= MAX_LOGS) break;
      const entries = readJsonlTail(f, MAX_LOGS - allEntries.length);
      allEntries.push(...entries);
    }
    // Then current file
    if (allEntries.length < MAX_LOGS) {
      const entries = readJsonlTail(LOG_FILE, MAX_LOGS - allEntries.length);
      allEntries.push(...entries);
    }
    // Keep only the most recent MAX_LOGS
    const tail = allEntries.slice(-MAX_LOGS);
    logEntries.push(...tail);
  } catch {}
}

// Boot: load persisted logs
loadPersistedLogs();

export function pushLog(level: string, module: string, msg: string, extra?: Record<string, unknown>): void {
  const entry: LogEntry = { ts: Date.now(), level, module, msg, ...(extra && Object.keys(extra).length ? { extra } : {}) };
  logEntries.push(entry);
  if (logEntries.length > MAX_LOGS) logEntries.splice(0, logEntries.length - MAX_LOGS);

  // Persist to disk
  rotateIfNeeded();
  appendToDisk(entry);
}

export function getLogEntries(): LogEntry[] {
  return logEntries;
}

export function clearLogEntries(): void {
  logEntries.length = 0;
  // Also truncate the current log file
  try { writeFileSync(LOG_FILE, ""); } catch {}
}

let totalMessages = 0;
const messagesByChannel: Record<string, number> = {};

export function trackMessage(channel: string): void {
  totalMessages++;
  messagesByChannel[channel] = (messagesByChannel[channel] ?? 0) + 1;
}

export function getTotalMessages(): number {
  return totalMessages;
}

export function getMessagesByChannel(): Record<string, number> {
  return messagesByChannel;
}

export interface ResponseTime {
  ts: number;
  key: string;
  wallMs: number;
  apiMs: number;
  model: string;
}
const responseTimes: ResponseTime[] = [];
const MAX_RESPONSE_TIMES = 100;

export function trackResponseTime(key: string, wallMs: number, apiMs: number, model: string): void {
  responseTimes.push({ ts: Date.now(), key, wallMs, apiMs, model });
  if (responseTimes.length > MAX_RESPONSE_TIMES) responseTimes.splice(0, responseTimes.length - MAX_RESPONSE_TIMES);
}

export function getResponseTimes(): ResponseTime[] {
  return responseTimes;
}

// ---- Stats persistence ----
const STATS_FILE = join(HOME, ".claude/jarvis/router/stats.json");

function loadPersistedStats(): void {
  try {
    const raw = readFileSync(STATS_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (data.totalMessages) totalMessages = data.totalMessages;
    if (data.messagesByChannel) Object.assign(messagesByChannel, data.messagesByChannel);
    if (data.responseTimes && Array.isArray(data.responseTimes)) {
      responseTimes.push(...data.responseTimes.slice(-MAX_RESPONSE_TIMES));
    }
  } catch { /* first run or corrupt file — start fresh */ }
}

function persistStats(): void {
  try {
    const data = JSON.stringify({
      totalMessages,
      messagesByChannel,
      responseTimes: responseTimes.slice(-MAX_RESPONSE_TIMES),
      savedAt: Date.now(),
    });
    writeFileSync(STATS_FILE, data, "utf-8");
  } catch (err) { log.warn({ err }, "Failed to persist stats"); }
}

// Load immediately
loadPersistedStats();

// Save every 60 seconds
setInterval(persistStats, 60_000);

// Save on shutdown
process.on("beforeExit", persistStats);
process.on("SIGINT", () => { persistStats(); process.exit(0); });
process.on("SIGTERM", () => { persistStats(); process.exit(0); });

export interface CliSession {
  id: string;
  workspace: string;
  startedAt: number;
  lastSeen: number;
  alive: boolean;
}
const cliSessions = new Map<string, CliSession>();
const CLI_SESSIONS_FILE = join(HOME, ".claude/jarvis/router/cli-sessions.json");
// Sessions inactive for >12h are considered abandoned and pruned at load time.
const CLI_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
// Sessions inactive for >30min are flagged dead in API responses (but still listed until pruning).
const CLI_SESSION_STALE_MS = 30 * 60 * 1000;

function loadPersistedCliSessions(): void {
  try {
    const raw = readFileSync(CLI_SESSIONS_FILE, "utf-8");
    const arr = JSON.parse(raw) as CliSession[];
    if (!Array.isArray(arr)) return;
    const cutoff = Date.now() - CLI_SESSION_MAX_AGE_MS;
    for (const s of arr) {
      if (!s?.id || s.lastSeen < cutoff) continue;
      cliSessions.set(s.id, s);
    }
  } catch { /* first run or corrupt — start fresh */ }
}

function persistCliSessions(): void {
  try {
    writeFileSync(CLI_SESSIONS_FILE, JSON.stringify([...cliSessions.values()]), "utf-8");
  } catch (err) { log.warn({ err }, "Failed to persist CLI sessions"); }
}

loadPersistedCliSessions();
setInterval(persistCliSessions, 30_000);
process.on("beforeExit", persistCliSessions);
process.on("SIGINT", () => { persistCliSessions(); });
process.on("SIGTERM", () => { persistCliSessions(); });

export function getCliSessions(): CliSession[] {
  const now = Date.now();
  for (const [, s] of cliSessions) {
    if (now - s.lastSeen > CLI_SESSION_STALE_MS) s.alive = false;
  }
  return [...cliSessions.values()];
}

export function getCliSessionsMap(): Map<string, CliSession> {
  return cliSessions;
}

export function persistCliSessionsNow(): void {
  persistCliSessions();
}

// HTML cache
let htmlCache: { html: string; ts: number } | null = null;
const HTML_CACHE_TTL = 2000;

export function getHtmlCache() { return htmlCache; }
export function setHtmlCache(cache: { html: string; ts: number } | null) { htmlCache = cache; }
export function getHtmlCacheTtl() { return HTML_CACHE_TTL; }
export function invalidateHtmlCache(): void { htmlCache = null; }

// Constants
export const ROUTER_START = Date.now();
export const VERSION = "3.1.0";
