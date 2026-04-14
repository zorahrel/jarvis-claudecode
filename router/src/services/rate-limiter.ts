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
