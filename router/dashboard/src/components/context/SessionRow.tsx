import { useState } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import type { ContextLiveSession, SessionBreakdown } from '../../api/client'
import { api } from '../../api/client'
import { colorForThreshold, labelForThreshold, formatTokens, formatUsd } from './thresholds'
import { BreakdownStackedBar } from './BreakdownStackedBar'

interface Props {
  session: ContextLiveSession
}

export function SessionRow({ session }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [breakdown, setBreakdown] = useState<SessionBreakdown | null>(null)
  const [loadingBreakdown, setLoadingBreakdown] = useState(false)
  const [breakdownError, setBreakdownError] = useState<string | null>(null)

  const liveTokens = session.liveTokens ?? 0
  const window = session.contextWindow ?? 200000
  const ratio = window > 0 ? liveTokens / window : 0
  const pct = Math.min(100, Math.round(ratio * 100))
  const color = colorForThreshold(ratio)
  const tooltip = labelForThreshold(ratio)
  const routeLabel =
    session.sessionKey?.split(':').pop() ??
    session.cwd?.split('/').pop() ??
    'unknown'

  const toggle = async () => {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    if (breakdown || loadingBreakdown || !session.sessionId) return
    setLoadingBreakdown(true)
    setBreakdownError(null)
    try {
      const b = await api.sessionBreakdown(session.sessionId)
      setBreakdown(b)
    } catch (e) {
      setBreakdownError(e instanceof Error ? e.message : 'errore')
    } finally {
      setLoadingBreakdown(false)
    }
  }

  return (
    <div
      className="rounded-lg p-3 mb-2"
      style={{ background: 'var(--bg-1)', border: '1px solid var(--border)' }}
    >
      <div
        onClick={toggle}
        style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontWeight: 600,
            color: 'var(--text-1)',
            minWidth: 100,
          }}
        >
          {routeLabel}
        </span>

        <div
          title={`${tooltip} — ${formatTokens(liveTokens)}/${formatTokens(window)}`}
          style={{
            flex: 1,
            height: 8,
            background: 'var(--bg-0)',
            borderRadius: 4,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              background: color,
              transition: 'width 200ms',
            }}
          />
        </div>

        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: 'var(--text-2)',
            minWidth: 80,
            textAlign: 'right',
          }}
        >
          {formatTokens(liveTokens)}/{formatTokens(window)}
        </span>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: 'var(--text-3)',
            minWidth: 40,
            textAlign: 'right',
          }}
        >
          {pct}%
        </span>
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: 'var(--text-2)',
            minWidth: 70,
            textAlign: 'right',
          }}
        >
          {formatUsd(session.lastTurnCostUsd)}
        </span>
        {(session.compactionCount ?? 0) > 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-4)', fontFamily: 'var(--mono)' }}>
            ⟲ {session.compactionCount}
          </span>
        )}
      </div>

      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
          {loadingBreakdown && (
            <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Caricamento breakdown...</div>
          )}
          {breakdownError && (
            <div style={{ fontSize: 12, color: '#ef4444' }}>Errore: {breakdownError}</div>
          )}
          {breakdown && <BreakdownStackedBar breakdown={breakdown} />}
        </div>
      )}
    </div>
  )
}
