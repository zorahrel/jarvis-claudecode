import { useState, useCallback, useEffect } from 'react'
import { ChevronDown, ChevronUp, X, RefreshCw } from 'lucide-react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import type { Channel, DashboardState, Route } from '../api/client'
import { ChannelIcon } from '../icons'
import { PageHeader, SectionHeader } from '../components/ui/PageHeader'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { IconButton } from '../components/ui/IconButton'
import { Badge } from '../components/ui/Badge'
import { AgentName } from '../components/ui/AgentName'
import { InfoBox } from '../components/ui/InfoBox'
import { EmptyState } from '../components/ui/EmptyState'
import { Input } from '../components/ui/Field'

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

export function Channels({ onToast }: { onToast?: (msg: string, type: 'success' | 'error' | 'info') => void }) {
  const fetchChannels = useCallback(() => api.channels(), [])
  const { data: channels, loading, refresh: refreshChannels } = usePolling<Channel[]>(fetchChannels, 30000)

  const fetchState = useCallback(() => api.dashboardState(), [])
  const { data: dashState, refresh: refreshState } = usePolling<DashboardState>(fetchState, 30000)

  const fetchRoutes = useCallback(() => api.routes(), [])
  const { data: routesList, refresh: refreshRoutes } = usePolling<Route[]>(fetchRoutes, 30000)

  const refreshAll = useCallback(() => {
    refreshChannels()
    refreshState()
    refreshRoutes()
  }, [refreshChannels, refreshState, refreshRoutes])

  const [expandedChannel, setExpandedChannel] = useState<string | null>(null)
  const [toggling, setToggling] = useState<Record<string, boolean>>({})
  const [revealedTokens, setRevealedTokens] = useState<Record<string, boolean>>({})

  // WhatsApp-specific config (allowed callers + always-reply groups)
  const [callers, setCallers] = useState<string[]>([])
  const [alwaysReplyGroups, setAlwaysReplyGroups] = useState<string[]>([])
  const [newCaller, setNewCaller] = useState('')
  const [newAlwaysReply, setNewAlwaysReply] = useState('')
  const [addingCaller, setAddingCaller] = useState(false)
  const [addingReply, setAddingReply] = useState(false)

  useEffect(() => {
    apiFetch<Record<string, unknown>>('/api/dashboard-state')
      .then((d) => {
        setCallers((d.callers as string[]) || [])
        setAlwaysReplyGroups((d.alwaysReplyGroups as string[]) || [])
      })
      .catch(() => {})
  }, [])

  const addCaller = async () => {
    const phone = newCaller.trim()
    if (!phone) return
    setAddingCaller(true)
    try {
      const r = await apiFetch<{ callers: string[] }>('/api/config/callers', {
        method: 'POST',
        body: JSON.stringify({ phone }),
      })
      setCallers(r.callers)
      setNewCaller('')
      onToast?.('Caller added: ' + phone, 'success')
    } catch (e: unknown) {
      onToast?.(e instanceof Error ? e.message : String(e), 'error')
    }
    setAddingCaller(false)
  }

  const removeCaller = async (phone: string) => {
    try {
      const r = await apiFetch<{ callers: string[] }>('/api/config/callers/' + encodeURIComponent(phone), {
        method: 'DELETE',
      })
      setCallers(r.callers)
      onToast?.('Caller removed', 'success')
    } catch (e: unknown) {
      onToast?.(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const addAlwaysReply = async () => {
    const group = newAlwaysReply.trim()
    if (!group) return
    setAddingReply(true)
    try {
      const r = await apiFetch<{ groups: string[] }>('/api/config/always-reply', {
        method: 'POST',
        body: JSON.stringify({ group }),
      })
      setAlwaysReplyGroups(r.groups)
      setNewAlwaysReply('')
      onToast?.('Always-reply group added', 'success')
    } catch (e: unknown) {
      onToast?.(e instanceof Error ? e.message : String(e), 'error')
    }
    setAddingReply(false)
  }

  const removeAlwaysReply = async (group: string) => {
    try {
      const r = await apiFetch<{ groups: string[] }>('/api/config/always-reply/' + encodeURIComponent(group), {
        method: 'DELETE',
      })
      setAlwaysReplyGroups(r.groups)
      onToast?.('Group removed', 'success')
    } catch (e: unknown) {
      onToast?.(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  if (loading) return <div style={{ color: 'var(--text-4)' }}>Loading…</div>

  const channelList = channels || []
  const routes = routesList || []
  const processes = dashState?.processes || []

  const activeCount = channelList.filter((c) => c.enabled !== false).length

  const channelActiveSessions = (chName: string) =>
    processes.filter((p) => (p.channel as string | undefined) === chName)

  const toggleChannel = async (ch: Channel) => {
    setToggling((prev) => ({ ...prev, [ch.name]: true }))
    try {
      await api.updateChannel(ch.name, { enabled: ch.enabled === false })
      const nextState = ch.enabled === false ? 'enabled' : 'disabled'
      onToast?.(`${ch.name} ${nextState} — restart router to apply`, 'info')
      refreshChannels()
    } catch {
      onToast?.('Failed to toggle channel', 'error')
    } finally {
      setToggling((prev) => ({ ...prev, [ch.name]: false }))
    }
  }

  const toggleReveal = (key: string) => {
    setRevealedTokens((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Channels"
        count={`${activeCount}/${channelList.length} active`}
        description="Incoming message sources. Routes under each channel show which agent handles what."
        actions={
          <IconButton
            icon={<RefreshCw size={13} />}
            label="Refresh channels"
            onClick={refreshAll}
            disabled={loading}
          />
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 12 }}>
        {channelList.map((ch) => {
          const sessions = channelActiveSessions(ch.name)
          const isExpanded = expandedChannel === ch.name
          const chRoutes = routes.filter((r) => r.channel === ch.name)
          const config = (ch.config || {}) as Record<string, unknown>
          const statusDotColor = ch.status === 'ok'
            ? 'var(--ok)'
            : ch.status === 'disabled'
              ? 'var(--text-4)'
              : 'var(--err)'

          return (
            <Card
              key={ch.name}
              active={isExpanded}
              padding={0}
            >
              {/* Header */}
              <div
                onClick={() => setExpandedChannel(isExpanded ? null : ch.name)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '14px 16px',
                  cursor: 'pointer',
                  borderBottom: isExpanded ? '1px solid var(--border)' : 'none',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', color: 'var(--text-2)' }}>
                  <ChannelIcon channel={ch.name} size={20} color="currentColor" />
                </span>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-1)', textTransform: 'capitalize' }}>
                  {ch.name}
                </span>
                <span
                  title={ch.status === 'ok' ? 'Connected' : ch.status || 'unknown'}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: statusDotColor,
                    boxShadow: ch.status === 'ok' ? '0 0 6px rgba(39,166,68,0.4)' : undefined,
                  }}
                />
                {sessions.length > 0 ? (
                  <Badge tone="ok" size="xs" style={{ marginLeft: 'auto' }}>
                    {sessions.length} session{sessions.length > 1 ? 's' : ''}
                  </Badge>
                ) : (
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 11,
                      color: 'var(--text-4)',
                    }}
                  >
                    {chRoutes.length} {chRoutes.length === 1 ? 'route' : 'routes'}
                  </span>
                )}
                <span
                  aria-hidden
                  style={{ display: 'inline-flex', color: 'var(--text-4)', marginLeft: sessions.length > 0 ? 6 : 0 }}
                >
                  {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                </span>
              </div>

              {/* Routes */}
              <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {chRoutes.length === 0 ? (
                  <div style={{ fontSize: 11, color: 'var(--text-4)' }}>No routes on this channel</div>
                ) : (
                  chRoutes.map((r, rIdx) => {
                    const rx = r as Record<string, unknown>
                    const agent = rx.agent as Record<string, unknown> | undefined
                    const agentName = String(rx.use || agent?.name || rx.workspace || '(unresolved)')
                    const isJarvis = agentName === 'jarvis'
                    const label = rx.group
                      ? String(rx.groupLabel || String(rx.group).replace(/@g\.us$/, ''))
                      : rx.from !== '*'
                        ? String(rx.fromLabel || rx.from || '*')
                        : '*'
                    const rawId = rx.group
                      ? (rx.groupLabel && String(rx.groupRawId || rx.group).replace(/@g\.us$/, '') !== rx.groupLabel
                          ? String(rx.groupRawId || rx.group).replace(/@g\.us$/, '')
                          : '')
                      : (rx.from && rx.from !== '*' && rx.fromLabel && String(rx.fromRawId || rx.from) !== rx.fromLabel
                          ? String(rx.fromRawId || rx.from)
                          : '')

                    return (
                      <div
                        key={rIdx}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr auto',
                          gap: 8,
                          alignItems: 'center',
                          fontSize: 12,
                          padding: '6px 10px',
                          background: isJarvis
                            ? 'linear-gradient(90deg, var(--jarvis-tint-strong) 0%, var(--jarvis-tint) 100%)'
                            : 'var(--surface-subtle)',
                          borderRadius: 'var(--radius-sm)',
                          border: `1px solid ${isJarvis ? 'var(--jarvis-border)' : 'var(--border)'}`,
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <span style={{ color: 'var(--text-2)' }}>{label}</span>
                          {rawId && (
                            <span style={{ color: 'var(--text-4)', fontSize: 10, fontFamily: 'var(--mono)', marginLeft: 6 }}>
                              {rawId}
                            </span>
                          )}
                        </div>
                        <AgentName
                          name={agentName}
                          size="xs"
                          onClick={(e) => {
                            e.stopPropagation()
                            window.location.hash = 'agents'
                          }}
                        />
                      </div>
                    )
                  })
                )}
              </div>

              {/* Expanded */}
              {isExpanded && (
                <div style={{ padding: '0 16px 14px' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginTop: 4,
                      marginBottom: 10,
                    }}
                  >
                    <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                      {ch.enabled !== false ? 'Channel enabled' : 'Channel disabled'}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={(e) => { e.stopPropagation(); toggleChannel(ch) }}
                      disabled={toggling[ch.name]}
                    >
                      {ch.enabled !== false ? 'Disable' : 'Enable'}
                    </Button>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {Object.entries(config).map(([k, v]) => {
                      const isToken = k.toLowerCase().includes('token')
                      const revealKey = `${ch.name}:${k}`
                      const isRevealed = revealedTokens[revealKey]
                      return (
                        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                          <span style={{ color: 'var(--text-4)', minWidth: 70 }}>{k}</span>
                          {isToken ? (
                            <span style={{ color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
                              {isRevealed ? String(v) : v === '***set***' ? 'set' : '••••'}
                              <button
                                style={{
                                  fontSize: 10,
                                  padding: '0 4px',
                                  background: 'transparent',
                                  border: 'none',
                                  color: 'var(--accent-bright)',
                                  cursor: 'pointer',
                                }}
                                onClick={(e) => { e.stopPropagation(); toggleReveal(revealKey) }}
                              >
                                {isRevealed ? 'hide' : 'show'}
                              </button>
                            </span>
                          ) : (
                            <span style={{ color: 'var(--text-2)', fontFamily: 'var(--mono)', fontSize: 10 }}>
                              {String(v)}
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  <InfoBox tone="warn" style={{ marginTop: 10, padding: '6px 10px', fontSize: 10 }}>
                    Enable/disable requires router restart.
                  </InfoBox>
                  <div style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 6 }}>
                    Edit channel settings in{' '}
                    <a
                      style={{ color: 'var(--accent-bright)', cursor: 'pointer' }}
                      onClick={(e) => { e.stopPropagation(); window.location.hash = 'settings' }}
                    >
                      config.yaml
                    </a>.
                  </div>

                  {/* WhatsApp-specific: callers + always-reply groups */}
                  {ch.name === 'whatsapp' && (
                    <>
                      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                        <SectionHeader title="Allowed callers" count={callers.length} />
                        <div style={{ fontSize: 11, color: 'var(--text-4)', marginBottom: 8, lineHeight: 1.5 }}>
                          Phone numbers authorized for voice calls.
                        </div>
                        {callers.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                            {callers.map((c) => (
                              <div
                                key={c}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '5px 10px',
                                  fontSize: 12,
                                  background: 'var(--bg-0)',
                                  border: '1px solid var(--border)',
                                  borderRadius: 'var(--radius-sm)',
                                }}
                              >
                                <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-2)', flex: 1 }}>{c}</span>
                                <Button size="xs" variant="danger-ghost" onClick={(e) => { e.stopPropagation(); removeCaller(c) }}><X size={12} /></Button>
                              </div>
                            ))}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                          <Input
                            type="text"
                            value={newCaller}
                            onChange={(e) => setNewCaller(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && addCaller()}
                            placeholder="+1234567890"
                            style={{ flex: 1, padding: '5px 10px', fontSize: 11 }}
                          />
                          <Button size="xs" variant="primary" onClick={(e) => { e.stopPropagation(); addCaller() }} loading={addingCaller}>
                            Add
                          </Button>
                        </div>
                      </div>

                      <div style={{ marginTop: 14 }}>
                        <SectionHeader title="Always-reply groups" count={alwaysReplyGroups.length} />
                        <div style={{ fontSize: 11, color: 'var(--text-4)', marginBottom: 8, lineHeight: 1.5 }}>
                          Groups where Jarvis replies to every message.
                        </div>
                        {alwaysReplyGroups.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                            {alwaysReplyGroups.map((g) => (
                              <div
                                key={g}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '5px 10px',
                                  fontSize: 12,
                                  background: 'var(--bg-0)',
                                  border: '1px solid var(--border)',
                                  borderRadius: 'var(--radius-sm)',
                                }}
                              >
                                <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-2)', fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }} title={g}>
                                  {g}
                                </span>
                                <Button size="xs" variant="danger-ghost" onClick={(e) => { e.stopPropagation(); removeAlwaysReply(g) }}><X size={12} /></Button>
                              </div>
                            ))}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                          <Input
                            type="text"
                            value={newAlwaysReply}
                            onChange={(e) => setNewAlwaysReply(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && addAlwaysReply()}
                            placeholder="120363xxx@g.us"
                            style={{ flex: 1, padding: '5px 10px', fontSize: 11 }}
                          />
                          <Button size="xs" variant="primary" onClick={(e) => { e.stopPropagation(); addAlwaysReply() }} loading={addingReply}>
                            Add
                          </Button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </Card>
          )
        })}
      </div>

      {channelList.length === 0 && (
        <EmptyState title="No channels configured" hint="Add a Telegram, WhatsApp, or Discord token in config.yaml." />
      )}
    </div>
  )
}
