/**
 * Session cache — persists conversation exchanges to disk.
 * When a Claude persistent process restarts (inactivity timeout, crash, router restart),
 * the last N exchanges are injected as context into the new process.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { logger } from "./logger";

const log = logger.child({ module: "session-cache" });

const CACHE_DIR = join(process.cwd(), "data", "sessions");
const MAX_EXCHANGES = 10; // keep last 10 exchanges per session
const MAX_CHARS = 8000; // max chars for context injection (avoid blowing up prompt)

export interface Exchange {
  user: string;
  assistant: string;
  timestamp: number;
}

interface SessionData {
  exchanges: Exchange[];
}

export interface SessionThread {
  key: string;
  exchanges: Exchange[];
  truncated: boolean;
  total: number;
}

/** Ensure cache directory exists */
function ensureDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/** Sanitize session key for use as filename */
function keyToFile(key: string): string {
  return join(CACHE_DIR, key.replace(/[^a-zA-Z0-9_:-]/g, "_") + ".json");
}

/** Load session data from disk */
function loadSession(key: string): SessionData {
  try {
    const file = keyToFile(key);
    if (!existsSync(file)) return { exchanges: [] };
    const raw = readFileSync(file, "utf-8");
    return JSON.parse(raw) as SessionData;
  } catch {
    return { exchanges: [] };
  }
}

/** Save session data to disk */
function saveSession(key: string, data: SessionData): void {
  try {
    ensureDir();
    writeFileSync(keyToFile(key), JSON.stringify(data), "utf-8");
  } catch (err) {
    log.error({ err, key }, "Failed to save session cache");
  }
}

/** Record a completed exchange */
export function recordExchange(key: string, userMsg: string, assistantMsg: string): void {
  const data = loadSession(key);
  data.exchanges.push({
    user: userMsg.slice(0, 2000), // cap individual messages
    assistant: assistantMsg.slice(0, 3000),
    timestamp: Date.now(),
  });
  // Keep only last N
  if (data.exchanges.length > MAX_EXCHANGES) {
    data.exchanges = data.exchanges.slice(-MAX_EXCHANGES);
  }
  saveSession(key, data);
}

/**
 * Build a context summary from cached exchanges.
 * Returns a string to prepend to the first message of a new session,
 * or empty string if no history.
 */
export function buildContextFromCache(key: string): string {
  const data = loadSession(key);
  if (data.exchanges.length === 0) return "";

  // Build from most recent, respecting char budget
  const parts: string[] = [];
  let totalChars = 0;

  for (let i = data.exchanges.length - 1; i >= 0; i--) {
    const ex = data.exchanges[i];
    const block = `User: ${ex.user}\nAssistant: ${ex.assistant}`;
    if (totalChars + block.length > MAX_CHARS) break;
    parts.unshift(block);
    totalChars += block.length;
  }

  if (parts.length === 0) return "";

  return [
    "[Previous conversation context — you are resuming an ongoing session]",
    ...parts,
    "[End of previous context — new message follows]",
    "",
  ].join("\n\n");
}

/**
 * Load the last N exchanges for a session (read-only, for dashboard drill-down).
 * Returns null when the session file does not exist.
 */
export function loadSessionThread(key: string, limit = 50): SessionThread | null {
  if (!isValidKey(key)) return null;
  const file = keyToFile(key);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as SessionData;
    const all = Array.isArray(parsed.exchanges) ? parsed.exchanges : [];
    const total = all.length;
    const slice = limit > 0 && total > limit ? all.slice(-limit) : all;
    return {
      key,
      exchanges: slice,
      truncated: total > slice.length,
      total,
    };
  } catch (err) {
    log.warn({ err, key }, "Failed to load session thread");
    return { key, exchanges: [], truncated: false, total: 0 };
  }
}

/** Validate session key to prevent path traversal */
export function isValidKey(key: string): boolean {
  if (!key) return false;
  if (key.includes("..") || key.includes("/") || key.includes("\\")) return false;
  return /^[a-zA-Z0-9:+._-]+$/.test(key);
}

/** Clear session cache for a key */
export function clearSessionCache(key: string): void {
  try {
    const file = keyToFile(key);
    if (existsSync(file)) {
      unlinkSync(file);
    }
  } catch {}
}
