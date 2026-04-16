import { useEffect, useState } from 'react'

function formatAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '…'
  if (ms < 1_500) return 'now'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  return `${Math.round(ms / 3_600_000)}h ago`
}

interface LiveIndicatorProps {
  lastFetch: number
  /** After this many ms since lastFetch, we assume polling stopped / failed. */
  staleAfterMs?: number
}

export function LiveIndicator({ lastFetch, staleAfterMs = 30_000 }: LiveIndicatorProps) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const age = lastFetch > 0 ? now - lastFetch : Number.POSITIVE_INFINITY
  const stale = age > staleAfterMs
  const color = stale ? 'var(--warn)' : 'var(--ok)'

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        fontFamily: 'var(--mono)',
        color: 'var(--text-4)',
        padding: '0 6px',
      }}
      title={stale ? 'Polling seems stale' : 'Live polling'}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
          boxShadow: `0 0 6px ${color}`,
          animation: stale ? 'none' : 'jarvisPulse 1.6s ease-in-out infinite',
        }}
      />
      {stale ? 'Stale' : 'Live'} · updated {formatAgo(age)}
      <style>{`
        @keyframes jarvisPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.45; transform: scale(1.3); }
        }
      `}</style>
    </span>
  )
}
