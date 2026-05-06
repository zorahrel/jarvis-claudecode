/**
 * Shared types for the Context Inspector backend.
 * Pure type-only module — no runtime exports except CONTEXT_WINDOWS constant.
 *
 * Created in Wave 0 (Plan 01) so Plans 02/03/04 can all import from here
 * without depending on each other — true parallel execution.
 */

/** Per-turn raw usage as emitted by the SDK `result` event or the last `assistant` line in a JSONL transcript. */
export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Subset of model identifiers we price. Wider strings (e.g. "claude-sonnet-4-6") map to one of these via normalizeModel(). */
export type PricedModel = "sonnet" | "opus" | "haiku";

/** Per-million-token rates in USD for a given model. */
export interface ModelRates {
  /** USD per 1M fresh input tokens. */
  input: number;
  /** USD per 1M tokens written to ephemeral 5-min cache (= 1.25 × input). */
  cacheWrite5m: number;
  /** USD per 1M tokens written to 1-hour cache (= 2 × input). */
  cacheWrite1h: number;
  /** USD per 1M tokens read from cache (= 0.1 × input). */
  cacheRead: number;
  /** USD per 1M output tokens. */
  output: number;
}

/** Result of costPerTurn(): split shows where the dollars went. */
export interface CostBreakdown {
  /** Total USD cost for the turn. */
  totalUsd: number;
  /** USD spent on fresh input (non-cached). */
  inputUsd: number;
  /** USD spent writing to cache (default ephemeral 5-min). */
  cacheWriteUsd: number;
  /** USD saved-equivalent on cache reads (charged at 0.1× input). */
  cacheReadUsd: number;
  /** USD spent on output. */
  outputUsd: number;
}

/** What we know about a session's live token usage at a point in time. */
export interface LiveTokenSnapshot {
  /** Total context tokens currently used (the "headline" number against 200k window). */
  totalTokens: number;
  /** Source signal that produced this snapshot. */
  source: "sdk-task-progress" | "sdk-result" | "jsonl-tail" | "unknown";
  /** Wall-clock ms when this snapshot was generated. */
  capturedAt: number;
  /** Model context window in tokens (e.g. 200000 for Sonnet 4.6). */
  contextWindow: number;
  /** Last per-turn raw usage available (null if no turn finished yet). */
  lastTurnUsage: TurnUsage | null;
}

/** Minimal shape of a router-side SdkSession that tokenSource needs. Avoids importing claude.ts to prevent cycles. */
export interface SdkSessionLike {
  sessionKey: string;
  resolvedModel: string | null;
  totalInputTokens: number;
  compactionCount: number;
  alive: boolean;
}

/** Categories of the 8-way breakdown used by Plan 03. Re-exported here so all downstream code shares the same enum. */
export type BreakdownCategory =
  | "system_preset"
  | "builtin_tools"
  | "mcp_servers"
  | "skills_index"
  | "claudemd_chain"
  | "subagents"
  | "hooks_memory"
  | "history";

/** Constant mapping: model → context window size in tokens. */
export const CONTEXT_WINDOWS: Record<PricedModel, number> = {
  sonnet: 200000,
  opus: 200000,
  haiku: 200000,
};
