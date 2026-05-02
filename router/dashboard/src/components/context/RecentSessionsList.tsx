import type { ContextRecentSession } from '../../api/client'
import { formatTokens } from './thresholds'

interface Props {
  sessions: ContextRecentSession[]
}

function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s fa`
  if (s < 3600) return `${Math.floor(s / 60)}m fa`
  if (s < 86400) return `${Math.floor(s / 3600)}h fa`
  return `${Math.floor(s / 86400)}g fa`
}

export function RecentSessionsList({ sessions }: Props) {
  if (sessions.length === 0) return null
  return (
    <div
      className="rounded-lg p-3 mb-3"
      style={{ background: 'var(--bg-1)', border: '1px solid var(--border)' }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text-2)',
          marginBottom: 8,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        Storico recente
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
        {sessions.map((s) => (
          <div
            key={s.transcriptPath}
            style={{
              display: 'grid',
              gridTemplateColumns: '70px 100px 80px 70px 80px 1fr',
              gap: 8,
              padding: '3px 0',
            }}
          >
            <span>{fmtAgo(s.mtime)}</span>
            <span style={{ color: 'var(--text-2)' }}>{s.routeHint ?? '—'}</span>
            <span>{formatTokens(s.totalTokens)} tok</span>
            <span>{s.turnCount} turni</span>
            {s.compactionCount > 0 ? (
              <span style={{ color: '#f97316' }}>⟲ {s.compactionCount}</span>
            ) : (
              <span />
            )}
            <span
              style={{
                color: 'var(--text-4)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {s.cwd}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
