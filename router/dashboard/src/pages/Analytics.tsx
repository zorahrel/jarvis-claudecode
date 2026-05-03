import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { navigate } from '../lib/url-state'
import { usePolling } from '../hooks/usePolling'
import { StatCard } from '../components/StatCard'
import { PageHeader, SectionHeader } from '../components/ui/PageHeader'
import { Card } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { AgentName } from '../components/ui/AgentName'
import { InfoBox } from '../components/ui/InfoBox'
import { EmptyState } from '../components/ui/EmptyState'
import { IconButton } from '../components/ui/IconButton'
import { Info, RefreshCw, Download } from 'lucide-react'
import { api } from '../api/client'
import type { FullRoute } from '../api/client'
import { parseHashFilter, parseHashParam } from '../lib/hashFilter'

interface AggResult {
  key: string
  totalCost: number
  totalInputTokens: number
  totalOutputTokens: number
  count: number
}

interface RawEntry {
  ts: number
  route: string
  channel: string
  from: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreation: number
  cacheRead: number
  costUsd: number
  durationMs: number
  apiDurationMs: number
}

interface CostsResponse {
  totalCost: number
  count: number
  aggregated: AggResult[]
  byDay: AggResult[]
  recent: RawEntry[]
}

type GroupBy = 'route' | 'channel' | 'model'

const PERIODS = [
  { days: 7, label: '7d' },
  { days: 14, label: '14d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
]

function fmtCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  return `$${usd.toFixed(2)}`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

function fmtPct(n: number): string {
  return `${Math.round(n)}%`
}

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

// Parse initial state from hash so links like `#/analytics?groupBy=route&period=7d&filter=agent:foo` hydrate.
function parseInitialAnalyticsHash(): { days: number; groupBy: GroupBy } {
  const hash = window.location.hash
  const period = parseHashParam(hash, 'period')
  const group = parseHashParam(hash, 'groupBy') as GroupBy
  const dayMap: Record<string, number> = { '7d': 7, '14d': 14, '30d': 30, '90d': 90 }
  return {
    days: dayMap[period] || 30,
    groupBy: group === 'route' || group === 'channel' || group === 'model' ? group : 'route',
  }
}

export function Analytics({ onToast: _onToast }: { onToast?: (msg: string, type: 'success' | 'error' | 'info') => void }) {
  const initial = parseInitialAnalyticsHash()
  const [days, setDays] = useState(initial.days)
  const [groupBy, setGroupBy] = useState<GroupBy>(initial.groupBy)
  const [hashFilter, setHashFilter] = useState(() => parseHashFilter(window.location.hash || window.location.search))
  const [routes, setRoutes] = useState<FullRoute[]>([])

  useEffect(() => {
    api.routesFull().then(setRoutes).catch(() => {})
  }, [])

  useEffect(() => {
    const onHash = () => setHashFilter(parseHashFilter(window.location.hash || window.location.search))
    window.addEventListener('hashchange', onHash)
    window.addEventListener('popstate', onHash)
    return () => window.removeEventListener('popstate', onHash);
      window.removeEventListener('hashchange', onHash)
  }, [])

  const clearHashFilter = () => {
    setHashFilter(null)
    if (window.location.hash.includes('filter=')) {
      window.history.replaceState(null, '', `#/analytics?groupBy=${groupBy}&period=${days}d`)
    }
  }

  const fetcher = useCallback(async (): Promise<CostsResponse> => {
    const res = await fetch(`/api/costs?days=${days}&groupBy=${groupBy}`)
    return res.json()
  }, [days, groupBy])

  const { data, loading, refresh } = usePolling<CostsResponse>(fetcher, 30000)

  // Heatmap always shows last 52 weeks (~1 year) regardless of period picker
  const heatmapFetcher = useCallback(async (): Promise<CostsResponse> => {
    const res = await fetch(`/api/costs?days=365&groupBy=day`)
    return res.json()
  }, [])

  const { data: heatmapData } = usePolling<CostsResponse>(heatmapFetcher, 60000)

  // Resolve hashFilter into concrete matchers. A `route:<idx>` becomes an
  // agent-name matcher because the costs API groups by route=agent.
  const resolvedFilter = useMemo(() => {
    if (!hashFilter) return null
    const { type, value } = hashFilter
    if (type === 'route') {
      const idx = parseInt(value, 10)
      if (Number.isNaN(idx)) return null
      const r = routes[idx]
      if (!r) return null
      return { field: 'route' as const, value: r.workspace, label: `route #${idx} (${r.workspace})` }
    }
    if (type === 'agent') return { field: 'route' as const, value, label: `agent: ${value}` }
    if (type === 'channel') return { field: 'channel' as const, value, label: `channel: ${value}` }
    if (type === 'model') return { field: 'model' as const, value, label: `model: ${value}` }
    return null
  }, [hashFilter, routes])

  const filteredAggregated = useMemo(() => {
    if (!data) return [] as AggResult[]
    if (!resolvedFilter) return data.aggregated
    // When group axis matches filter field we can keep only the matching row.
    const fieldAlignsWithGroup =
      (resolvedFilter.field === 'route' && groupBy === 'route') ||
      (resolvedFilter.field === 'channel' && groupBy === 'channel') ||
      (resolvedFilter.field === 'model' && groupBy === 'model')
    if (fieldAlignsWithGroup) return data.aggregated.filter(a => a.key === resolvedFilter.value)
    // Otherwise aggregate the recent entries on-the-fly (no server call).
    const matching = data.recent.filter(e => {
      if (resolvedFilter.field === 'route') return e.route === resolvedFilter.value
      if (resolvedFilter.field === 'channel') return e.channel === resolvedFilter.value
      if (resolvedFilter.field === 'model') return e.model === resolvedFilter.value
      return true
    })
    const map = new Map<string, AggResult>()
    for (const e of matching) {
      const key = groupBy === 'route' ? e.route : groupBy === 'channel' ? e.channel : e.model
      const row = map.get(key) || { key, totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0, count: 0 }
      row.totalCost += e.costUsd
      row.totalInputTokens += e.inputTokens
      row.totalOutputTokens += e.outputTokens
      row.count += 1
      map.set(key, row)
    }
    return Array.from(map.values()).sort((a, b) => b.totalCost - a.totalCost)
  }, [data, resolvedFilter, groupBy])

  const filteredRecent = useMemo(() => {
    if (!data) return [] as RawEntry[]
    if (!resolvedFilter) return data.recent
    return data.recent.filter(e => {
      if (resolvedFilter.field === 'route') return e.route === resolvedFilter.value
      if (resolvedFilter.field === 'channel') return e.channel === resolvedFilter.value
      if (resolvedFilter.field === 'model') return e.model === resolvedFilter.value
      return true
    })
  }, [data, resolvedFilter])

  const summary = useMemo(() => {
    if (!data) return null
    const agg = filteredAggregated
    const totalCost = agg.reduce((s, a) => s + a.totalCost, 0)
    const totalInput = agg.reduce((s, a) => s + a.totalInputTokens, 0)
    const totalOutput = agg.reduce((s, a) => s + a.totalOutputTokens, 0)
    const totalTurns = agg.reduce((s, a) => s + a.count, 0)
    const totalTokens = totalInput + totalOutput

    const cacheRead = filteredRecent.reduce((s, e) => s + e.cacheRead, 0)
    const recentInput = filteredRecent.reduce((s, e) => s + e.inputTokens, 0)
    const cacheHitPct = recentInput > 0 ? (cacheRead / recentInput) * 100 : 0

    return {
      totalCost,
      totalTurns,
      totalTokens,
      totalInput,
      totalOutput,
      avgCostPerTurn: totalTurns > 0 ? totalCost / totalTurns : 0,
      cacheHitPct,
    }
  }, [data, filteredAggregated, filteredRecent])

  const exportCsv = useCallback(() => {
    if (!data) return
    const rows = filteredRecent.length ? filteredRecent : data.recent
    const headers = ['ts', 'iso', 'route', 'channel', 'from', 'model', 'inputTokens', 'outputTokens', 'cacheCreation', 'cacheRead', 'costUsd', 'durationMs', 'apiDurationMs']
    const lines = [headers.join(',')]
    for (const r of rows) {
      const iso = new Date(r.ts).toISOString()
      const vals = [r.ts, iso, r.route, r.channel, r.from, r.model, r.inputTokens, r.outputTokens, r.cacheCreation, r.cacheRead, r.costUsd.toFixed(6), r.durationMs, r.apiDurationMs]
      lines.push(vals.map(v => {
        const s = String(v)
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      }).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `analytics-${days}d-${groupBy}${resolvedFilter ? '-' + resolvedFilter.field + '_' + resolvedFilter.value : ''}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [data, filteredRecent, days, groupBy, resolvedFilter])

  const maxBarCost = useMemo(() => {
    if (!data?.byDay.length) return 1
    return Math.max(...data.byDay.map(d => d.totalCost), 0.01)
  }, [data])

  if (loading && !data) {
    return <div style={{ color: 'var(--text-4)' }}>Loading…</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Analytics"
        description="Token usage and costs across agents, channels, and models."
        actions={
          <>
            <div style={{ display: 'flex', gap: 3 }}>
              {PERIODS.map(p => {
                const active = days === p.days
                return (
                  <button
                    key={p.days}
                    onClick={() => setDays(p.days)}
                    style={{
                      padding: '6px 12px',
                      fontSize: 12,
                      fontWeight: 500,
                      fontFamily: 'var(--mono)',
                      borderRadius: 'var(--radius)',
                      border: `1px solid ${active ? 'var(--accent-border)' : 'var(--border)'}`,
                      background: active ? 'var(--accent-tint-strong)' : 'transparent',
                      color: active ? 'var(--accent-bright)' : 'var(--text-4)',
                      cursor: 'pointer',
                      transition: 'background 0.15s, border-color 0.15s',
                    }}
                  >
                    {p.label}
                  </button>
                )
              })}
            </div>
            <IconButton
              icon={<Download size={13} />}
              label="Export CSV"
              onClick={exportCsv}
              disabled={loading || !data}
            />
            <IconButton
              icon={<RefreshCw size={13} />}
              label="Refresh"
              onClick={refresh}
              disabled={loading}
            />
          </>
        }
      />

      {resolvedFilter && (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            alignSelf: 'flex-start',
            padding: '5px 10px',
            fontSize: 11,
            background: 'var(--accent-tint)',
            border: '1px solid var(--accent-border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-2)',
          }}
        >
          <span>
            Filtered by <strong style={{ color: 'var(--accent-bright)' }}>{resolvedFilter.label}</strong>
          </span>
          <button
            onClick={clearHashFilter}
            aria-label="Clear filter"
            style={{ background: 'transparent', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 12, padding: '0 4px' }}
          >
            ×
          </button>
        </div>
      )}

      {/* Summary Cards */}
      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
          <StatCard label="Total Cost" value={fmtCost(summary.totalCost)} sub={`${days}d period`} />
          <StatCard label="Turns" value={summary.totalTurns} sub={`${fmtCost(summary.avgCostPerTurn)}/turn avg`} />
          <StatCard label="Input Tokens" value={fmtTokens(summary.totalInput)} />
          <StatCard label="Output Tokens" value={fmtTokens(summary.totalOutput)} />
          <StatCard
            label="Cache Hit"
            value={fmtPct(summary.cacheHitPct)}
            sub="on recent turns"
            tone={summary.cacheHitPct > 60 ? 'ok' : summary.cacheHitPct > 30 ? 'default' : 'warn'}
          />
        </div>
      )}

      {/* Daily heatmap (GitHub-style, last year) */}
      {heatmapData && (
        <Card padding="16px 18px">
          <SectionHeader title="Daily usage" count="last year" />
          <Heatmap byDay={heatmapData.byDay} />
        </Card>
      )}

      {/* Cost by Day — horizontal bar chart (current period) */}
      {data && data.byDay.length > 0 && (
        <Card padding="16px 18px">
          <SectionHeader title="Cost by day" count={`${data.byDay.length} days`} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {data.byDay.map(d => {
              const pct = (d.totalCost / maxBarCost) * 100
              return (
                <div key={d.key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text-4)', width: 80, flexShrink: 0 }}>
                    {d.key.slice(5)}
                  </span>
                  <div style={{ flex: 1, height: 16, background: 'var(--bg-0)', borderRadius: 'var(--radius-xs)', overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${Math.max(pct, 1)}%`,
                        height: '100%',
                        background: 'var(--accent-tint-strong)',
                        borderRadius: 'var(--radius-xs)',
                        transition: 'width 0.3s',
                      }}
                    />
                  </div>
                  <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--text-2)', width: 60, textAlign: 'right', flexShrink: 0 }}>
                    {fmtCost(d.totalCost)}
                  </span>
                  <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text-4)', width: 40, textAlign: 'right', flexShrink: 0 }}>
                    {d.count}
                  </span>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Breakdown by Dimension */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-4)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
            Breakdown
          </span>
          <div style={{ display: 'flex', gap: 3 }}>
            {([['route', 'Agent'], ['channel', 'Channel'], ['model', 'Model']] as const).map(([val, label]) => {
              const active = groupBy === val
              return (
                <button
                  key={val}
                  onClick={() => setGroupBy(val)}
                  style={{
                    padding: '4px 10px',
                    fontSize: 11,
                    fontWeight: 500,
                    borderRadius: 'var(--radius-sm)',
                    border: `1px solid ${active ? 'var(--accent-border)' : 'var(--border)'}`,
                    background: active ? 'var(--accent-tint)' : 'transparent',
                    color: active ? 'var(--accent-bright)' : 'var(--text-3)',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        {data && filteredAggregated.length > 0 ? (
          <div style={{ borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', overflow: 'hidden' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--bg-0)', color: 'var(--text-4)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                  <th style={th}>{groupBy === 'route' ? 'Agent' : groupBy === 'channel' ? 'Channel' : 'Model'}</th>
                  <th style={{ ...th, textAlign: 'right' }}>Cost</th>
                  <th style={{ ...th, textAlign: 'right' }}>%</th>
                  <th style={{ ...th, textAlign: 'right' }}>Turns</th>
                  <th style={{ ...th, textAlign: 'right' }}>Input</th>
                  <th style={{ ...th, textAlign: 'right' }}>Output</th>
                  <th style={{ ...th, textAlign: 'right' }}>$/turn</th>
                </tr>
              </thead>
              <tbody>
                {filteredAggregated.map(a => {
                  const pctOfTotal = summary ? (a.totalCost / Math.max(summary.totalCost, 0.001)) * 100 : 0
                  const isJarvis = groupBy === 'route' && a.key === 'jarvis'
                  const drillHref = groupBy === 'route'
                    ? `#/sessions?filter=agent:${encodeURIComponent(a.key)}`
                    : groupBy === 'channel'
                      ? `#/sessions?filter=channel:${encodeURIComponent(a.key)}`
                      : null
                  const onRowClick = () => {
                    if (drillHref) {
                      navigate(drillHref)
                    }
                  }
                  return (
                    <tr
                      key={a.key}
                      onClick={onRowClick}
                      title={drillHref ? `Open sessions for ${a.key}` : `Click a row to filter this model`}
                      style={{
                        borderTop: '1px solid var(--border)',
                        background: isJarvis ? 'linear-gradient(90deg, var(--jarvis-tint) 0%, transparent 40%)' : 'transparent',
                        cursor: drillHref ? 'pointer' : 'default',
                      }}
                    >
                      <td style={td}>
                        {groupBy === 'route' ? (
                          <AgentName name={a.key} size="xs" />
                        ) : (
                          <span style={{ fontFamily: 'var(--mono)', fontWeight: 500, color: 'var(--text-1)' }}>{a.key || '—'}</span>
                        )}
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--text-1)' }}>
                        {fmtCost(a.totalCost)}
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                          <div style={{ width: 40, height: 4, background: 'var(--bg-0)', borderRadius: 2, overflow: 'hidden' }}>
                            <div style={{ width: `${pctOfTotal}%`, height: '100%', background: isJarvis ? 'var(--accent-bright)' : 'var(--accent)', borderRadius: 2 }} />
                          </div>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-3)', minWidth: 28 }}>
                            {fmtPct(pctOfTotal)}
                          </span>
                        </div>
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text-2)' }}>{a.count}</td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text-3)' }}>{fmtTokens(a.totalInputTokens)}</td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text-3)' }}>{fmtTokens(a.totalOutputTokens)}</td>
                      <td style={{ ...td, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text-4)' }}>
                        {a.count > 0 ? fmtCost(a.totalCost / a.count) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={resolvedFilter ? `No cost data for ${resolvedFilter.label}` : 'No cost data for this period'}
            hint={resolvedFilter
              ? 'Clear the filter or widen the period.'
              : `Try a wider range — there may be no recorded turns in the last ${days} days.`}
          />
        )}
      </div>

      {/* Recent Activity */}
      {data && filteredRecent.length > 0 && (
        <div>
          <SectionHeader title="Recent activity" count={`last ${filteredRecent.length}`} />
          <div style={{ borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', overflow: 'auto', maxHeight: 400 }}>
            <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--bg-0)', color: 'var(--text-4)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, position: 'sticky', top: 0, zIndex: 1 }}>
                  <th style={thSmall}>When</th>
                  <th style={thSmall}>Agent</th>
                  <th style={thSmall}>Channel</th>
                  <th style={thSmall}>Model</th>
                  <th style={{ ...thSmall, textAlign: 'right' }}>Cost</th>
                  <th style={{ ...thSmall, textAlign: 'right' }}>In</th>
                  <th style={{ ...thSmall, textAlign: 'right' }}>Out</th>
                  <th style={{ ...thSmall, textAlign: 'right' }}>Cache</th>
                  <th style={{ ...thSmall, textAlign: 'right' }}>Time</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecent.slice().reverse().slice(0, 50).map((e, i) => {
                  const isJarvis = e.route === 'jarvis'
                  const rowHref = `#/sessions?filter=agent:${encodeURIComponent(e.route)}`
                  return (
                    <tr
                      key={`${e.ts}-${i}`}
                      onClick={() => { navigate(rowHref) }}
                      title={`Open sessions for ${e.route}`}
                      style={{
                        borderTop: '1px solid var(--border)',
                        background: isJarvis ? 'linear-gradient(90deg, var(--jarvis-tint) 0%, transparent 30%)' : 'transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <td style={tdSmall}><span style={{ color: 'var(--text-4)' }}>{ago(e.ts)}</span></td>
                      <td style={tdSmall}><AgentName name={e.route} size="xs" showIcon={false} /></td>
                      <td style={tdSmall}><span style={{ color: 'var(--text-3)' }}>{e.channel}</span></td>
                      <td style={tdSmall}><Badge tone="muted" size="xs" mono>{e.model.replace('claude-', '').replace(/-\d{8}$/, '')}</Badge></td>
                      <td style={{ ...tdSmall, textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--text-1)' }}>
                        {fmtCost(e.costUsd)}
                      </td>
                      <td style={{ ...tdSmall, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text-3)' }}>{fmtTokens(e.inputTokens)}</td>
                      <td style={{ ...tdSmall, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text-3)' }}>{fmtTokens(e.outputTokens)}</td>
                      <td style={{ ...tdSmall, textAlign: 'right', fontFamily: 'var(--mono)', color: e.cacheRead > 0 ? 'var(--ok)' : 'var(--text-4)' }}>
                        {e.inputTokens > 0 ? fmtPct((e.cacheRead / e.inputTokens) * 100) : '—'}
                      </td>
                      <td style={{ ...tdSmall, textAlign: 'right', fontFamily: 'var(--mono)', color: 'var(--text-4)' }}>
                        {(e.durationMs / 1000).toFixed(1)}s
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <InfoBox icon={<Info size={14} />} tone="neutral">
        Costs reported by Claude CLI (<code style={mono}>total_cost_usd</code>) — always aligned with Anthropic's published pricing.
        Cache reads are 90% cheaper. Higher cache hit = lower cost per turn.
      </InfoBox>
    </div>
  )
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 14px',
  fontWeight: 600,
  borderBottom: '1px solid var(--border)',
}

const td: React.CSSProperties = {
  padding: '10px 14px',
  verticalAlign: 'middle',
}

const thSmall: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  fontWeight: 600,
  borderBottom: '1px solid var(--border)',
  background: 'var(--bg-0)',
}

const tdSmall: React.CSSProperties = {
  padding: '7px 10px',
  verticalAlign: 'middle',
}

const mono: React.CSSProperties = {
  background: 'var(--bg-2)',
  padding: '1px 5px',
  borderRadius: 'var(--radius-xs)',
  fontFamily: 'var(--mono)',
  fontSize: '0.92em',
}

// ── Heatmap: GitHub-style contribution grid ──
// 52 weeks × 7 days. Cells scale to fill the container width.

const GAP = 3           // gap between cells (px)
const WEEKS = 52
const DAY_LABEL_W = 28  // width of day-of-week label column (incl. spacing)
const MIN_CELL = 10     // minimum cell size
const MAX_CELL = 18     // maximum cell size (so it doesn't blow up on huge screens)

function Heatmap({ byDay }: { byDay: AggResult[] }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [cell, setCell] = useState(12)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = () => {
      const w = el.clientWidth
      const available = Math.max(0, w - DAY_LABEL_W)
      const c = Math.floor((available - (WEEKS - 1) * GAP) / WEEKS)
      setCell(Math.max(MIN_CELL, Math.min(MAX_CELL, c)))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const costMap = new Map(byDay.map(d => [d.key, d]))
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // The rightmost column represents the current week (Mon → Sun containing today).
  // Build 52 weeks going back. Weeks start Monday.
  const todayDow = (today.getDay() + 6) % 7 // Mon=0 ... Sun=6

  // Start of current week (Monday, 00:00)
  const weekStart = new Date(today)
  weekStart.setDate(weekStart.getDate() - todayDow)

  // Build grid: for each of 52 cols × 7 rows, compute date
  const cells: Array<{ col: number; row: number; date: string; entry?: AggResult; future: boolean }> = []
  for (let c = 0; c < WEEKS; c++) {
    for (let r = 0; r < 7; r++) {
      const d = new Date(weekStart)
      d.setDate(d.getDate() - (WEEKS - 1 - c) * 7 + r)
      const iso = d.toISOString().slice(0, 10)
      const future = d.getTime() > today.getTime()
      cells.push({ col: c, row: r, date: iso, entry: costMap.get(iso), future })
    }
  }

  // Quartiles from non-zero days (in the whole window)
  const costs = byDay.map(d => d.totalCost).filter(c => c > 0).sort((a, b) => a - b)
  const q1 = costs[Math.floor(costs.length * 0.25)] ?? 0
  const q2 = costs[Math.floor(costs.length * 0.5)] ?? 0
  const q3 = costs[Math.floor(costs.length * 0.75)] ?? 0

  const cellColor = (cost: number, future: boolean): string => {
    if (future) return 'transparent'
    if (cost === 0) return 'var(--bg-0)'
    if (cost <= q1) return 'var(--accent-tint)'
    if (cost <= q2) return 'var(--accent-tint-strong)'
    if (cost <= q3) return 'rgba(113, 112, 255, 0.50)'
    return 'var(--accent-bright)'
  }

  // Month labels: find the column where each month first appears (row 0 Monday)
  const monthLabels: Array<{ col: number; label: string }> = []
  let lastMonth = -1
  for (let c = 0; c < WEEKS; c++) {
    const ccell = cells.find(x => x.col === c && x.row === 0)
    if (!ccell) continue
    const m = new Date(ccell.date).getMonth()
    if (m !== lastMonth) {
      monthLabels.push({ col: c, label: new Date(ccell.date).toLocaleDateString('en', { month: 'short' }) })
      lastMonth = m
    }
  }

  const gridW = WEEKS * cell + (WEEKS - 1) * GAP
  const dayLabels = ['Mon', '', 'Wed', '', 'Fri', '', '']
  const todayIso = today.toISOString().slice(0, 10)
  const maxCost = costs.length > 0 ? costs[costs.length - 1] : 0
  const totalCost = byDay.reduce((s, d) => s + d.totalCost, 0)

  return (
    <div ref={wrapRef} style={{ overflowX: 'auto' }}>
      {/* Month labels row */}
      <div style={{ height: 14, marginBottom: 4, marginLeft: DAY_LABEL_W, position: 'relative', width: gridW }}>
        {monthLabels.map((m, idx) => {
          const nextCol = monthLabels[idx + 1]?.col ?? WEEKS
          const spanWeeks = nextCol - m.col
          if (spanWeeks < 3) return null
          return (
            <span
              key={m.col}
              style={{
                position: 'absolute',
                left: m.col * (cell + GAP),
                fontSize: 10,
                fontFamily: 'var(--mono)',
                color: 'var(--text-4)',
              }}
            >
              {m.label}
            </span>
          )
        })}
      </div>

      {/* Day labels + grid */}
      <div style={{ display: 'flex', gap: 8 }}>
        <div
          style={{
            width: DAY_LABEL_W - 8,
            display: 'grid',
            gridTemplateRows: `repeat(7, ${cell}px)`,
            rowGap: GAP,
            fontSize: 10,
            fontFamily: 'var(--mono)',
            color: 'var(--text-4)',
          }}
        >
          {dayLabels.map((l, i) => (
            <span key={i} style={{ lineHeight: `${cell}px` }}>{l}</span>
          ))}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${WEEKS}, ${cell}px)`,
            gridTemplateRows: `repeat(7, ${cell}px)`,
            columnGap: GAP,
            rowGap: GAP,
          }}
        >
          {cells.map(({ col, row, date, entry, future }) => {
            const cost = entry?.totalCost ?? 0
            const count = entry?.count ?? 0
            const isToday = date === todayIso
            return (
              <div
                key={date}
                title={future ? '' : `${date}  ·  ${fmtCost(cost)}  ·  ${count} ${count === 1 ? 'turn' : 'turns'}`}
                style={{
                  gridColumn: col + 1,
                  gridRow: row + 1,
                  width: cell,
                  height: cell,
                  borderRadius: 2,
                  background: cellColor(cost, future),
                  outline: isToday ? '1px solid var(--accent-bright)' : undefined,
                  outlineOffset: isToday ? 1 : undefined,
                }}
              />
            )
          })}
        </div>
      </div>

      {/* Legend */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 12,
          marginLeft: DAY_LABEL_W,
          fontSize: 10,
          fontFamily: 'var(--mono)',
          color: 'var(--text-4)',
        }}
      >
        <span>Less</span>
        <div style={{ display: 'flex', gap: GAP }}>
          {['var(--bg-0)', 'var(--accent-tint)', 'var(--accent-tint-strong)', 'rgba(113, 112, 255, 0.50)', 'var(--accent-bright)'].map((c, i) => (
            <span key={i} style={{ width: cell, height: cell, borderRadius: 2, background: c }} />
          ))}
        </div>
        <span>More</span>
        <span style={{ marginLeft: 'auto' }}>
          {fmtCost(totalCost)} total{maxCost > 0 && ` · busiest ${fmtCost(maxCost)}`}
        </span>
      </div>
    </div>
  )
}
