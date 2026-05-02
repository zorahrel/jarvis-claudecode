import type { ContextAggregate, ContextDisk } from '../../api/client'
import { formatTokens, formatUsd } from './thresholds'

interface Props {
  aggregate: ContextAggregate
  disk: ContextDisk
}

export function AggregateHeader({ aggregate, disk }: Props) {
  return (
    <div
      className="rounded-lg p-4 mb-4"
      style={{
        background: 'var(--bg-1)',
        border: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
        <div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-3)',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            Aggregato live
          </div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: 'var(--text-1)',
              fontFamily: 'var(--mono)',
            }}
          >
            {aggregate.totalSessions} sessioni
          </div>
        </div>
        <div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-3)',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            Token totali
          </div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: 'var(--text-1)',
              fontFamily: 'var(--mono)',
            }}
          >
            {formatTokens(aggregate.totalLiveTokens)}
          </div>
        </div>
        <div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-3)',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            Costo medio per turno
          </div>
          <div
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: 'var(--text-1)',
              fontFamily: 'var(--mono)',
            }}
          >
            {formatUsd(aggregate.avgCostPerTurnUsd)}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
        Disco: {disk.totalMb.toFixed(0)} MB · {disk.totalJsonl} JSONL
        {disk.filesOlderThan30d > 0 && (
          <span style={{ color: '#f97316' }}>
            {' '}
            · ⚠ {disk.filesOlderThan30d} file &gt;30g
          </span>
        )}
      </div>
    </div>
  )
}
