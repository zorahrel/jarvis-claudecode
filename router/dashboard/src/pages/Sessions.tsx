import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { Panel } from '../components/Panel'
import { Tooltip } from '../components/ui/Tooltip'
import { PageHeader, SectionHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { IconButton } from '../components/ui/IconButton'
import { Badge } from '../components/ui/Badge'
import { AgentName } from '../components/ui/AgentName'
import { EmptyState } from '../components/ui/EmptyState'
import { Input, Select } from '../components/ui/Field'
import { BadgeLink } from '../components/BadgeLink'
import { ConversationThread } from '../components/ConversationThread'
import { ActivityStream } from '../components/ActivityStream'
import type { ProcessSession, CliSession } from '../api/client'

type SortKey = 'lastMessageAt' | 'createdAt' | 'messageCount' | 'costUsd' | 'inputTokens' | 'timeToInactivityTimeout'

export type SessionsFilterType = 'key' | 'agent' | 'channel' | 'route'
export interface SessionsFilter {
  type: SessionsFilterType
  value: string
}
export type SessionsView = 'table' | 'live'

/**
 * Parse a Sessions filter from a URL hash.
 * Expected format: `#/sessions?filter=<type>:<urlencoded-value>`
 * where `<type>` is one of: key | agent | channel | route.
 * Returns null if no valid filter is present.
 */
export function parseSessionsFilter(hash: string): SessionsFilter | null {
  if (!hash) return null
  const qIdx = hash.indexOf('?')
  if (qIdx < 0) return null
  const params = new URLSearchParams(hash.slice(qIdx + 1))
  const raw = params.get('filter')
  if (!raw) return null
  const sep = raw.indexOf(':')
  if (sep <= 0) return null
  const type = raw.slice(0, sep)
  const value = decodeURIComponent(raw.slice(sep + 1))
  if (type !== 'key' && type !== 'agent' && type !== 'channel' && type !== 'route') return null
  if (!value) return null
  return { type, value }
}

/** Parse the view toggle from a URL hash. Defaults to `table`. */
export function parseSessionsView(hash: string): SessionsView {
  if (!hash) return 'table'
  const qIdx = hash.indexOf('?')
  if (qIdx < 0) return 'table'
  const params = new URLSearchParams(hash.slice(qIdx + 1))
  return params.get('view') === 'live' ? 'live' : 'table'
}

/** Build a Sessions hash with an optional filter and view. */
export function buildSessionsHash(filter: SessionsFilter | null, view: SessionsView = 'table'): string {
  const params: string[] = []
  if (filter) params.push(`filter=${filter.type}:${encodeURIComponent(filter.value)}`)
  if (view === 'live') params.push('view=live')
  return params.length > 0 ? `#/sessions?${params.join('&')}` : '#/sessions'
}

function fmtDuration(ms: number): string {
  if (ms == null || ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h}h ${m}m`
}

function fmtAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function fmtTokens(n: number): string {
  if (n === 0) return '—'
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1)}k`
}

function fmtCost(usd: number): string {
  if (!usd) return '—'
  return `$${usd.toFixed(3)}`
}

function ctxPct(tokens: number): number {
  const cap = 200_000
  return Math.min(100, (tokens / cap) * 100)
}

function ctxColor(tokens: number): string {
  const pct = ctxPct(tokens)
  if (pct < 50) return 'var(--ok)'
  if (pct < 80) return 'var(--warn, #e69e28)'
  return 'var(--err)'
}

export function Sessions({ onToast }: { onToast: (msg: string, type: 'success' | 'error' | 'info') => void }) {
  const fetchProcesses = useCallback(() => api.processes(), [])
  const fetchCli = useCallback(() => api.sessions(), [])
  const { data: procs, refresh: refreshProcs, loading } = usePolling<ProcessSession[]>(fetchProcesses, 3000)
  const { data: cliData } = usePolling<CliSession[]>(fetchCli, 5000)

  const [filter, setFilter] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('lastMessageAt')
  const [selected, setSelected] = useState<ProcessSession | null>(null)
  const [hashFilter, setHashFilter] = useState<SessionsFilter | null>(() => parseSessionsFilter(window.location.hash))
  const [view, setView] = useState<SessionsView>(() => parseSessionsView(window.location.hash))

  const processes = useMemo(() => procs || [], [procs])
  const cliSessions = useMemo(() => cliData || [], [cliData])

  // Listen for hash changes (external navigation from other pages).
  useEffect(() => {
    const onHash = () => {
      setHashFilter(parseSessionsFilter(window.location.hash))
      setView(parseSessionsView(window.location.hash))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // When hashFilter=key and the matching ProcessSession appears, auto-open detail panel (table view only).
  useEffect(() => {
    if (view !== 'table') return
    if (hashFilter?.type !== 'key') return
    const match = processes.find(p => p.key === hashFilter.value)
    if (match && selected?.key !== match.key) setSelected(match)
  }, [view, hashFilter, processes, selected])

  const setViewPersisted = useCallback((next: SessionsView) => {
    setView(next)
    const target = buildSessionsHash(hashFilter, next)
    if (window.location.hash !== target) window.history.replaceState(null, '', target)
  }, [hashFilter])

  const filtered = useMemo(() => {
    const q = filter.toLowerCase().trim()
    let list = processes.slice()
    if (hashFilter) {
      list = list.filter(p => {
        switch (hashFilter.type) {
          case 'key': return p.key === hashFilter.value
          case 'agent': return (p.agentName || '') === hashFilter.value
          case 'channel': return (p.channel || '') === hashFilter.value
          case 'route': {
            const idx = parseInt(hashFilter.value, 10)
            if (!Number.isFinite(idx)) return false
            // route index not directly on ProcessSession; match by agentName route mapping isn't available here,
            // so we best-effort match against a `routeIndex` field if present.
            const pAny = p as unknown as { routeIndex?: number }
            return pAny.routeIndex === idx
          }
          default: return true
        }
      })
    }
    if (q) {
      list = list.filter(p =>
        (p.agentName || '').toLowerCase().includes(q) ||
        (p.channel || '').toLowerCase().includes(q) ||
        (p.target || '').toLowerCase().includes(q) ||
        (p.targetLabel || '').toLowerCase().includes(q) ||
        p.key.toLowerCase().includes(q) ||
        p.model.toLowerCase().includes(q),
      )
    }
    const asc = sortKey === 'timeToInactivityTimeout'
    list.sort((a, b) => (asc ? 1 : -1) * ((a[sortKey] as number) - (b[sortKey] as number)))
    return list
  }, [processes, filter, sortKey, hashFilter])

  const clearHashFilter = useCallback(() => {
    setHashFilter(null)
    const next = buildSessionsHash(null, view)
    if (window.location.hash !== next) window.history.replaceState(null, '', next)
  }, [view])

  const closeDetail = useCallback(() => {
    setSelected(null)
    // If the panel was opened via ?filter=key:..., clear that too.
    if (hashFilter?.type === 'key') clearHashFilter()
  }, [hashFilter, clearHashFilter])

  const totals = useMemo(() => {
    const alive = processes.filter(p => p.alive).length
    const processing = processes.filter(p => p.pending).length
    const turns = processes.reduce((s, p) => s + p.messageCount, 0)
    const cost = processes.reduce((s, p) => s + (p.costUsd || 0), 0)
    const tokensTotal = processes.reduce((s, p) => s + p.inputTokens + p.outputTokens, 0)
    const tokensInput = processes.reduce((s, p) => s + p.inputTokens, 0)
    const cacheRead = processes.reduce((s, p) => s + p.cacheRead, 0)
    const cacheHit = tokensInput > 0 ? Math.round((100 * cacheRead) / tokensInput) : 0
    return { alive, processing, turns, cost, tokensTotal, cacheHit }
  }, [processes])

  const kill = async (key: string) => {
    try {
      await api.killSession(key)
      onToast('Session killed', 'success')
      closeDetail()
      refreshProcs()
    } catch {
      onToast('Failed to kill session', 'error')
    }
  }

  const openLogsForSession = useCallback((key: string) => {
    // Contract with Logs page: hash filter, same format as sessions.
    // Logs may ignore it; this is a best-effort link.
    window.location.hash = `#/logs?filter=sessionKey:${encodeURIComponent(key)}`
  }, [])

  const streamInitialChannel = hashFilter?.type === 'channel' ? hashFilter.value : ''
  const streamInitialAgent = hashFilter?.type === 'agent' ? hashFilter.value : ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Sessions"
        count={`${processes.length} persistent${cliSessions.length > 0 ? ` + ${cliSessions.length} CLI` : ''}`}
        actions={
          <>
            <ViewToggle view={view} onChange={setViewPersisted} />
            {view === 'table' && (
              <>
                <Input
                  type="text"
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                  placeholder="Filter by agent, channel, key…"
                  style={{ width: 240, padding: '6px 10px', fontSize: 12, background: 'var(--bg-0)' }}
                />
                <Select
                  value={sortKey}
                  onChange={e => setSortKey(e.target.value as SortKey)}
                  style={{ width: 150, padding: '6px 10px', fontSize: 12, background: 'var(--bg-0)' }}
                >
                  <option value="lastMessageAt">Last activity</option>
                  <option value="createdAt">Created</option>
                  <option value="messageCount">Turns</option>
                  <option value="costUsd">Cost</option>
                  <option value="inputTokens">Tokens</option>
                  <option value="timeToInactivityTimeout">Time to kill</option>
                </Select>
                <IconButton icon={<RefreshCw size={13} />} label="Refresh" onClick={refreshProcs} disabled={loading} />
              </>
            )}
          </>
        }
      />

      {hashFilter && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '8px 12px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--accent-border)',
            background: 'var(--accent-tint)',
            fontSize: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Badge tone="accent" size="xs">URL filter</Badge>
            <span style={{ color: 'var(--text-2)' }}>
              {hashFilter.type}: <span style={{ fontFamily: 'var(--mono)' }}>{hashFilter.value}</span>
            </span>
          </div>
          <Button variant="ghost" size="xs" onClick={clearHashFilter}>
            Clear
          </Button>
        </div>
      )}

      {view === 'live' && (
        <ActivityStream initialChannel={streamInitialChannel} initialAgent={streamInitialAgent} />
      )}

      {view === 'table' && processes.length > 0 && (
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <SummaryCard label="Alive" value={`${totals.alive}/${processes.length}`} />
          <SummaryCard label="Processing" value={String(totals.processing)} color="var(--ok)" />
          <SummaryCard label="Total turns" value={String(totals.turns)} />
          <SummaryCard label="Total cost" value={`$${totals.cost.toFixed(3)}`} />
          <SummaryCard label="Total tokens" value={`${(totals.tokensTotal / 1000).toFixed(1)}k`} />
          <SummaryCard label="Cache hit" value={totals.tokensTotal > 0 ? `${totals.cacheHit}%` : '—'} color="var(--ok)" />
        </div>
      )}

      {view === 'table' && (processes.length > 0 ? (
        <div className="rounded-lg overflow-auto" style={{ border: '1px solid var(--border)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--bg-2)', color: 'var(--text-4)' }}>
                <Th>●</Th>
                <Th>Agent</Th>
                <Th>Channel / Target</Th>
                <Th>Model</Th>
                <Th right>Turns</Th>
                <Th right title="Input tokens (includes cache read)">Tok in</Th>
                <Th right>Tok out</Th>
                <Th right title="Cache read / input — higher is cheaper">Cache</Th>
                <Th right>Cost</Th>
                <Th right>Avg resp</Th>
                <Th>Ctx</Th>
                <Th>Uptime / Idle</Th>
                <Th title="Time until automatic kill">Kill in</Th>
                <Th right>PID</Th>
                <Th right>{' '}</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={15} style={{ padding: 0 }}>
                    <div
                      style={{
                        padding: '32px 16px',
                        textAlign: 'center',
                        color: 'var(--text-4)',
                        fontSize: 12,
                      }}
                    >
                      No sessions match <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-2)' }}>"{filter}"</span>
                    </div>
                  </td>
                </tr>
              )}
              {filtered.map(p => (
                <tr
                  key={p.key}
                  className="cursor-pointer hover:opacity-90"
                  style={{ borderTop: '1px solid var(--border)' }}
                  onClick={() => setSelected(p)}
                >
                  <Td>
                    <Tooltip content={p.pending ? 'Processing' : p.alive ? 'Idle' : 'Dead'} placement="right">
                      <span style={{ color: p.alive ? 'var(--ok)' : 'var(--err)', fontSize: 14 }}>
                        ●
                      </span>
                    </Tooltip>
                  </Td>
                  <Td>
                    <div className="flex gap-1.5 items-center flex-wrap">
                      <AgentName name={p.agentName || undefined} size="xs" />
                      {p.fullAccess && <Badge tone="accent" size="xs" title="fullAccess">FULL</Badge>}
                      {!p.inheritUserScope && <Badge tone="warn" size="xs" title="isolated from user scope">ISO</Badge>}
                      {p.pending && <Badge tone="ok" size="xs">processing</Badge>}
                    </div>
                  </Td>
                  <Td>
                    <div className="font-mono text-xs" style={{ color: 'var(--text-2)' }}>{p.channel}</div>
                    <div className="font-mono text-xs" style={{ color: 'var(--text-4)' }}>{p.targetLabel || p.target}</div>
                  </Td>
                  <Td mono>{p.model}</Td>
                  <Td right mono>{p.messageCount}</Td>
                  <Td right mono>{fmtTokens(p.inputTokens)}</Td>
                  <Td right mono>{fmtTokens(p.outputTokens)}</Td>
                  <Td right mono color="var(--ok)">
                    {p.inputTokens > 0 ? `${Math.round((100 * p.cacheRead) / p.inputTokens)}%` : '—'}
                  </Td>
                  <Td right mono bold>{fmtCost(p.costUsd)}</Td>
                  <Td right mono>{p.avgResponseMs > 0 ? `${(p.avgResponseMs / 1000).toFixed(1)}s` : '—'}</Td>
                  <Td>
                    <div style={{ width: 60, height: 6, background: 'var(--bg-0)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ width: `${ctxPct(p.estimatedTokens)}%`, height: '100%', background: ctxColor(p.estimatedTokens) }} />
                    </div>
                    <div className="font-mono" style={{ fontSize: 9, color: 'var(--text-4)', marginTop: 2 }}>
                      {ctxPct(p.estimatedTokens).toFixed(0)}%
                    </div>
                  </Td>
                  <Td>
                    <div className="font-mono text-xs" style={{ color: 'var(--text-2)' }}>{fmtDuration(p.uptime)}</div>
                    <div className="font-mono" style={{ fontSize: 10, color: 'var(--text-4)' }}>idle {fmtDuration(p.idleTime)}</div>
                  </Td>
                  <Td>
                    <Tooltip
                      content={`Inactivity: ${fmtDuration(p.timeToInactivityTimeout)}\nLifetime: ${fmtDuration(p.timeToLifetimeTimeout)}`}
                      placement="top"
                    >
                      <span
                        className="font-mono text-xs"
                        style={{
                          color:
                            Math.min(p.timeToInactivityTimeout, p.timeToLifetimeTimeout) < 5 * 60 * 1000
                              ? 'var(--warn, #e69e28)'
                              : 'var(--text-3)',
                        }}
                      >
                        {fmtDuration(Math.min(p.timeToInactivityTimeout, p.timeToLifetimeTimeout))}
                      </span>
                    </Tooltip>
                  </Td>
                  <Td right mono color="var(--text-4)">{p.pid ?? '—'}</Td>
                  <Td right>
                    {p.alive && (
                      <Button
                        variant="danger-ghost"
                        size="xs"
                        onClick={e => { e.stopPropagation(); kill(p.key) }}
                      >
                        Kill
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No active persistent sessions"
          hint="Sessions spin up when a message arrives on a routed channel."
        />
      ))}

      {view === 'table' && cliSessions.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium" style={{ color: 'var(--text-2)' }}>
              CLI Sessions{' '}
              <span style={{ color: 'var(--text-4)' }}>
                · {cliSessions.filter(s => s.alive).length} alive / {cliSessions.length} tracked
              </span>
            </h2>
            {cliSessions.some(s => !s.alive) && (
              <Button
                size="xs"
                variant="ghost"
                onClick={async () => {
                  try {
                    const r = await api.pruneCliSessions()
                    onToast(`Pruned ${r.removed} dead CLI session${r.removed === 1 ? '' : 's'}`, 'success')
                  } catch {
                    onToast('Failed to prune', 'error')
                  }
                }}
              >
                Prune dead
              </Button>
            )}
          </div>
          <div className="rounded-lg overflow-auto" style={{ border: '1px solid var(--border)' }}>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'var(--bg-2)', color: 'var(--text-4)' }}>
                  <Th>●</Th>
                  <Th>Workspace</Th>
                  <Th>Started</Th>
                  <Th>Last seen</Th>
                  <Th right>{' '}</Th>
                </tr>
              </thead>
              <tbody>
                {cliSessions.map(s => (
                  <tr key={s.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <Td>
                      <Tooltip
                        content={s.alive ? 'Heartbeat fresh' : 'No heartbeat for >30min — likely closed'}
                        placement="right"
                      >
                        <span style={{ color: s.alive ? 'var(--ok)' : 'var(--text-4)' }}>
                          {s.alive ? '●' : '○'}
                        </span>
                      </Tooltip>
                    </Td>
                    <Td mono>{s.workspace || '—'}</Td>
                    <Td>{fmtAgo(s.startedAt)}</Td>
                    <Td>{fmtAgo(s.lastSeen)}</Td>
                    <Td right>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await api.removeCliSession(s.id)
                            onToast('Removed', 'success')
                          } catch {
                            onToast('Failed', 'error')
                          }
                        }}
                        title="Remove this entry"
                      >
                        <X size={12} />
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {view === 'table' && (
        <Panel
          open={!!selected}
          title={selected ? `Session → ${selected.agentName || '(unrouted)'}` : ''}
          onClose={closeDetail}
        >
          {selected && (
            <SessionDetail
              session={selected}
              onKill={() => kill(selected.key)}
              onOpenLogs={() => openLogsForSession(selected.key)}
              onToast={onToast}
            />
          )}
        </Panel>
      )}
    </div>
  )
}

function ViewToggle({ view, onChange }: { view: SessionsView; onChange: (next: SessionsView) => void }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 2,
        background: 'var(--bg-0)',
        borderRadius: 'var(--radius)',
        padding: 2,
        border: '1px solid var(--border)',
      }}
    >
      <ViewToggleButton active={view === 'table'} label="Table" onClick={() => onChange('table')} />
      <ViewToggleButton active={view === 'live'} label="Live stream" onClick={() => onChange('live')} />
    </div>
  )
}

function ViewToggleButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '5px 12px',
        fontSize: 11,
        background: active ? 'var(--accent-tint-strong)' : 'transparent',
        color: active ? 'var(--accent-bright)' : 'var(--text-3)',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        fontWeight: active ? 600 : 500,
        transition: 'background 0.15s, color 0.15s',
      }}
    >
      {label}
    </button>
  )
}

function SummaryCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-md px-3 py-2.5" style={{ background: 'var(--bg-0)', border: '1px solid var(--border)' }}>
      <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-4)' }}>{label}</div>
      <div className="text-lg font-semibold font-mono" style={{ color: color || 'var(--text-1)' }}>{value}</div>
    </div>
  )
}


function Th({ children, right, title }: { children: React.ReactNode; right?: boolean; title?: string }) {
  const cell = (
    <th
      className={`px-3 py-2 font-medium text-[10px] uppercase tracking-wide ${right ? 'text-right' : 'text-left'}`}
      style={{ borderBottom: '1px solid var(--border)', cursor: title ? 'help' : 'default' }}
    >
      {children}
    </th>
  )
  if (!title) return cell
  return <Tooltip content={title} placement="bottom">{cell}</Tooltip>
}

function Td({
  children,
  right,
  mono,
  bold,
  color,
}: {
  children: React.ReactNode
  right?: boolean
  mono?: boolean
  bold?: boolean
  color?: string
}) {
  return (
    <td
      className={`px-3 py-2 text-xs ${right ? 'text-right' : 'text-left'} ${mono ? 'font-mono' : ''} ${bold ? 'font-semibold' : ''}`}
      style={{ color: color || 'var(--text-2)', verticalAlign: 'top' }}
    >
      {children}
    </td>
  )
}

function SessionDetail({
  session: s,
  onKill,
  onOpenLogs,
  onToast,
}: {
  session: ProcessSession
  onKill: () => void
  onOpenLogs: () => void
  onToast: (msg: string, type: 'success' | 'error' | 'info') => void
}) {
  const goToAgent = () => {
    if (s.agentName) window.location.hash = `#/agents?focus=${encodeURIComponent(s.agentName)}`
  }
  const goToChannel = () => {
    if (s.channel) window.location.hash = `#/channels?focus=${encodeURIComponent(s.channel)}`
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {s.agentName && <Button size="sm" onClick={goToAgent}>Open Agent →</Button>}
        {s.channel && <Button size="sm" onClick={goToChannel}>Open Channel →</Button>}
        <Button size="sm" onClick={onOpenLogs}>Open Logs →</Button>
        {s.alive && (
          <Button size="sm" variant="danger-ghost" onClick={onKill}>Kill</Button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Badge tone={s.alive ? 'ok' : 'err'} size="sm">{s.alive ? 'alive' : 'dead'}</Badge>
        {s.pending && <Badge tone="ok" size="sm">processing</Badge>}
        {s.needsContext && <Badge tone="warn" size="sm">awaiting first msg</Badge>}
        {s.fullAccess && <Badge tone="accent" size="sm">FULL</Badge>}
        <Badge tone={s.inheritUserScope ? 'muted' : 'warn'} size="sm">
          {s.inheritUserScope ? 'user-scope' : 'isolated'}
        </Badge>
        {s.consecutiveTimeouts > 0 && (
          <Badge tone="warn" size="sm">{s.consecutiveTimeouts} timeouts</Badge>
        )}
        {s.pendingFilesCount > 0 && (
          <Badge tone="muted" size="sm">{s.pendingFilesCount} pending files</Badge>
        )}
      </div>

      <div>
        <SectionHeader title="Identity" />
        <dl style={dlGrid}>
          <dt style={labelStyle}>Agent</dt>
          <dd style={ddStyle}><AgentName name={s.agentName || undefined} size="xs" /></dd>
          <dt style={labelStyle}>Channel</dt>
          <dd style={ddStyle}>{s.channel || '—'}</dd>
          <dt style={labelStyle}>Target</dt>
          <dd style={ddStyle}>{s.targetLabel ? `${s.target} (${s.targetLabel})` : s.target || '—'}</dd>
          <dt style={labelStyle}>Model</dt>
          <dd style={ddStyle}>{s.model}</dd>
          <dt style={labelStyle}>Session key</dt>
          <dd style={{ ...ddStyle, wordBreak: 'break-all' }}>{s.key}</dd>
          <dt style={labelStyle}>Workspace</dt>
          <dd style={{ ...ddStyle, fontSize: 11, wordBreak: 'break-all' }}>{s.workspace}</dd>
          <dt style={labelStyle}>PID</dt>
          <dd style={ddStyle}>{s.pid ?? '—'}</dd>
        </dl>
      </div>

      <div>
        <SectionHeader title="Timing" />
        <dl style={dlGrid}>
          <dt style={labelStyle}>Created</dt>
          <dd style={{ ...ddStyle, fontFamily: 'var(--sans)' }}>{new Date(s.createdAt).toLocaleString('en-US')}</dd>
          <dt style={labelStyle}>Uptime</dt>
          <dd style={ddStyle}>{fmtDuration(s.uptime)}</dd>
          <dt style={labelStyle}>Last activity</dt>
          <dd style={{ ...ddStyle, fontFamily: 'var(--sans)' }}>{fmtAgo(s.lastMessageAt)}</dd>
          <dt style={labelStyle}>Idle</dt>
          <dd style={ddStyle}>{fmtDuration(s.idleTime)}</dd>
          <dt style={labelStyle}>Inactivity kill</dt>
          <dd
            style={{
              ...ddStyle,
              color: s.timeToInactivityTimeout < 5 * 60 * 1000 ? 'var(--warn, #e69e28)' : undefined,
            }}
          >
            in {fmtDuration(s.timeToInactivityTimeout)}
          </dd>
          <dt style={labelStyle}>Lifetime kill</dt>
          <dd
            style={{
              ...ddStyle,
              color: s.timeToLifetimeTimeout < 10 * 60 * 1000 ? 'var(--warn, #e69e28)' : undefined,
            }}
          >
            in {fmtDuration(s.timeToLifetimeTimeout)}
          </dd>
        </dl>
      </div>

      <div>
        <SectionHeader
          title="Usage"
          action={
            <BadgeLink
              href={`#/analytics?groupBy=route&period=7d${s.agentName ? `&filter=agent:${encodeURIComponent(s.agentName)}` : ''}`}
              tone="muted"
              size="xs"
              label="analytics"
              title="Open Analytics for this agent"
            />
          }
        />
        <dl style={dlGrid}>
          <dt style={labelStyle}>Messages</dt>
          <dd style={ddStyle}>{s.messageCount} turns</dd>
          <dt style={labelStyle}>Chars in/out</dt>
          <dd style={ddStyle}>{(s.charsIn / 1000).toFixed(1)}k / {(s.charsOut / 1000).toFixed(1)}k</dd>
          <dt style={labelStyle}>Input tokens</dt>
          <dd style={ddStyle}>{fmtTokens(s.inputTokens)}</dd>
          <dt style={labelStyle}>Output tokens</dt>
          <dd style={ddStyle}>{fmtTokens(s.outputTokens)}</dd>
          <dt style={labelStyle}>Cache read</dt>
          <dd style={{ ...ddStyle, color: 'var(--ok)' }}>{fmtTokens(s.cacheRead)}</dd>
          <dt style={labelStyle}>Cache created</dt>
          <dd style={ddStyle}>{fmtTokens(s.cacheCreation)}</dd>
          <dt style={labelStyle}>Cost</dt>
          <dd style={{ ...ddStyle, fontWeight: 600 }}>{fmtCost(s.costUsd)}</dd>
          <dt style={labelStyle}>Avg response</dt>
          <dd style={ddStyle}>{s.avgResponseMs > 0 ? `${(s.avgResponseMs / 1000).toFixed(1)}s` : '—'}</dd>
          <dt style={labelStyle}>Last response</dt>
          <dd style={ddStyle}>
            {s.lastDurationMs > 0
              ? `${(s.lastDurationMs / 1000).toFixed(1)}s (api ${(s.lastApiDurationMs / 1000).toFixed(1)}s)`
              : '—'}
          </dd>
        </dl>
      </div>

      <div>
        <SectionHeader
          title="Context window"
          count={`${ctxPct(s.estimatedTokens).toFixed(1)}% of 200k`}
        />
        <div style={{ height: 12, background: 'var(--bg-0)', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ width: `${ctxPct(s.estimatedTokens)}%`, height: '100%', background: ctxColor(s.estimatedTokens) }} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 6 }}>
          {s.inputTokens > 0
            ? `Real: ${(s.estimatedTokens / 1000).toFixed(1)}k tokens`
            : 'Estimated from turn count (no API data yet)'}
        </div>
      </div>

      <div>
        <SectionHeader title="Conversation" />
        <ConversationThread
          sessionKey={s.key}
          model={s.model}
          onError={(msg) => onToast(`Thread: ${msg}`, 'error')}
          onOpenLogs={onOpenLogs}
        />
      </div>
    </div>
  )
}

const dlGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '110px 1fr',
  gap: 6,
  fontSize: 12,
  color: 'var(--text-2)',
  margin: 0,
}

const labelStyle: React.CSSProperties = { color: 'var(--text-4)', margin: 0 }
const ddStyle: React.CSSProperties = { margin: 0, fontFamily: 'var(--mono)', fontSize: 12 }
