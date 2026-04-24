// Context-window awareness for Claude CLI sessions.
//
// The router already tracks token usage for cost reporting. This module maps
// model aliases/IDs to their context window size and exposes the compaction
// threshold check. It is intentionally dependency-free so that other services
// can call `shouldCompact` on any turn boundary without pulling config loaders.
//
// Values are in *tokens* (not bytes / chars). The fallback for unknown models
// is deliberately conservative (200k) — better one extra compaction than a
// silent truncation at the CLI edge.

const WINDOW_200K = 200_000;
const WINDOW_1M = 1_000_000;

/**
 * Return the context window size (in tokens) for a given model name.
 * Accepts alias ("opus", "sonnet", "haiku"), pinned IDs ("claude-opus-4-7"),
 * and 1M variants ("claude-opus-4-7[1m]", "opus[1m]").
 */
export function contextWindowFor(model: string): number {
  if (!model) return WINDOW_200K;
  const normalized = model.trim().toLowerCase();

  // 1M-context variants — explicit "[1m]" suffix on the model ID/alias.
  if (normalized.includes("[1m]")) return WINDOW_1M;

  // Aliases
  if (normalized === "opus" || normalized === "sonnet" || normalized === "haiku") {
    return WINDOW_200K;
  }

  // Pinned IDs
  if (normalized.startsWith("claude-opus-4-7")) return WINDOW_200K;
  if (normalized.startsWith("claude-sonnet-4-6")) return WINDOW_200K;
  if (normalized.startsWith("claude-haiku-4-5")) return WINDOW_200K;

  // Unknown — conservative fallback.
  return WINDOW_200K;
}

/**
 * Return true when cumulative input tokens cross the compaction threshold.
 * Default threshold is 80% of the model's context window.
 */
export function shouldCompact(
  usedTokens: number,
  model: string,
  threshold = 0.80,
): boolean {
  if (!Number.isFinite(usedTokens) || usedTokens <= 0) return false;
  const window = contextWindowFor(model);
  if (window <= 0) return false;
  return usedTokens / window >= threshold;
}
