import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { StatCard } from '../components/StatCard'
import { StatusDot } from '../components/StatusDot'
import { PageHeader, SectionHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { IconButton } from '../components/ui/IconButton'
import { Badge } from '../components/ui/Badge'
import { Card } from '../components/ui/Card'
import { AgentName } from '../components/ui/AgentName'
import { EmptyState } from '../components/ui/EmptyState'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import type { DashboardState, ServiceStatus, ProcessSession } from '../api/client'

function fmtDuration(ms: number): string {
  if (ms == null || ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

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

function fmt(ts: number): string {
  return new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function ctxBarPct(tokens: number): number {
  return Math.min(100, (tokens / 200_000) * 100)
}

function ctxBarColor(tokens: number): string {
  if (tokens > 100_000) return 'var(--err)'
  if (tokens > 50_000) return 'var(--warn)'
  return 'var(--ok)'
}

export function Overview({ onToast }: { onToast: (msg: string, type: 'success' | 'error' | 'info') => void }) {
  const fetchState = useCallback(() => api.dashboardState(), [])
  const { data, loading, refresh, lastFetch } = usePolling<DashboardState>(fetchState, 5000)

  const fetchServices = useCallback(() => api.services(), [])
  const { data: services, refresh: refreshServices } = usePolling<ServiceStatus[]>(fetchServices, 30000)

  // Re-render "Xs ago" label every second
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (loading || !data) {
    return <div style={{ color: 'var(--text-4)' }}>Loading…</div>
  }

  const { stats, responseTimes, processes = [] } = data
  const rt = responseTimes || { recent: [], avgWallMs: 0, avgApiMs: 0, count1h: 0, sparkline: '' }

  const handleKill = async (key: string) => {
    try {
      await api.killSession(key)
      onToast('Session killed', 'success')
    } catch {
      onToast('Failed to kill session', 'error')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <PageHeader
        title="Overview"
        description="Real-time status of channels, sessions, and performance."
        actions={
          <>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text-4)', padding: '0 6px' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ok)', boxShadow: '0 0 6px var(--ok)' }} />
              Live · {lastFetch ? ago(lastFetch) : '…'}
            </span>
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

      {/* Stat Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
        <StatCard label="Messages Routed" value={stats.totalMessages} />
        <StatCard label="Telegram" value={stats.messagesByChannel?.telegram || 0} sub="messages" />
        <StatCard label="WhatsApp" value={stats.messagesByChannel?.whatsapp || 0} sub="messages" />
        <StatCard label="Discord" value={stats.messagesByChannel?.discord || 0} sub="messages" />
        <StatCard
          label="Live Sessions"
          value={stats.activeProcesses}
          sub={`${processes.length} process${processes.length !== 1 ? 'es' : ''}`}
        />
      </div>

      {/* Response Times Section */}
      <Card padding="18px 20px">
        <SectionHeader
          title="Response Times"
          action={
            <span style={{ fontSize: 11, color: 'var(--text-4)', fontFamily: 'var(--mono)', display: 'inline-flex', gap: 8 }}>
              <span>1h avg</span>
              <span>wall <b style={{ color: 'var(--text-2)' }}>{rt.avgWallMs}</b>ms</span>
              <span>api <b style={{ color: 'var(--text-2)' }}>{rt.avgApiMs}</b>ms</span>
              <span><b style={{ color: 'var(--text-2)' }}>{rt.count1h}</b> samples</span>
              {rt.sparkline && <span>{rt.sparkline}</span>}
            </span>
          }
        />
        <div style={{ fontSize: 11, fontFamily: 'var(--mono)' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '70px 1fr 50px 50px 50px 60px',
              gap: '2px 8px',
              padding: '6px 0',
              color: 'var(--text-4)',
              fontSize: 10,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              borderBottom: '1px solid var(--border)',
            }}
          >
            <span>time</span>
            <span>session</span>
            <span style={{ textAlign: 'right' }}>wall</span>
            <span style={{ textAlign: 'right' }}>api</span>
            <span style={{ textAlign: 'right' }}>oh</span>
            <span>model</span>
          </div>
          {rt.recent.length === 0 && (
            <div style={{ color: 'var(--text-4)', textAlign: 'center', padding: '16px 0', fontSize: 12 }}>
              No data yet
            </div>
          )}
          {rt.recent
            .slice(-10)
            .reverse()
            .map((r, i) => (
              <div
                key={`${r.ts}-${r.key}-${i}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '70px 1fr 50px 50px 50px 60px',
                  gap: '2px 8px',
                  padding: '4px 0',
                  borderBottom: '1px solid var(--border)',
                  color: 'var(--text-2)',
                }}
              >
                <span style={{ color: 'var(--text-4)' }}>{fmt(r.ts)}</span>
                <span>{short(r.key, 20)}</span>
                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Math.round(r.wallMs)}</span>
                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Math.round(r.apiMs)}</span>
                <span style={{ textAlign: 'right', color: 'var(--text-4)', fontVariantNumeric: 'tabular-nums' }}>
                  {Math.round(r.wallMs - r.apiMs)}
                </span>
                <span style={{ color: 'var(--text-4)' }}>{short(r.model || '', 12)}</span>
              </div>
            ))}
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[...(processes as ProcessSession[])]
              .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
              .slice(0, 4)
              .map((p) => {
                const tokens = p.estimatedTokens || 0
                const isJarvis = p.agentName === 'jarvis'
                return (
                  <Card
                    key={p.key}
                    padding="12px 16px"
                    tone={isJarvis ? 'jarvis' : 'default'}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                      <StatusDot ok={p.alive !== false} size={10} />
                      <AgentName name={p.agentName || undefined} />
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
                        {p.channel ? `${p.channel} · ${short(p.targetLabel || p.target || p.key, 24)}` : short(p.key, 30)}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--text-4)', fontFamily: 'var(--mono)' }}>{p.model}</span>
                      {p.pending && <Badge tone="ok" size="xs">processing</Badge>}
                      {p.alive !== false && (
                        <Button
                          variant="danger-ghost"
                          size="xs"
                          onClick={() => handleKill(p.key)}
                          style={{ marginLeft: 'auto' }}
                        >
                          KILL
                        </Button>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-4)', marginBottom: 6, flexWrap: 'wrap' }}>
                      <span>up {fmtDuration(p.uptime ?? (Date.now() - (p.createdAt || Date.now())))}</span>
                      <span>idle {fmtDuration(p.idleTime ?? (Date.now() - (p.lastMessageAt || Date.now())))}</span>
                      <span>{p.messageCount || 0} turns</span>
                      <span>~{(tokens / 1000).toFixed(1)}k tok</span>
                      {!!p.costUsd && <span>${p.costUsd.toFixed(3)}</span>}
                    </div>

                    <div style={{ height: 3, background: 'var(--bg-0)', borderRadius: 2, overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${ctxBarPct(tokens)}%`,
                          height: '100%',
                          background: ctxBarColor(tokens),
                          borderRadius: 2,
                          transition: 'width 0.3s',
                        }}
                      />
                    </div>
                  </Card>
                )
              })}
            {processes.length > 4 && (
              <a
                href="#sessions"
                style={{
                  display: 'block',
                  padding: 8,
                  textAlign: 'center',
                  fontSize: 11,
                  color: 'var(--text-4)',
                  textDecoration: 'none',
                }}
              >
                +{processes.length - 4} more — view all in Sessions →
              </a>
            )}
          </div>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.cliSessions.slice(0, 3).map((s) => (
              <Card key={s.id} padding="10px 14px">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <StatusDot ok={s.alive} />
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-2)', flex: 1 }}>
                    {short(s.workspace, 50)}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text-4)' }}>seen {ago(s.lastSeen)}</span>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
