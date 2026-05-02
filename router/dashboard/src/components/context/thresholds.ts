/**
 * Threshold thresholds for the Context Inspector.
 * Per phase decision (01-CONTEXT.md): 50% / 75% / 90% — more aggressive than
 * paseo-mac 70/90 because Claude Code triggers compaction at 80%; the 75%
 * threshold scatters JUST before.
 *
 * < 50%      blue   #3b82f6  (safe)
 * 50% - 74%  yellow #eab308  (warn — green→yellow transition per CONTEXT.md decisions)
 * 75% - 89%  orange #f97316  (crit — fires JUST before Claude Code compaction at 80%)
 * ≥ 90%      red    #ef4444  (panic)
 */
export const THRESHOLDS = {
  warn: 0.5,
  crit: 0.75,
  panic: 0.9,
} as const

/** Returns a CSS color (hex) for a fill ratio (0..1+). */
export function colorForThreshold(ratio: number): string {
  if (ratio >= THRESHOLDS.panic) return '#ef4444'
  if (ratio >= THRESHOLDS.crit) return '#f97316'
  if (ratio >= THRESHOLDS.warn) return '#eab308'
  return '#3b82f6'
}

/** Italian label for the threshold tier, used in tooltips. */
export function labelForThreshold(ratio: number): string {
  if (ratio >= THRESHOLDS.panic) return 'Critico — vicinissimo a compaction'
  if (ratio >= THRESHOLDS.crit) return "Alto — compaction in arrivo all'80%"
  if (ratio >= THRESHOLDS.warn) return 'Medio — warn'
  return 'OK'
}

/** Format a token count: 87432 → "87.4k", 142000 → "142k", 234 → "234". */
export function formatTokens(n: number): string {
  if (n >= 100000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${n}`
}

/** Format USD: $0.0042 under $1, $1.23 above. Mirrors backend formatUsd. */
export function formatUsd(amount: number | undefined): string {
  if (typeof amount !== 'number') return '—'
  if (amount < 1) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(2)}`
}
