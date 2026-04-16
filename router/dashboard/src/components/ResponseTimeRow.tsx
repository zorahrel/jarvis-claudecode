import type { CSSProperties } from 'react'
import { CheckCircle2, AlertTriangle, Clock } from 'lucide-react'
import type { ResponseTimeEntry, ResponseStatus } from '../api/client'
import { MetricBadge } from './MetricBadge'
import { RouteBadge } from './RouteBadge'

const EM_DASH = '\u2014'

export const RESPONSE_TIME_GRID =
  '88px minmax(0, 2fr) 84px 84px 84px minmax(0, 1.2fr) 72px'

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function statusMeta(status: ResponseStatus | undefined) {
  switch (status) {
    case 'error':
      return { color: 'var(--err)', icon: AlertTriangle, label: 'error' }
    case 'timeout':
      return { color: 'var(--warn)', icon: Clock, label: 'timeout' }
    case 'ok':
      return { color: 'var(--ok)', icon: CheckCircle2, label: 'ok' }
    default:
      return { color: 'var(--text-4)', icon: CheckCircle2, label: 'n/a' }
  }
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s
}

interface ResponseTimeRowProps {
  entry: ResponseTimeEntry
  /** Shared column template for header + rows. */
  gridTemplate?: string
}

export function ResponseTimeRow({ entry, gridTemplate = RESPONSE_TIME_GRID }: ResponseTimeRowProps) {
  const overheadMs = Math.max(0, entry.wallMs - entry.apiMs)
  const { color, icon: StatusIcon, label: statusLabel } = statusMeta(entry.status)

  const sessionHref = `#/sessions?filter=key:${encodeURIComponent(entry.key)}`
  const routeTitle = [
    entry.channel && `channel: ${entry.channel}`,
    entry.agent && `agent: ${entry.agent}`,
    `key: ${entry.key}`,
  ].filter(Boolean).join('\n')

  const cellStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: gridTemplate,
        gap: '2px 10px',
        padding: '6px 0',
        borderBottom: '1px solid var(--border)',
        color: 'var(--text-2)',
        fontSize: 11,
        fontFamily: 'var(--mono)',
        alignItems: 'center',
      }}
    >
      <span style={{ ...cellStyle, color: 'var(--text-4)' }}>{fmtTime(entry.ts)}</span>

      <span style={cellStyle}>
        <RouteBadge
          channel={entry.channel}
          agent={entry.agent}
          href={sessionHref}
          title={routeTitle}
          size="xs"
        />
      </span>

      <span style={{ ...cellStyle, justifyContent: 'flex-end' }}>
        <MetricBadge value={entry.wallMs} preset="llm" title="Wall = total time the user waited" />
      </span>

      <span style={{ ...cellStyle, justifyContent: 'flex-end' }}>
        <MetricBadge value={entry.apiMs} preset="llm" title="API = Claude API roundtrip" />
      </span>

      <span style={{ ...cellStyle, justifyContent: 'flex-end' }}>
        <MetricBadge
          value={overheadMs}
          preset="overhead"
          title="Overhead = wall − api (routing, serialization, tool calls)"
        />
      </span>

      <span
        style={{ ...cellStyle, color: 'var(--text-4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={entry.model}
      >
        {truncate(entry.model || EM_DASH, 28)}
      </span>

      <span style={{ ...cellStyle, gap: 4, color }} title={statusLabel}>
        <StatusIcon size={12} />
        <span style={{ fontSize: 10 }}>{statusLabel}</span>
      </span>
    </div>
  )
}

export function ResponseTimeHeader({ gridTemplate = RESPONSE_TIME_GRID }: { gridTemplate?: string }) {
  const col = (label: string, tip: string, align: 'left' | 'right' = 'left') => (
    <span
      title={tip}
      style={{
        textAlign: align,
        cursor: 'help',
        textDecoration: 'underline dotted var(--text-4)',
        textUnderlineOffset: 3,
      }}
    >
      {label}
    </span>
  )
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: gridTemplate,
        gap: '2px 10px',
        padding: '6px 0',
        color: 'var(--text-4)',
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--mono)',
      }}
    >
      {col('Time', 'When the response was recorded (local time)')}
      {col('Route', 'Channel + agent that handled this request. Click to drill into the session.')}
      {col('Wall', 'Total time the user waited (ms)', 'right')}
      {col('API', 'Claude API roundtrip time (ms)', 'right')}
      {col('Overhead', 'Wall minus API — routing + serialization + tool calls (ms)', 'right')}
      {col('Model', 'Model that produced the reply')}
      {col('Status', 'ok / error / timeout')}
    </div>
  )
}
