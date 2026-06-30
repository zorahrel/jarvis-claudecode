/**
 * Pure turn-delivery decisions, extracted so they can be unit-tested without
 * spinning up the SDK session / dashboard / connectors.
 *
 * Root-cause fix they encode: a turn whose `result` event carried empty text
 * (agent ended after tool calls with no final synthesis, or a slash command
 * like /compact returning nothing) used to hit `if (!text) continue` and never
 * resolve — hanging askClaude until MESSAGE_TIMEOUT (30m) and stalling
 * compaction into COMPACT_TIMEOUT. The router must resolve EVERY turn except the
 * keep-warm idle sentinel, and always deliver SOMETHING to the channel.
 */

/** Keep-warm idle pings resolve to this exact text — the only result the router
 *  intentionally drops (it must never reach a real caller). */
export const KEEPWARM_SENTINEL = "waiting for message";

/** The ONLY result text the turn loop may skip. Empty text must NOT be skipped:
 *  it has to resolve so the caller never hangs. */
export function isKeepWarmSentinel(text: string): boolean {
  return text === KEEPWARM_SENTINEL;
}

/** Delivered when a turn resolved with no agent text, so the channel always gets
 *  a final reply instead of the start (reactions/typing) with nothing after. */
export const EMPTY_TURN_FALLBACK =
  "✓ fatto — l'agente ha completato il turno senza un messaggio finale.";

/** True when a turn produced real, deliverable text (not null/empty/whitespace). */
export function hasDeliverableText(rawText: string | null | undefined): boolean {
  return typeof rawText === "string" && rawText.trim().length > 0;
}
