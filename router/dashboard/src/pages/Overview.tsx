import { useCallback, useMemo } from 'react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { DrillDownCard } from '../components/DrillDownCard'
import { StatusDot } from '../components/StatusDot'
import { LiveIndicator } from '../components/LiveIndicator'
import { PageHeader, SectionHeader } from '../components/ui/PageHeader'
import { IconButton } from '../components/ui/IconButton'
import { Card } from '../components/ui/Card'
import { Tooltip } from '../components/ui/Tooltip'
import { EmptyState } from '../components/ui/EmptyState'
import { SessionRow } from '../components/SessionRow'
import {
  ResponseTimeRow,
  ResponseTimeHeader,
  RESPONSE_TIME_GRID,
} from '../components/ResponseTimeRow'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import type { DashboardState, ServiceStatus, ProcessSession } from '../api/client'

function ago(ts: number | string | undefined): string {
  if (!ts) return 'n/a'
  const ms = Date.now() - (typeof ts === 'string' ? new Date(ts).getTime() : ts)
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86400_000) return `${Math.round(ms / 3600_000)}h ago`
  return `${Math.round(ms / 86400_000)}d ago`
}

function short(s: string, maxLen = 20): string {
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
}

const CHANNEL_META: Record<string, { label: string; href: string }> = {
  telegram: { label: 'Telegram', href: 'channels' },
  whatsapp: { label: 'WhatsApp', href: 'channels' },
  discord: { label: 'Discord', href: 'channels' },
}

export function Overview(_props: { onToast: (msg: string, type: 'success' | 'error' | 'info') => void }) {
  const fetchState = useCallback(() => api.dashboardState(), [])
  const { data, loading, refresh, lastFetch } = usePolling<DashboardState>(fetchState, 5000)

  const fetchServices = useCallback(() => api.services(), [])
  const { data: services, refresh: refreshServices } = usePolling<ServiceStatus[]>(fetchServices, 30000)

  const recentRows = useMemo(() => {
    const recent = data?.responseTimes?.recent ?? []
    const processList = data?.processes ?? []
    const processByKey = new Map(processList.map((p) => [p.key, p]))
    return [...recent].reverse().slice(0, 15).map((entry) => {
      if (entry.agent && entry.channel) return entry
      const proc = processByKey.get(entry.key)
      const colonIdx = entry.key.indexOf(':')
      const channelFromKey = colonIdx > 0 ? entry.key.slice(0, colonIdx) : undefined
      return {
        ...entry,
        agent: entry.agent ?? proc?.agentName ?? undefined,
        channel: entry.channel ?? proc?.channel ?? channelFromKey,
      }
    })
  }, [data?.responseTimes?.recent, data?.processes])

  if (loading || !data) {
    return <div style={{ color: 'var(--text-4)' }}>Loading…</div>
  }

  const { stats, responseTimes, processes = [] } = data
  const rt = responseTimes || { recent: [], avgWallMs: 0, avgApiMs: 0, count1h: 0, sparkline: '' }

  const openSession = (key: string) => {
    window.location.hash = `#/sessions?filter=key:${encodeURIComponent(key)}`
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <PageHeader
        title="Overview"
        description="Real-time status of channels, sessions, and performance."
        actions={
          <>
            <LiveIndicator lastFetch={lastFetch} />
            <IconButton
              icon={<RefreshCw size={13} />}
              label="Refresh now"
              onClick={() => { refresh(); refreshServices() }}
            />
          </>
        }
      />

      {/* Service Health Ribbon */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(services || []).map((svc) => {
          const link = svc.linkUrl
          return (
            <div
              key={svc.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 14px',
                background: 'var(--bg-2)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                fontSize: 12,
                flex: 1,
                minWidth: 140,
              }}
            >
              <StatusDot ok={svc.status === 'ok'} />
              <span style={{ color: 'var(--text-2)' }}>{svc.name}</span>
              <span style={{ color: 'var(--text-4)', fontSize: 11, fontFamily: 'var(--mono)' }}>:{svc.port}</span>
              {link && (
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: 'var(--accent-bright)',
                    marginLeft: 'auto',
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                  }}
                  aria-label={`Open ${svc.name}`}
                >
                  <ArrowUpRight size={14} />
                </a>
              )}
            </div>
          )
        })}
        {(!services || services.length === 0) && (
          <div style={{ color: 'var(--text-4)', fontSize: 12 }}>Checking services…</div>
        )}
      </div>

      {/* Stat Cards — each drills into the page with more detail. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
        <DrillDownCard
          label="Messages Routed"
          value={stats.totalMessages}
          href="analytics"
          title="Open Analytics"
        />
        {Object.entries(CHANNEL_META).map(([key, meta]) => (
          <DrillDownCard
            key={key}
            label={meta.label}
            value={stats.messagesByChannel?.[key] || 0}
            sub="messages"
            href={meta.href}
            title={`Open ${meta.label} channel config`}
          />
        ))}
        <DrillDownCard
          label="Live Sessions"
          value={stats.activeProcesses}
          sub={`${processes.length} process${processes.length !== 1 ? 'es' : ''}`}
          href="sessions"
          title="Open Sessions — see active processes"
        />
      </div>

      {/* Response Times Section */}
      <Card padding="18px 20px">
        <SectionHeader
          title="Response Times"
          action={
            <span style={{ fontSize: 11, color: 'var(--text-4)', fontFamily: 'var(--mono)', display: 'inline-flex', gap: 10 }}>
              <Tooltip content="Average wall-clock time over the last hour" placement="bottom">
                <span>
                  1h wall <b style={{ color: 'var(--text-2)' }}>{rt.avgWallMs}</b>ms
                </span>
              </Tooltip>
              <Tooltip content="Average Claude API roundtrip over the last hour" placement="bottom">
                <span>
                  api <b style={{ color: 'var(--text-2)' }}>{rt.avgApiMs}</b>ms
                </span>
              </Tooltip>
              <Tooltip content="Samples in the last hour" placement="bottom">
                <span>
                  <b style={{ color: 'var(--text-2)' }}>{rt.count1h}</b> samples
                </span>
              </Tooltip>
              {rt.sparkline && (
                <Tooltip content="Wall-ms trend of last 20 samples" placement="bottom">
                  <span>{rt.sparkline}</span>
                </Tooltip>
              )}
            </span>
          }
        />
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 780 }}>
            <ResponseTimeHeader gridTemplate={RESPONSE_TIME_GRID} />
            {recentRows.length === 0 && (
              <div style={{ color: 'var(--text-4)', textAlign: 'center', padding: '16px 0', fontSize: 12 }}>
                No data yet
              </div>
            )}
            {recentRows.map((r, i) => (
              <ResponseTimeRow
                key={`${r.ts}-${r.key}-${i}`}
                entry={r}
                gridTemplate={RESPONSE_TIME_GRID}
              />
            ))}
          </div>
        </div>
        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-4)' }}>
          Click a route to open the session in the Sessions view.
        </div>
      </Card>

      {/* Active Sessions */}
      <div>
        <SectionHeader
          title="Active Sessions"
          count={processes.length > 0 ? processes.length : undefined}
          action={
            <a href="#sessions" style={{ fontSize: 12, color: 'var(--accent-bright)', textDecoration: 'none' }}>
              View all →
            </a>
          }
        />
        {processes.length === 0 ? (
          <EmptyState title="No active sessions" hint="Sessions spin up when a message arrives on a routed channel." />
        ) : (
          <SessionList
            sessions={[...(processes as ProcessSession[])]
              .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
              .slice(0, 5)}
            onOpen={openSession}
            footer={
              processes.length > 5 ? (
                <a
                  href="#sessions"
                  style={{
                    display: 'block',
                    padding: '8px 14px',
                    textAlign: 'center',
                    fontSize: 11,
                    color: 'var(--text-4)',
                    textDecoration: 'none',
                    borderTop: '1px solid var(--border)',
                  }}
                >
                  +{processes.length - 5} more → view all in Sessions
                </a>
              ) : null
            }
          />
        )}
      </div>

      {/* CLI Sessions preview */}
      {data.cliSessions && data.cliSessions.length > 0 && (
        <div>
          <SectionHeader
            title="CLI Sessions"
            count={data.cliSessions.length}
            action={
              <a href="#sessions" style={{ fontSize: 12, color: 'var(--accent-bright)', textDecoration: 'none' }}>
                View all →
              </a>
            }
          />
          <div
            style={{
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border)',
              overflow: 'hidden',
            }}
          >
            {data.cliSessions.slice(0, 3).map((s, i, arr) => (
              <div
                key={s.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 14px',
                  borderBottom: i === arr.length - 1 ? 'none' : '1px solid var(--border)',
                }}
              >
                <StatusDot ok={s.alive} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {short(s.workspace, 60)}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-4)', fontFamily: 'var(--mono)' }}>seen {ago(s.lastSeen)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function SessionList({
  sessions,
  onOpen,
  footer,
}: {
  sessions: ProcessSession[]
  onOpen: (key: string) => void
  footer?: React.ReactNode
}) {
  return (
    <div
      style={{
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border)',
        overflow: 'hidden',
      }}
    >
      {sessions.map((p, i) => (
        <SessionRow
          key={p.key}
          session={p}
          isLast={!footer && i === sessions.length - 1}
          onClick={() => onOpen(p.key)}
        />
      ))}
      {footer}
    </div>
  )
}
