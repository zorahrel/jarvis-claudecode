import type { TurnUsage, PricedModel, ModelRates, CostBreakdown } from "./types.js";

/**
 * Per-million-token rates (USD) for the Claude models the router uses.
 *
 * Verified from Anthropic pricing docs (2026-05):
 * - Sonnet 4.6 / 4.5: input $3 / output $15 per 1M tokens
 * - Opus  4.7:        input $5 / output $25 per 1M tokens
 * - Haiku 3.5:        input $0.80 / output $4 per 1M tokens
 *
 * Cache multipliers (per Anthropic prompt-caching docs):
 * - 5-min ephemeral cache write = 1.25× input rate
 * - 1-hour durable cache write  = 2.00× input rate
 * - cache read                  = 0.10× input rate
 *
 * The default cache TTL used by Claude Code is 5 minutes, so we apply the 5m
 * multiplier in costPerTurn(). Callers that know they're using 1-hour caching
 * should pass cache_creation_input_tokens through aggregateCost() with adjusted
 * rates (kept as a separate column on RATES so we can extend later without
 * breaking the wire shape).
 */
export const RATES: Record<PricedModel, ModelRates> = {
  sonnet: { input: 3,    cacheWrite5m: 3 * 1.25,    cacheWrite1h: 3 * 2,    cacheRead: 3 * 0.10,    output: 15 },
  opus:   { input: 5,    cacheWrite5m: 5 * 1.25,    cacheWrite1h: 5 * 2,    cacheRead: 5 * 0.10,    output: 25 },
  haiku:  { input: 0.80, cacheWrite5m: 0.80 * 1.25, cacheWrite1h: 0.80 * 2, cacheRead: 0.80 * 0.10, output: 4  },
};

/**
 * Compute the USD cost of a single turn given the raw usage breakdown.
 * Uses the 5-minute cache write multiplier (Claude Code default TTL).
 *
 * Formula:
 *   total = input × input_rate
 *         + cache_creation × cacheWrite5m
 *         + cache_read × cacheRead
 *         + output × output_rate
 * All rates are USD per 1M tokens, so we divide by 1_000_000.
 */
export function costPerTurn(usage: TurnUsage, model: PricedModel): CostBreakdown {
  const r = RATES[model];
  const inputUsd      = (usage.input_tokens                * r.input)       / 1_000_000;
  const cacheWriteUsd = (usage.cache_creation_input_tokens * r.cacheWrite5m) / 1_000_000;
  const cacheReadUsd  = (usage.cache_read_input_tokens     * r.cacheRead)    / 1_000_000;
  const outputUsd     = (usage.output_tokens               * r.output)       / 1_000_000;
  const totalUsd = inputUsd + cacheWriteUsd + cacheReadUsd + outputUsd;
  return { totalUsd, inputUsd, cacheWriteUsd, cacheReadUsd, outputUsd };
}

/** Sum the totalUsd of multiple turn cost breakdowns. */
export function aggregateCost(turns: CostBreakdown[]): number {
  let total = 0;
  for (const t of turns) total += t.totalUsd;
  return total;
}

/**
 * Format a USD amount for UI display.
 * - Sub-dollar values: 4 decimal places ($0.0042)
 * - Dollar+ values:    2 decimal places ($1.23)
 */
export function formatUsd(amount: number): string {
  if (amount < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
