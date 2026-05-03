import { useState, useCallback, useEffect, useMemo } from 'react'
import { navigate } from '../lib/url-state'
import { Plus } from 'lucide-react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { Panel } from '../components/Panel'
import { Modal } from '../components/Modal'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { InfoBox } from '../components/ui/InfoBox'
import { EmptyState } from '../components/ui/EmptyState'
import { PageHeader, SectionHeader } from '../components/ui/PageHeader'
import { AgentName } from '../components/ui/AgentName'
import { Field, Input, Select } from '../components/ui/Field'
import { BadgeLink } from '../components/BadgeLink'
import { AlwaysReplyGroups } from '../components/AlwaysReplyGroups'
import type { FullRoute, ProcessSession } from '../api/client'
import { ChannelIcon } from '../icons'
import { parseHashFilter } from '../lib/hashFilter'

interface AggEntry {
  key: string
  totalCost: number
  count: number
}

interface CostsResponse {
  aggregated: AggEntry[]
}

interface RouteFormState {
  channel: string
  matchType: 'from' | 'group' | 'all'
  from: string
  group: string
  agent: string
}

const emptyForm: RouteFormState = {
  channel: 'whatsapp',
  matchType: 'from',
  from: '',
  group: '',
  agent: '',
}

function routeLabel(r: FullRoute): string {
  if (r.group) {
    let label = r.groupLabel || String(r.group).replace(/@g\.us$/, '')
    if (label.length > 32) label = label.slice(0, 29) + '…'
    return label
  }
  if (r.from && r.from !== '*') {
    return r.fromLabel || String(r.from)
  }
  if (r.channel === '*') return 'any (catch-all)'
  return '*'
}

function routeSubLabel(r: FullRoute): string {
  if (r.group) {
    const raw = String(r.groupRawId || r.group).replace(/@g\.us$/, '')
    if (r.groupLabel && raw !== r.groupLabel) return raw
  }
  if (r.from && r.from !== '*') {
    const raw = String(r.fromRawId || r.from)
    if (r.fromLabel && raw !== r.fromLabel) return raw
  }
  return ''
}

export function Routes({ onToast }: { onToast: (msg: string, type: 'success' | 'error' | 'info') => void }) {
  const fetchRoutes = useCallback(() => api.routesFull(), [])
  const { data, refresh } = usePolling<FullRoute[]>(fetchRoutes, 5000)

  const [agentNames, setAgentNames] = useState<string[]>([])
  const [editIndex, setEditIndex] = useState<number | null>(null)
  const [form, setForm] = useState<RouteFormState>(emptyForm)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [isNew, setIsNew] = useState(false)
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null)
  const [detailIndex, setDetailIndex] = useState<number | null>(null)
  const [detailClaudeMd, setDetailClaudeMd] = useState<string | null>(null)
  const [processes, setProcesses] = useState<ProcessSession[]>([])
  const [saving, setSaving] = useState(false)
  const [turnsByAgent7d, setTurnsByAgent7d] = useState<Record<string, number>>({})
  const [hashFilter, setHashFilter] = useState(() => parseHashFilter(window.location.hash || window.location.search))

  const routes = data || []

  useEffect(() => {
    const onHash = () => setHashFilter(parseHashFilter(window.location.hash || window.location.search))
    window.addEventListener('hashchange', onHash)
    window.addEventListener('popstate', onHash)
    return () => window.removeEventListener('popstate', onHash);
      window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    fetch('/api/costs?days=7&groupBy=route')
      .then(r => r.json())
      .then((r: CostsResponse) => {
        const map: Record<string, number> = {}
        for (const a of r.aggregated || []) map[a.key] = a.count
        setTurnsByAgent7d(map)
      })
      .catch(() => {})
  }, [])

  const filteredRoutes = useMemo(() => {
    if (!hashFilter) return routes.map((r, index) => ({ r, index }))
    return routes
      .map((r, index) => ({ r, index }))
      .filter(({ r }) => {
        if (hashFilter.type === 'agent') return r.workspace === hashFilter.value
        if (hashFilter.type === 'channel') return r.channel === hashFilter.value
        return true
      })
  }, [routes, hashFilter])

  const clearHashFilter = () => {
    setHashFilter(null)
    if (window.location.hash.includes('?')) {
      window.history.replaceState(null, '', '#/routes')
    }
  }

  useEffect(() => {
    api.agents().then(agents => {
      setAgentNames(agents.map((a: { name: string }) => a.name))
    }).catch(() => {})
  }, [])

  useEffect(() => {
    api.dashboardState().then(d => {
      setProcesses(d.processes as typeof processes)
    }).catch(() => {})
  }, [])

  const routeActiveSessions = (r: FullRoute) => {
    if (r.channel === '*') return []
    const target = r.group || r.groupRawId || (r.from && r.from !== '*' ? String(r.from) : '')
    return processes.filter(p => {
      if ((p.channel as string | undefined) !== r.channel) return false
      if (target && (p.target as string | undefined) !== target) return false
      return true
    })
  }

  const openDetail = async (index: number) => {
    const route = routes[index]
    if (!route) return
    setDetailClaudeMd(null)
    setDetailIndex(index)
    if (route.workspace && route.workspace !== '—') {
      try {
        const cm = await api.getAgentClaudeMd(route.workspace)
        if (cm.content) {
          setDetailClaudeMd(cm.content.split('\n').slice(0, 25).join('\n'))
        }
      } catch { /* ok */ }
    }
  }

  const openEdit = (index: number) => {
    setDetailIndex(null)
    if (index >= 0) {
      const r = routes[index]
      const matchType = r.group ? 'group' : (r.from && r.from !== '*') ? 'from' : 'all'
      setForm({
        channel: r.channel,
        matchType: matchType as RouteFormState['matchType'],
        from: r.from === '*' ? '' : (r.from || ''),
        group: r.group || '',
        agent: r.workspace || '',
      })
      setIsNew(false)
    } else {
      setForm({ ...emptyForm, agent: agentNames[0] || '' })
      setIsNew(true)
    }
    setErrors({})
    setEditIndex(index)
  }

  const validate = (): boolean => {
    const errs: Record<string, string> = {}
    if (!form.agent) errs.agent = 'Select an agent'
    if (form.matchType === 'from' && !form.from) errs.from = 'Enter a user ID or phone number'
    if (form.matchType === 'group' && !form.group) errs.group = 'Enter a group JID'
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const save = async () => {
    if (!validate()) return
    setSaving(true)
    try {
      const payload: Record<string, string> = { channel: form.channel, use: form.agent }
      if (form.matchType === 'from' && form.from) payload.from = form.from
      if (form.matchType === 'group' && form.group) payload.group = form.group
      if (isNew) {
        await api.createRoute(payload)
        onToast('Route created', 'success')
      } else if (editIndex !== null && editIndex >= 0) {
        await api.updateRoute(editIndex, payload)
        onToast('Route updated', 'success')
      }
      setEditIndex(null)
      refresh()
    } catch {
      onToast('Failed to save route', 'error')
    }
    setSaving(false)
  }

  const confirmDelete = async () => {
    if (deleteIndex === null) return
    try {
      await api.deleteRoute(deleteIndex)
      onToast('Route deleted', 'success')
      setDeleteIndex(null)
      setDetailIndex(null)
      refresh()
    } catch {
      onToast('Failed to delete route', 'error')
    }
  }

  const duplicate = async (idx: number) => {
    try {
      await api.duplicateRoute(idx)
      onToast('Route duplicated', 'success')
      setDetailIndex(null)
      refresh()
    } catch {
      onToast('Failed to duplicate route', 'error')
    }
  }

  const goToAgent = (name: string) => {
    navigate(`agents?focus=${encodeURIComponent(name)}`)
  }

  const goToChannel = (name: string) => {
    navigate(`channels?focus=${encodeURIComponent(name)}`)
  }

  const placeholderFrom = form.channel === 'whatsapp' ? '+1234567890'
    : form.channel === 'telegram' ? '123456789'
    : 'Discord user ID'
  const placeholderGroup = form.channel === 'whatsapp' ? '120363xxx@g.us' : 'Discord guild ID'

  const detailRoute = detailIndex !== null ? routes[detailIndex] : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        title="Routes"
        count={`${routes.length} ${routes.length === 1 ? 'route' : 'routes'}`}
        description="Map incoming messages to agents. Edit behavior on the agent, not on the route."
        actions={
          <Button variant="primary" size="md" leading={<Plus size={14} />} onClick={() => openEdit(-1)}>
            Add Route
          </Button>
        }
      />

      {hashFilter && (
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
            Filtered by {hashFilter.type}: <strong style={{ color: 'var(--accent-bright)' }}>{hashFilter.value}</strong>
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

      <InfoBox
        title="How routes work"
        tone="neutral"
      >
        A route is a thin matcher: <code style={codeInline}>(channel, from/group/jid) → agent</code>. Everything else
        (model, tools, MCP, fullAccess) lives in the agent's <code style={codeInline}>agent.yaml</code> — click the agent to jump to its config.
      </InfoBox>

      <AlwaysReplyGroups onToast={onToast} />

      {/* Route list */}
      <div
        style={{
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)',
          overflow: 'hidden',
        }}
      >
        {filteredRoutes.map(({ r, index: idx }, listIdx) => {
          const sessions = routeActiveSessions(r)
          const sub = routeSubLabel(r)
          const isJarvis = r.workspace === 'jarvis'
          const turns7d = turnsByAgent7d[r.workspace] || 0
          return (
            <div
              key={idx}
              onClick={() => openDetail(idx)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                cursor: 'pointer',
                padding: '10px 14px',
                borderBottom: listIdx === filteredRoutes.length - 1 ? 'none' : '1px solid var(--border)',
                background: isJarvis ? 'linear-gradient(90deg, var(--jarvis-tint) 0%, transparent 35%)' : 'transparent',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = isJarvis
                  ? 'linear-gradient(90deg, var(--jarvis-tint-strong) 0%, var(--bg-2) 40%)'
                  : 'var(--bg-2)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = isJarvis
                  ? 'linear-gradient(90deg, var(--jarvis-tint) 0%, transparent 35%)'
                  : 'transparent'
              }}
            >
              <span style={{ width: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)' }}>
                <ChannelIcon channel={r.channel} size={18} color="currentColor" />
              </span>
              <div style={{ width: 320, minWidth: 0, overflow: 'hidden' }}>
                <div
                  title={routeLabel(r)}
                  style={{ fontSize: 12, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {routeLabel(r)}
                </div>
                {sub && (
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--text-4)',
                      fontFamily: 'var(--mono)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {sub}
                  </div>
                )}
              </div>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-4)', width: 16, textAlign: 'center' }}>→</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                {r.action === 'ignore' ? (
                  <Badge tone="muted" uppercase>ignored</Badge>
                ) : (
                  <AgentName
                    name={r.workspace}
                    onClick={(e) => { e.stopPropagation(); goToAgent(r.workspace) }}
                  />
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {sessions.length > 0 && (
                  <BadgeLink
                    href={`/sessions?filter=route:${idx}`}
                    tone="ok"
                    size="xs"
                    count={sessions.length}
                    label="active"
                    title={`${sessions.length} active session${sessions.length === 1 ? '' : 's'} on this route`}
                    stopPropagation
                  />
                )}
                {turns7d > 0 && (
                  <BadgeLink
                    href={`/analytics?groupBy=route&period=7d&filter=route:${idx}`}
                    tone="muted"
                    size="xs"
                    count={turns7d}
                    label="msgs 7d"
                    title={`${turns7d} messages handled by ${r.workspace} in the last 7 days`}
                    stopPropagation
                  />
                )}
              </div>
            </div>
          )
        })}
        {filteredRoutes.length === 0 && (
          <div style={{ padding: 40 }}>
            <EmptyState
              title={hashFilter ? `No routes match ${hashFilter.type}=${hashFilter.value}` : 'No routes configured'}
              hint={hashFilter ? 'Clear the filter or adjust the selection.' : 'Add your first route to start mapping messages to agents.'}
            />
          </div>
        )}
      </div>

      {/* Route Detail Panel */}
      <Panel
        open={detailIndex !== null}
        title={detailRoute ? `Route → ${detailRoute.workspace || 'unresolved'}` : ''}
        onClose={() => setDetailIndex(null)}
      >
        {detailRoute && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <Button size="sm" onClick={() => { setDetailIndex(null); openEdit(detailIndex!) }}>Edit Match</Button>
              <Button size="sm" onClick={() => { goToAgent(detailRoute.workspace); setDetailIndex(null) }}>Open Agent →</Button>
              <Button size="sm" onClick={() => { goToChannel(detailRoute.channel); setDetailIndex(null) }}>Open Channel →</Button>
              <Button size="sm" onClick={() => duplicate(detailIndex!)}>Duplicate</Button>
              <Button size="sm" variant="danger-ghost" onClick={() => { setDeleteIndex(detailIndex!); setDetailIndex(null) }}>Delete</Button>
            </div>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <BadgeLink
                href={`/sessions?filter=route:${detailIndex}`}
                tone="accent"
                size="sm"
                count={routeActiveSessions(detailRoute).length}
                label="sessions"
                title="Open this route in the Sessions page"
              />
              <BadgeLink
                href={`/analytics?groupBy=route&period=7d&filter=route:${detailIndex}`}
                tone="muted"
                size="sm"
                count={turnsByAgent7d[detailRoute.workspace] || 0}
                label="msgs 7d"
                title="Analytics breakdown for this route over the last 7 days"
              />
            </div>

            <div>
              <SectionHeader title="Match" />
              <dl style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 6, fontSize: 12, color: 'var(--text-2)', margin: 0 }}>
                <dt style={labelStyle}>Channel</dt>
                <dd style={ddStyle}>{detailRoute.channel}</dd>
                <dt style={labelStyle}>From</dt>
                <dd style={ddStyle}>{String(detailRoute.from || '*')}</dd>
                {detailRoute.group && (
                  <>
                    <dt style={labelStyle}>Group</dt>
                    <dd style={ddStyle}>{detailRoute.group}</dd>
                  </>
                )}
                <dt style={labelStyle}>Agent</dt>
                <dd style={ddStyle}><AgentName name={detailRoute.workspace} /></dd>
              </dl>
              <p style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 12, lineHeight: 1.55 }}>
                Routes are thin matchers — they map an incoming message to an agent by name. Model, tools, MCP,
                fullAccess and identity all live on the agent (<code style={codeInline}>agent.yaml</code> + <code style={codeInline}>CLAUDE.md</code>). Click <strong style={{ color: 'var(--text-2)' }}>Edit Agent</strong> to change behavior across every route that uses it.
              </p>
            </div>

            {detailClaudeMd && (
              <div>
                <SectionHeader title="Agent CLAUDE.md" count="preview" />
                <pre
                  style={{
                    fontSize: 11,
                    padding: 12,
                    borderRadius: 'var(--radius)',
                    background: 'var(--bg-0)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-3)',
                    maxHeight: 300,
                    overflow: 'auto',
                    fontFamily: 'var(--mono)',
                    whiteSpace: 'pre-wrap',
                    margin: 0,
                  }}
                >
                  {detailClaudeMd}
                </pre>
              </div>
            )}

            <div>
              <SectionHeader title="Active Sessions" count={routeActiveSessions(detailRoute).length} />
              {routeActiveSessions(detailRoute).length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-4)' }}>No active sessions</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {routeActiveSessions(detailRoute).map(sp => (
                    <div
                      key={sp.key}
                      style={{
                        padding: 12,
                        borderRadius: 'var(--radius)',
                        background: 'var(--bg-0)',
                        border: '1px solid var(--border)',
                        fontSize: 12,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            background: sp.alive ? 'var(--ok)' : 'var(--err)',
                            boxShadow: sp.alive ? '0 0 6px var(--ok)' : '0 0 6px var(--err)',
                            flexShrink: 0,
                          }}
                        />
                        <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-2)' }}>
                          {sp.key.length > 30 ? sp.key.slice(0, 30) + '…' : sp.key}
                        </span>
                        <span style={{ color: 'var(--text-4)', fontFamily: 'var(--mono)', fontSize: 11 }}>{sp.model}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 12, marginTop: 4, color: 'var(--text-4)', fontSize: 11 }}>
                        <span>{sp.messageCount} turns</span>
                        <span>~{(sp.estimatedTokens / 1000).toFixed(0)}k tok</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Panel>

      {/* Edit/Create Panel */}
      <Panel
        open={editIndex !== null}
        title={isNew ? 'New Route' : 'Edit Route'}
        onClose={() => setEditIndex(null)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Field label="Channel">
            <Select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
              <option value="whatsapp">WhatsApp</option>
              <option value="telegram">Telegram</option>
              <option value="discord">Discord</option>
              <option value="*">Any channel</option>
            </Select>
          </Field>

          <Field label="Match">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {([['from', 'Specific user'], ['group', 'Group / Guild'], ['all', 'All messages']] as const).map(([val, label]) => {
                const isOn = form.matchType === val
                return (
                  <label
                    key={val}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 12px',
                      borderRadius: 'var(--radius)',
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: 'pointer',
                      background: isOn ? 'var(--accent)' : 'var(--bg-3)',
                      color: isOn ? '#fff' : 'var(--text-3)',
                      border: '1px solid ' + (isOn ? 'var(--accent)' : 'var(--border-strong)'),
                      transition: 'background 0.15s, border-color 0.15s',
                    }}
                  >
                    <input
                      type="radio"
                      value={val}
                      checked={isOn}
                      onChange={() => setForm({ ...form, matchType: val })}
                      style={{ display: 'none' }}
                    />
                    {label}
                  </label>
                )
              })}
            </div>
          </Field>

          {form.matchType === 'from' && (
            <Field label="User ID" error={errors.from}>
              <Input
                value={form.from}
                onChange={(e) => setForm({ ...form, from: e.target.value })}
                placeholder={placeholderFrom}
                invalid={!!errors.from}
              />
            </Field>
          )}

          {form.matchType === 'group' && (
            <Field label="Group ID" error={errors.group}>
              <Input
                value={form.group}
                onChange={(e) => setForm({ ...form, group: e.target.value })}
                placeholder={placeholderGroup}
                invalid={!!errors.group}
              />
            </Field>
          )}

          <Field
            label="Agent"
            error={errors.agent}
            hint={
              form.agent ? (
                <>
                  Model, tools, MCP and identity all live on the agent.{' '}
                  <a
                    style={{ color: 'var(--accent-bright)', cursor: 'pointer' }}
                    onClick={() => { setEditIndex(null); goToAgent(form.agent) }}
                  >
                    Edit <code style={codeInline}>{form.agent}</code> →
                  </a>
                </>
              ) : undefined
            }
          >
            <Select
              value={form.agent}
              onChange={(e) => setForm({ ...form, agent: e.target.value })}
              invalid={!!errors.agent}
            >
              <option value="">— Select —</option>
              {agentNames.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </Select>
          </Field>

          <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
            <Button variant="primary" size="md" onClick={save} loading={saving}>Save Route</Button>
            <Button variant="secondary" size="md" onClick={() => setEditIndex(null)}>Cancel</Button>
          </div>
        </div>
      </Panel>

      <Modal
        open={deleteIndex !== null}
        title="Delete Route"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteIndex(null)}
        confirmLabel="Delete"
        danger
      >
        Are you sure you want to delete route #{deleteIndex}?
      </Modal>
    </div>
  )
}

const codeInline: React.CSSProperties = {
  background: 'var(--bg-2)',
  padding: '1px 5px',
  borderRadius: 'var(--radius-xs)',
  fontSize: '0.92em',
  fontFamily: 'var(--mono)',
}

const labelStyle: React.CSSProperties = { color: 'var(--text-4)', margin: 0 }
const ddStyle: React.CSSProperties = { margin: 0, fontFamily: 'var(--mono)', fontSize: 12 }
