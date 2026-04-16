import type { CSSProperties } from 'react'

export type MetricTone = 'ok' | 'warn' | 'err' | 'muted'

const toneColor: Record<MetricTone, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  err: 'var(--err)',
  muted: 'var(--text-4)',
}

export type DurationThresholds = { warn: number; err: number }

export const DURATION_THRESHOLDS: Record<'llm' | 'overhead' | 'fast', DurationThresholds> = {
  llm: { warn: 120_000, err: 600_000 },
  overhead: { warn: 30_000, err: 120_000 },
  fast: { warn: 500, err: 2000 },
}

export type DurationPreset = keyof typeof DURATION_THRESHOLDS

/** Color thresholds in ms, matched top-down: the first predicate that returns true wins. */
export function durationTone(
  ms: number,
  thresholds: DurationThresholds = DURATION_THRESHOLDS.llm,
): MetricTone {
  if (!Number.isFinite(ms) || ms < 0) return 'muted'
  if (ms >= thresholds.err) return 'err'
  if (ms >= thresholds.warn) return 'warn'
  return 'ok'
}

/**
 * Human-readable duration. Returns value + unit split so callers can style them independently.
 * Ranges:
 *   <1s        → "850" ms
 *   <1min      → "12.4" s (one decimal)
 *   <1h        → "1m 07" s (minutes + zero-padded seconds)
 *   >=1h       → "1h 23" m (hours + zero-padded minutes)
 *   NaN / <0   → "—" ""
 */
export function formatDuration(ms: number): { value: string; unit: string } {
  if (!Number.isFinite(ms) || ms < 0) return { value: '\u2014', unit: '' }
  if (ms < 1000) return { value: String(Math.round(ms)), unit: 'ms' }
  if (ms < 60_000) return { value: (ms / 1000).toFixed(1), unit: 's' }
  if (ms < 3_600_000) {
    const totalSec = Math.floor(ms / 1000)
    const m = Math.floor(totalSec / 60)
    const s = totalSec % 60
    return { value: `${m}m ${String(s).padStart(2, '0')}`, unit: 's' }
  }
  const totalMin = Math.floor(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return { value: `${h}h ${String(m).padStart(2, '0')}`, unit: 'm' }
}

interface MetricBadgeProps {
  /** Raw value in ms. */
  value: number
  /** Override the auto-derived tone from thresholds. */
  tone?: MetricTone
  /** Explicit thresholds. Takes precedence over `preset`. Ignored when `tone` is set. */
  thresholds?: DurationThresholds
  /** Semantic preset for thresholds. Defaults to 'llm'. Overridden by `thresholds` if both set. */
  preset?: DurationPreset
  /** 'human' (default) → formatDuration; 'ms' → legacy `Math.round(ms)ms`. */
  format?: 'human' | 'ms'
  /** Manual unit override. Only applies in 'ms' format (defaults to 'ms'). */
  suffix?: string
  title?: string
  align?: 'left' | 'right'
  style?: CSSProperties
}

export function MetricBadge({
  value,
  tone,
  thresholds,
  preset = 'llm',
  format = 'human',
  suffix = 'ms',
  title,
  align = 'right',
  style,
}: MetricBadgeProps) {
  const effectiveThresholds = thresholds ?? DURATION_THRESHOLDS[preset]
  const resolvedTone: MetricTone = tone ?? durationTone(value, effectiveThresholds)

  let displayValue: string
  let displayUnit: string
  if (format === 'ms') {
    displayValue = Number.isFinite(value) && value >= 0 ? String(Math.round(value)) : '\u2014'
    displayUnit = Number.isFinite(value) && value >= 0 ? suffix : ''
  } else {
    const formatted = formatDuration(value)
    displayValue = formatted.value
    displayUnit = formatted.unit
  }

  const resolvedTitle =
    format === 'human' && title && Number.isFinite(value) && value >= 0
      ? `${title} (${Math.round(value)} ms)`
      : title

  return (
    <span
      title={resolvedTitle}
      style={{
        color: toneColor[resolvedTone],
        fontFamily: 'var(--mono)',
        fontVariantNumeric: 'tabular-nums',
        textAlign: align,
        display: 'inline-block',
        width: '100%',
        ...style,
      }}
    >
      {displayValue}
      {displayUnit && (
        <span style={{ color: 'var(--text-4)', marginLeft: 2, fontSize: 10 }}>{displayUnit}</span>
      )}
    </span>
  )
}
