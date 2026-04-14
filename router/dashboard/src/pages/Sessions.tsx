import { useCallback, useMemo, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { Panel } from '../components/Panel'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { IconButton } from '../components/ui/IconButton'
import { Badge } from '../components/ui/Badge'
import { AgentName } from '../components/ui/AgentName'
import { EmptyState } from '../components/ui/EmptyState'
import { Input, Select } from '../components/ui/Field'
import type { ProcessSession, CliSession } from '../api/client'

type SortKey = 'lastMessageAt' | 'createdAt' | 'messageCount' | 'costUsd' | 'inputTokens' | 'timeToInactivityTimeout'

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

  const processes = useMemo(() => procs || [], [procs])
  const cliSessions = useMemo(() => cliData || [], [cliData])

  const filtered = useMemo(() => {
    const q = filter.toLowerCase().trim()
    let list = processes.slice()
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
  }, [processes, filter, sortKey])

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
      setSelected(null)
      refreshProcs()
    } catch {
      onToast('Failed to kill session', 'error')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Sessions"
        count={`${processes.length} persistent${cliSessions.length > 0 ? ` + ${cliSessions.length} CLI` : ''}`}
        actions={
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
        }
      />

      {processes.length > 0 && (
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <SummaryCard label="Alive" value={`${totals.alive}/${processes.length}`} />
          <SummaryCard label="Processing" value={String(totals.processing)} color="var(--ok)" />
          <SummaryCard label="Total turns" value={String(totals.turns)} />
          <SummaryCard label="Total cost" value={`$${totals.cost.toFixed(3)}`} />
          <SummaryCard label="Total tokens" value={`${(totals.tokensTotal / 1000).toFixed(1)}k`} />
          <SummaryCard label="Cache hit" value={totals.tokensTotal > 0 ? `${totals.cacheHit}%` : '—'} color="var(--ok)" />
        </div>
      )}

      {processes.length > 0 ? (
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
                    <span
                      style={{ color: p.alive ? 'var(--ok)' : 'var(--err)', fontSize: 14 }}
                      title={p.pending ? 'Processing' : p.alive ? 'Idle' : 'Dead'}
                    >
                      ●
                    </span>
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
                    <span
                      className="font-mono text-xs"
                      style={{
                        color:
                          Math.min(p.timeToInactivityTimeout, p.timeToLifetimeTimeout) < 5 * 60 * 1000
                            ? 'var(--warn, #e69e28)'
                            : 'var(--text-3)',
                      }}
                      title={`Inactivity: ${fmtDuration(p.timeToInactivityTimeout)} | Lifetime: ${fmtDuration(p.timeToLifetimeTimeout)}`}
                    >
                      {fmtDuration(Math.min(p.timeToInactivityTimeout, p.timeToLifetimeTimeout))}
                    </span>
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
      )}

      {cliSessions.length > 0 && (
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
                      <span
                        style={{ color: s.alive ? 'var(--ok)' : 'var(--text-4)' }}
                        title={s.alive ? 'Heartbeat fresh' : 'No heartbeat for >30min — likely closed'}
                      >
                        {s.alive ? '●' : '○'}
                      </span>
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

      <Panel
        open={!!selected}
        title={selected ? `Session → ${selected.agentName || '(unrouted)'}` : ''}
        onClose={() => setSelected(null)}
      >
        {selected && <SessionDetail session={selected} onKill={() => kill(selected.key)} />}
      </Panel>
    </div>
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
  return (
    <th
      className={`px-3 py-2 font-medium text-[10px] uppercase tracking-wide ${right ? 'text-right' : 'text-left'}`}
      style={{ borderBottom: '1px solid var(--border)' }}
      title={title}
    >
      {children}
    </th>
  )
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

function SessionDetail({ session: s, onKill }: { session: ProcessSession; onKill: () => void }) {
  return (
    <div className="space-y-5">
      <Section label="Identity">
        <KV label="Session key" value={s.key} mono />
        <KV label="Channel" value={s.channel || '—'} />
        <KV label="Target" value={s.targetLabel ? `${s.target} (${s.targetLabel})` : s.target} mono />
        <KV label="Agent" value={<AgentName name={s.agentName || undefined} size="xs" />} />
        <KV label="Model" value={s.model} mono />
        <KV
          label="Scope"
          value={
            <span className="flex gap-1">
              {s.fullAccess && <Badge tone="accent" size="xs">FULL</Badge>}
              <Badge tone={s.inheritUserScope ? 'ok' : 'warn'} size="xs">{s.inheritUserScope ? 'user-scope' : 'isolated'}</Badge>
            </span>
          }
        />
        <KV label="Workspace" value={s.workspace} mono small />
        <KV label="PID" value={s.pid ?? '—'} mono />
      </Section>

      <Section label="Status">
        <KV
          label="State"
          value={
            <span className="flex gap-2 items-center">
              <span style={{ color: s.alive ? 'var(--ok)' : 'var(--err)' }}>{s.alive ? 'Alive' : 'Dead'}</span>
              {s.pending && <Badge tone="ok" size="xs">processing</Badge>}
              {s.needsContext && <Badge tone="warn" size="xs">awaiting first msg</Badge>}
            </span>
          }
        />
        {s.consecutiveTimeouts > 0 && (
          <KV label="Timeouts" value={`${s.consecutiveTimeouts} consecutive`} color="var(--warn, #e69e28)" />
        )}
        {s.pendingFilesCount > 0 && (
          <KV label="Pending files" value={`${s.pendingFilesCount} being written`} />
        )}
      </Section>

      <Section label="Timing">
        <KV label="Created" value={new Date(s.createdAt).toLocaleString('it-IT')} />
        <KV label="Uptime" value={fmtDuration(s.uptime)} mono />
        <KV label="Last activity" value={fmtAgo(s.lastMessageAt)} />
        <KV label="Idle" value={fmtDuration(s.idleTime)} mono />
        <KV
          label="Inactivity kill"
          value={`in ${fmtDuration(s.timeToInactivityTimeout)}`}
          mono
          color={s.timeToInactivityTimeout < 5 * 60 * 1000 ? 'var(--warn, #e69e28)' : undefined}
        />
        <KV
          label="Lifetime kill"
          value={`in ${fmtDuration(s.timeToLifetimeTimeout)}`}
          mono
          color={s.timeToLifetimeTimeout < 10 * 60 * 1000 ? 'var(--warn, #e69e28)' : undefined}
        />
      </Section>

      <Section label="Usage">
        <KV label="Messages" value={`${s.messageCount} turns`} mono />
        <KV label="Chars in/out" value={`${(s.charsIn / 1000).toFixed(1)}k / ${(s.charsOut / 1000).toFixed(1)}k`} mono />
        <KV label="Input tokens" value={fmtTokens(s.inputTokens)} mono />
        <KV label="Output tokens" value={fmtTokens(s.outputTokens)} mono />
        <KV label="Cache read" value={fmtTokens(s.cacheRead)} mono color="var(--ok)" />
        <KV label="Cache created" value={fmtTokens(s.cacheCreation)} mono />
        <KV label="Cost" value={fmtCost(s.costUsd)} mono bold />
        <KV label="Avg response" value={s.avgResponseMs > 0 ? `${(s.avgResponseMs / 1000).toFixed(1)}s` : '—'} mono />
        <KV
          label="Last response"
          value={
            s.lastDurationMs > 0
              ? `${(s.lastDurationMs / 1000).toFixed(1)}s (api ${(s.lastApiDurationMs / 1000).toFixed(1)}s)`
              : '—'
          }
          mono
        />
      </Section>

      <Section label={`Context window · ${ctxPct(s.estimatedTokens).toFixed(1)}% of 200k`}>
        <div style={{ height: 12, background: 'var(--bg-0)', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ width: `${ctxPct(s.estimatedTokens)}%`, height: '100%', background: ctxColor(s.estimatedTokens) }} />
        </div>
        <div className="text-[10px] mt-1" style={{ color: 'var(--text-4)' }}>
          {s.inputTokens > 0
            ? `Real: ${(s.estimatedTokens / 1000).toFixed(1)}k tokens`
            : 'Estimated from turn count (no API data yet)'}
        </div>
      </Section>

      {s.alive && (
        <div style={{ paddingTop: 8 }}>
          <Button variant="danger" size="md" onClick={onKill} style={{ width: '100%' }}>
            Kill session
          </Button>
        </div>
      )}
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        className="text-[10px] uppercase tracking-wide mb-2 pb-1"
        style={{ color: 'var(--text-4)', borderBottom: '1px solid var(--border)' }}
      >
        {label}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function KV({
  label,
  value,
  mono,
  bold,
  small,
  color,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
  bold?: boolean
  small?: boolean
  color?: string
}) {
  return (
    <div className="grid gap-2 text-xs" style={{ gridTemplateColumns: '130px 1fr' }}>
      <span style={{ color: 'var(--text-4)' }}>{label}</span>
      <span
        className={`${mono ? 'font-mono' : ''} ${bold ? 'font-semibold' : ''} ${small ? 'text-[10px]' : ''}`}
        style={{ color: color || 'var(--text-2)', wordBreak: 'break-all' }}
      >
        {value}
      </span>
    </div>
  )
}
