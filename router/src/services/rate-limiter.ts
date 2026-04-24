import crypto from "crypto";
import { getConfig } from "./config-loader";
import { logger } from "./logger";

const log = logger.child({ module: "rate-limiter" });

/** Sliding window: sender/channel → array of timestamps */
const incomingWindows = new Map<string, number[]>();
const outgoingWindows = new Map<string, number[]>();

function slidingWindowCheck(
  windows: Map<string, number[]>,
  key: string,
  maxMessages: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  let timestamps = windows.get(key);
  if (!timestamps) {
    timestamps = [];
    windows.set(key, timestamps);
  }

  // Remove expired
  while (timestamps.length > 0 && now - timestamps[0] > windowMs) {
    timestamps.shift();
  }

  if (timestamps.length >= maxMessages) {
    return false; // rate limited
  }

  timestamps.push(now);
  return true;
}

/** Check incoming rate limit. Returns true if allowed. */
export function checkIncomingRate(channel: string, from: string): boolean {
  const config = getConfig();
  const limits = config.rateLimits?.incoming;
  if (!limits) return true;

  const key = `${channel}:${from}`;
  const allowed = slidingWindowCheck(incomingWindows, key, limits.maxMessages, limits.windowSeconds * 1000);
  if (!allowed) {
    log.warn({ key }, "Incoming rate limit hit");
  }
  return allowed;
}

/** Check outgoing rate limit. Returns true if allowed. */
export function checkOutgoingRate(channel: string): boolean {
  const config = getConfig();
  const limits = config.rateLimits?.outgoing;
  if (!limits) return true;

  const allowed = slidingWindowCheck(outgoingWindows, channel, limits.maxMessages, limits.windowSeconds * 1000);
  if (!allowed) {
    log.warn({ channel }, "Outgoing rate limit hit");
  }
  return allowed;
}

// ---------------------------------------------------------------------------
// Notify-specific counters (S4 — Security/observability)
// ---------------------------------------------------------------------------

/** Sliding-window rate limiter for outbound notify calls, keyed by channel+target. */
const notifyRateWindows = new Map<string, number[]>();

/**
 * Per-(channel, target) sliding window for notify calls.
 * Default: 30 messages per minute.
 * Returns true if the call is allowed, false if rate-limited.
 */
export function checkNotifyRate(
  channel: string,
  target: string,
  limit = 30,
  windowMs = 60_000,
): boolean {
  const key = `${channel}:${target}`;
  const allowed = slidingWindowCheck(notifyRateWindows, key, limit, windowMs);
  if (!allowed) {
    log.warn({ channel, target, limit, windowMs }, "Notify rate limit hit");
  }
  return allowed;
}

/** Per-session cumulative budget counters (in-memory, reset on router restart). */
const notifyBudgetCounters = new Map<string, number>();

/**
 * Per-session cumulative budget for notify calls.
 * sessionKey format: "channel:target" or "channel:target:group" (matches token binding).
 * Default budget: 100 messages per session lifetime (router restart = reset).
 * Returns true if allowed, false if budget exhausted.
 */
export function checkNotifyBudget(sessionKey: string, limit = 100): boolean {
  const used = notifyBudgetCounters.get(sessionKey) ?? 0;
  if (used >= limit) {
    log.warn({ sessionKey, used, limit }, "Notify session budget exhausted");
    return false;
  }
  notifyBudgetCounters.set(sessionKey, used + 1);
  return true;
}

/**
 * Returns the number of notify calls remaining in the session budget.
 * Does not increment the counter.
 */
export function notifyBudgetRemaining(sessionKey: string, limit = 100): number {
  const used = notifyBudgetCounters.get(sessionKey) ?? 0;
  return Math.max(0, limit - used);
}

/**
 * Reset the notify budget for a session (e.g. on token revoke / process kill).
 */
export function resetNotifyBudget(sessionKey: string): void {
  notifyBudgetCounters.delete(sessionKey);
}

/** Dedup store: "${target}|${sha256(text)}" → timestamp of last send */
const notifyDedupStore = new Map<string, number>();

/**
 * Deduplication check for outbound notify messages.
 * Returns false (= drop) if the same text was sent to the same target within windowMs.
 * Returns true (= allow) otherwise, and records the hash.
 * Lazy GC: prunes expired entries on each call.
 */
export function checkNotifyDedup(target: string, text: string, windowMs = 5_000): boolean {
  const now = Date.now();
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  const dedupKey = `${target}|${hash}`;

  // Lazy GC: remove entries older than windowMs
  for (const [k, ts] of notifyDedupStore) {
    if (now - ts > windowMs) notifyDedupStore.delete(k);
  }

  if (notifyDedupStore.has(dedupKey)) {
    log.warn({ target, windowMs }, "Notify dedup: identical message dropped");
    return false;
  }

  notifyDedupStore.set(dedupKey, now);
  return true;
}
