import { useState, useCallback, useEffect, useMemo } from 'react'
import { navigate } from '../lib/url-state'
import { Plus, RefreshCw } from 'lucide-react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { Panel } from '../components/Panel'
import { Modal } from '../components/Modal'
import { PageHeader, SectionHeader } from '../components/ui/PageHeader'
import { Card } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { IconButton } from '../components/ui/IconButton'
import { AgentName } from '../components/ui/AgentName'
import { EmptyState } from '../components/ui/EmptyState'
import { InfoBox } from '../components/ui/InfoBox'
import { Field, Input } from '../components/ui/Field'
import { BadgeLink } from '../components/BadgeLink'
import type { Tool, ToolsResponse, FullRoute, FullAgent, McpPendingServer } from '../api/client'
import { ChannelIcon, ToolIcon } from '../icons'

const MCP_STATUS_HELP: Record<string, string> = {
  connected: 'Handshake succeeded — server is reachable and tools are live.',
  auth: 'Server reachable but asked for OAuth / an API key. Run the server\'s `authenticate` tool from a privileged agent, or set the token in config.yaml.',
  failed: 'Could not reach the MCP server — command missing, port closed, or crashed at startup. Check the router logs.',
}

interface EmailAccount {
  email: string
  account: string
}

interface ToolDef extends Tool {
  id: string
  type: string
  label: string
  icon?: string
}

interface McpServerStatus {
  name: string
  target: string
  status: 'connected' | 'auth' | 'failed'
  statusText: string
}

function categorizeTools(tools: ToolDef[]): Record<string, ToolDef[]> {
  return {
    Media: tools.filter(t => ['vision', 'voice', 'documents'].includes(t.id)),
    Email: tools.filter(t => t.id.startsWith('email:')),
    Calendar: tools.filter(t => t.id.startsWith('calendar:')),
    Memory: tools.filter(t => t.id.startsWith('memory:')),
    System: tools.filter(t => ['subagents', 'fileAccess:full', 'fileAccess:readonly', 'config', 'launchAgents'].includes(t.id)),
    MCP: tools.filter(t => t.type === 'mcp'),
  }
}

const categoryLabels: Record<string, string> = {
  Media: 'Media & Processing',
  Email: 'Email Accounts',
  Calendar: 'Calendar Accounts',
  Memory: 'Memory Scopes',
  System: 'System Capabilities',
  MCP: 'MCP Servers',
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

export function Tools({ onToast }: { onToast?: (msg: string, type: 'success' | 'error' | 'info') => void } = {}) {
  const fetchTools = useCallback(() => api.tools(), [])
  const { data, loading, refresh } = usePolling<ToolsResponse>(fetchTools, 10000)

  const [routes, setRoutes] = useState<FullRoute[]>([])
  const [agents, setAgents] = useState<FullAgent[]>([])
  const [selectedTool, setSelectedTool] = useState<ToolDef | null>(null)

  // MCP auth/connection status from `claude mcp list`
  const [mcpStatus, setMcpStatus] = useState<Record<string, McpServerStatus>>({})

  const loadMcpStatus = useCallback(async () => {
    try {
      const r = await apiFetch<{ servers: McpServerStatus[] }>('/api/mcp-status')
      const map: Record<string, McpServerStatus> = {}
      for (const s of r.servers || []) map[s.name] = s
      setMcpStatus(map)
    } catch { /* silent */ }
  }, [])

  useEffect(() => { loadMcpStatus() }, [loadMcpStatus])

  // Pending MCPs — servers parked in ~/.claude/mcp-pending.json that need
  // explicit OAuth approval before being committed back to ~/.claude.json.
  // Until approved, they don't appear in any Claude session (dashboard, Topics,
  // a new CLI chat), and the router doesn't attach them to SDK spawns — so
  // no unsolicited browser popups.
  const [pendingMcps, setPendingMcps] = useState<McpPendingServer[]>([])
  const [approving, setApproving] = useState<Set<string>>(new Set())

  const loadPendingMcps = useCallback(async () => {
    try {
      setPendingMcps(await api.mcpPending())
    } catch { /* silent */ }
  }, [])

  useEffect(() => { loadPendingMcps() }, [loadPendingMcps])

  const approveMcp = useCallback(async (name: string) => {
    setApproving((s) => new Set(s).add(name))
    onToast?.(`Opening OAuth for ${name}…`, 'info')
    try {
      const r = await api.mcpApprovePending(name)
      if (r.ok) {
        onToast?.(`${name}: approved and live ✓`, 'success')
        await Promise.all([loadPendingMcps(), loadMcpStatus(), refresh()])
      } else {
        onToast?.(`${name}: ${r.reason ?? 'approve failed'}`, 'error')
      }
    } catch (e) {
      onToast?.(`${name}: ${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      setApproving((s) => { const n = new Set(s); n.delete(name); return n })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPendingMcps, loadMcpStatus])

  // Per-server action state — disable button + show spinner while in flight.
  const [mcpActionInflight, setMcpActionInflight] = useState<Record<string, "auth" | "restart" | "logout" | null>>({})

  const authenticateMcp = useCallback(async (name: string) => {
    setMcpActionInflight(prev => ({ ...prev, [name]: "auth" }))
    try {
      const r = await apiFetch<{ ok: boolean; reason?: string }>("/api/mcp/authenticate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
      onToast?.(r.ok ? `${name}: authenticated` : `${name}: ${r.reason ?? "auth failed"}`, r.ok ? "success" : "error")
    } catch (e: any) {
      onToast?.(`${name}: ${e?.message ?? "auth failed"}`, "error")
    } finally {
      setMcpActionInflight(prev => ({ ...prev, [name]: null }))
      loadMcpStatus()
    }
  }, [loadMcpStatus, onToast])

  const restartMcp = useCallback(async (name: string) => {
    setMcpActionInflight(prev => ({ ...prev, [name]: "restart" }))
    try {
      const r = await apiFetch<{ ok: boolean; killed?: string; error?: string }>("/api/mcp/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
      onToast?.(r.ok ? `${name}: restarted (killed ${r.killed})` : `${name}: ${r.error ?? "restart failed"}`, r.ok ? "success" : "error")
    } catch (e: any) {
      onToast?.(`${name}: ${e?.message ?? "restart failed"}`, "error")
    } finally {
      setMcpActionInflight(prev => ({ ...prev, [name]: null }))
      loadMcpStatus()
    }
  }, [loadMcpStatus, onToast])

  const disconnectMcp = useCallback(async (name: string) => {
    if (!confirm(`Disconnect "${name}"?\n\nThis clears the stored OAuth credentials. Click Authenticate to reconnect.`)) return
    setMcpActionInflight(prev => ({ ...prev, [name]: "logout" }))
    try {
      const r = await apiFetch<{ ok: boolean; reason?: string }>("/api/mcp/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
      onToast?.(r.ok ? `${name}: disconnected` : `${name}: ${r.reason ?? "disconnect failed"}`, r.ok ? "success" : "error")
    } catch (e: any) {
      onToast?.(`${name}: ${e?.message ?? "disconnect failed"}`, "error")
    } finally {
      setMcpActionInflight(prev => ({ ...prev, [name]: null }))
      loadMcpStatus()
    }
  }, [loadMcpStatus, onToast])

  // Email/Calendar account management
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([])
  const [addAccountOpen, setAddAccountOpen] = useState(false)
  const [newEmailAddr, setNewEmailAddr] = useState('')
  const [newEmailAccount, setNewEmailAccount] = useState('')
  const [newServices, setNewServices] = useState<string[]>(['gmail', 'calendar', 'drive'])
  const [addingEmail, setAddingEmail] = useState(false)
  const [removingEmail, setRemovingEmail] = useState<string | null>(null)
  // OAuth status per account (from `gws auth status`), keyed by alias
  const [gwsStatus, setGwsStatus] = useState<Record<string, { authed: boolean; scopeCount: number }>>({})
  const [authingAccount, setAuthingAccount] = useState<string | null>(null)

  const toast = onToast || (() => {})

  const loadEmailAccounts = useCallback(async () => {
    try {
      const r = await apiFetch<{ accounts: EmailAccount[] }>('/api/config/email-accounts')
      setEmailAccounts(r.accounts || [])
    } catch { /* silent */ }
  }, [])

  const loadGwsStatus = useCallback(async () => {
    try {
      const r = await apiFetch<{ accounts: { account: string; authed: boolean; scopeCount: number }[] }>('/api/gws/accounts')
      const map: Record<string, { authed: boolean; scopeCount: number }> = {}
      for (const a of r.accounts || []) map[a.account] = { authed: a.authed, scopeCount: a.scopeCount }
      setGwsStatus(map)
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    api.routesFull().then(setRoutes).catch(() => {})
    api.agentsFull().then(setAgents).catch(() => {})
    loadEmailAccounts()
    loadGwsStatus()
  }, [loadEmailAccounts, loadGwsStatus])

  // Run the OAuth browser flow for an alias, then refresh status.
  const authenticateAccount = useCallback(async (account: string, services: string[]) => {
    setAuthingAccount(account)
    toast(`Opening Google login for ${account} — complete it in the browser…`, 'info')
    try {
      await apiFetch('/api/gws/auth-login', {
        method: 'POST',
        body: JSON.stringify({ account, services }),
      })
      toast(`${account}: authenticated ✓`, 'success')
      await loadGwsStatus()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    }
    setAuthingAccount(null)
  }, [loadGwsStatus, toast])

  const agentsByTool = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const a of agents) {
      for (const tid of a.tools || []) {
        if (!map[tid]) map[tid] = []
        map[tid].push(a.name)
      }
    }
    return map
  }, [agents])

  const addEmailAccount = async () => {
    const email = newEmailAddr.trim()
    const account = newEmailAccount.trim()
    if (!email || !account) {
      toast('Email and account name required', 'error')
      return
    }
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(account)) {
      toast('Shortname must be lowercase letters, digits or dashes', 'error')
      return
    }
    setAddingEmail(true)
    try {
      await apiFetch('/api/config/email-accounts', {
        method: 'POST',
        body: JSON.stringify({ email, account }),
      })
      toast('Account added — starting Google login…', 'success')
      loadEmailAccounts()
      refresh()
      setAddAccountOpen(false)
      // Kick off the OAuth browser flow with the chosen scopes.
      await authenticateAccount(account, newServices)
      setNewEmailAddr('')
      setNewEmailAccount('')
      setNewServices(['gmail', 'calendar', 'drive'])
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    }
    setAddingEmail(false)
  }

  const confirmRemoveEmail = async () => {
    if (!removingEmail) return
    try {
      await apiFetch('/api/config/email-accounts/' + encodeURIComponent(removingEmail), { method: 'DELETE' })
      toast('Email account removed', 'success')
      setRemovingEmail(null)
      loadEmailAccounts()
      refresh()
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  if (loading || !data) return <div style={{ color: 'var(--text-4)' }}>Loading…</div>

  const tools = (data.tools || []) as ToolDef[]
  const routeMap = data.byRoute || data.routeMap || {}

  // Treat parked-but-pending MCPs as ordinary tool cards so the user sees them
  // alongside the live ones. They carry a `_pending` marker so the card render
  // can swap the status badge to "pending" and the action button to
  // "Approve & Authorize" instead of the normal Authenticate/Disconnect set.
  const pendingPseudoTools: (ToolDef & { _pending: McpPendingServer })[] = pendingMcps.map((p) => ({
    id: `mcp:${p.name}`,
    type: 'mcp',
    label: p.name,
    mcpConfig: { type: 'stdio', command: 'npx', args: ['-y', 'mcp-remote', p.url] },
    _pending: p,
  } as ToolDef & { _pending: McpPendingServer }))

  const augmentedTools: ToolDef[] = [...tools, ...pendingPseudoTools]
  const categories = categorizeTools(augmentedTools)

  const toolRoutesCount = (toolId: string) => (routeMap[toolId] || []).length

  const typeBadge = (tool: ToolDef) => {
    if (tool.type === 'mcp') {
      return tool.mcpConfig?.url ? 'HTTP' : 'command'
    }
    return tool.type
  }

  const mcpSubline = (tool: ToolDef) => {
    if (!tool.mcpConfig) return ''
    if (tool.mcpConfig.url) return tool.mcpConfig.url
    const cmd = tool.mcpConfig.command || ''
    const args = (tool.mcpConfig.args || []).join(' ')
    return `${cmd} ${args}`.trim()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <PageHeader
        title="Tools"
        count={`${tools.length} available`}
        description="Capabilities available to agents. Click a tool to see which routes use it."
        actions={
          <IconButton
            icon={<RefreshCw size={13} />}
            label="Refresh tools"
            onClick={() => { refresh(); loadEmailAccounts(); loadGwsStatus(); loadMcpStatus() }}
            disabled={loading}
          />
        }
      />

      {Object.entries(categories).map(([cat, catTools]) => {
        const isEmailOrCal = cat === 'Email' || cat === 'Calendar'
        if (!catTools.length && !isEmailOrCal) return null
        return (
          <div key={cat}>
            <SectionHeader
              title={categoryLabels[cat] || cat}
              count={catTools.length}
              action={
                isEmailOrCal ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    leading={<Plus size={12} />}
                    onClick={() => setAddAccountOpen(true)}
                  >
                    Add account
                  </Button>
                ) : undefined
              }
            />
            {isEmailOrCal && catTools.length === 0 ? (
              <EmptyState
                title={`No ${cat === 'Email' ? 'email' : 'calendar'} accounts connected`}
                hint="Click Add account to connect a Gmail account via gws-mail."
                variant="dashed"
              />
            ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 10 }}>
              {catTools.map(t => (
                <Card key={t.id} interactive padding="14px 16px" onClick={() => setSelectedTool(t)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ display: 'flex', color: 'var(--text-2)' }}>{<ToolIcon id={t.id} type={t.type} />}</span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)', flex: 1, minWidth: 0 }}>
                      {t.label}
                    </span>
                    {cat === 'MCP' && (() => {
                      const serverName = t.id.replace(/^mcp:/, '')
                      const pendingMeta = (t as ToolDef & { _pending?: McpPendingServer })._pending
                      if (pendingMeta) {
                        return (
                          <Badge
                            tone="warn"
                            size="xs"
                            title={`Parked in ~/.claude/mcp-pending.json. Click "Approve & Authorize" to OAuth and commit it to ~/.claude.json — then it becomes visible to every Claude session.`}
                          >
                            pending
                          </Badge>
                        )
                      }
                      const st = mcpStatus[serverName]
                      if (!st) return null
                      const tone = st.status === 'connected' ? 'ok' : st.status === 'auth' ? 'warn' : 'err'
                      const label = st.status === 'connected' ? 'connected' : st.status === 'auth' ? 'needs auth' : 'failed'
                      const help = MCP_STATUS_HELP[st.status] || ''
                      return <Badge tone={tone} size="xs" title={`${st.statusText}${help ? '\n\n' + help : ''}`}>{label}</Badge>
                    })()}
                    <Badge tone="neutral" size="xs">{typeBadge(t)}</Badge>
                  </div>

                  {cat === 'MCP' ? (
                    <div
                      style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 10,
                        color: 'var(--text-4)',
                        marginBottom: 8,
                        maxHeight: 28,
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {mcpSubline(t)}
                    </div>
                  ) : t.command ? (
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-4)', marginBottom: 8 }}>
                      {t.command}
                    </div>
                  ) : t.description ? (
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8, lineHeight: 1.5 }}>
                      {t.description}
                    </div>
                  ) : null}

                  {cat === 'MCP' && (() => {
                    const serverName = t.id.replace(/^mcp:/, '')
                    const pendingMeta = (t as ToolDef & { _pending?: McpPendingServer })._pending
                    if (pendingMeta) {
                      const isApproving = approving.has(serverName)
                      return (
                        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }} onClick={e => e.stopPropagation()}>
                          <Button
                            size="xs"
                            variant="primary"
                            disabled={isApproving}
                            onClick={() => approveMcp(serverName)}
                            title="Open OAuth, complete in browser, then add this server to ~/.claude.json"
                          >
                            {isApproving ? 'Opening OAuth…' : 'Approve & Authorize'}
                          </Button>
                        </div>
                      )
                    }
                    const st = mcpStatus[serverName]
                    if (!st) return null
                    const inflight = mcpActionInflight[serverName]
                    return (
                      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }} onClick={e => e.stopPropagation()}>
                        {st.status === 'auth' && (
                          <Button
                            size="xs"
                            variant="primary"
                            disabled={!!inflight}
                            onClick={() => authenticateMcp(serverName)}
                          >
                            {inflight === 'auth' ? 'Authenticating…' : 'Authenticate'}
                          </Button>
                        )}
                        {st.status === 'connected' && (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={!!inflight}
                            onClick={() => disconnectMcp(serverName)}
                            title="Clear stored OAuth credentials"
                          >
                            {inflight === 'logout' ? 'Disconnecting…' : 'Disconnect'}
                          </Button>
                        )}
                        {st.status !== 'connected' && (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={!!inflight}
                            onClick={() => restartMcp(serverName)}
                          >
                            {inflight === 'restart' ? 'Restarting…' : 'Restart'}
                          </Button>
                        )}
                      </div>
                    )
                  })()}
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <Badge tone="accent" size="xs">{toolRoutesCount(t.id)} routes</Badge>
                    {(agentsByTool[t.id] || []).length > 0 && (
                      <BadgeLink
                        href={`/agents?filter=tool:${encodeURIComponent(t.id)}`}
                        tone="neutral"
                        size="xs"
                        count={agentsByTool[t.id].length}
                        label="agents"
                        title={`Agents using this tool: ${agentsByTool[t.id].join(', ')}`}
                        stopPropagation
                      />
                    )}
                    {(routeMap[t.id] || []).slice(0, 6).map((rIdx: number) => {
                      const workspace = routes[rIdx]?.workspace
                      const isJarvis = workspace === 'jarvis'
                      return (
                        <BadgeLink
                          key={rIdx}
                          href={`/agents?focus=${encodeURIComponent(workspace || '')}`}
                          tone={isJarvis ? 'jarvis' : 'muted'}
                          size="xs"
                          label={workspace || `#${rIdx}`}
                          stopPropagation
                        />
                      )
                    })}
                  </div>
                </Card>
              ))}
            </div>
            )}
          </div>
        )
      })}

      {tools.length === 0 && (
        <EmptyState title="No tools registered" hint="Tools come from MCP servers and CLI bindings." />
      )}

      {/* Tool Detail Panel */}
      <Panel
        open={selectedTool !== null}
        title={selectedTool ? selectedTool.label : ''}
        onClose={() => setSelectedTool(null)}
      >
        {selectedTool && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div>
              <SectionHeader title="Info" />
              <dl style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 6, fontSize: 12, color: 'var(--text-2)', margin: 0 }}>
                <dt style={{ color: 'var(--text-4)', margin: 0 }}>ID</dt>
                <dd style={{ margin: 0, fontFamily: 'var(--mono)' }}>{selectedTool.id}</dd>
                <dt style={{ color: 'var(--text-4)', margin: 0 }}>Type</dt>
                <dd style={{ margin: 0 }}>{selectedTool.type}</dd>
                <dt style={{ color: 'var(--text-4)', margin: 0 }}>Description</dt>
                <dd style={{ margin: 0 }}>{selectedTool.description || '—'}</dd>
                {selectedTool.command && (
                  <>
                    <dt style={{ color: 'var(--text-4)', margin: 0 }}>Command</dt>
                    <dd style={{ margin: 0, fontFamily: 'var(--mono)' }}>{selectedTool.command}</dd>
                  </>
                )}
                {selectedTool.mcpConfig?.url && (
                  <>
                    <dt style={{ color: 'var(--text-4)', margin: 0 }}>URL</dt>
                    <dd style={{ margin: 0, fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>{selectedTool.mcpConfig.url}</dd>
                  </>
                )}
              </dl>
            </div>

            {/* Remove account action for email:/calendar: tools */}
            {(selectedTool.id.startsWith('email:') || selectedTool.id.startsWith('calendar:')) && (() => {
              const shortname = selectedTool.id.split(':')[1]
              const account = emailAccounts.find(ea => ea.account === shortname)
              if (!account) return null
              return (
                <div>
                  <SectionHeader title="Account" />
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 12px',
                      background: 'var(--bg-0)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{account.email}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-4)', fontFamily: 'var(--mono)' }}>
                        {account.account}
                      </div>
                    </div>
                    <Button
                      size="xs"
                      variant="danger-ghost"
                      onClick={() => setRemovingEmail(account.email)}
                    >
                      Remove
                    </Button>
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 6, lineHeight: 1.5 }}>
                    Removing also deletes the paired {selectedTool.id.startsWith('email:') ? 'calendar' : 'email'} tool.
                  </div>
                </div>
              )
            })()}

            <div>
              <SectionHeader title="Used by Routes" count={(routeMap[selectedTool.id] || []).length} />
              {!routeMap[selectedTool.id]?.length ? (
                <div style={{ fontSize: 12, color: 'var(--text-4)' }}>No routes use this tool</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(routeMap[selectedTool.id] || []).map((rIdx: number) => {
                    const route = routes[rIdx]
                    return (
                      <Card
                        key={rIdx}
                        interactive
                        padding="10px 12px"
                        onClick={() => {
                          setSelectedTool(null)
                          navigate(`agents?focus=${encodeURIComponent(route?.workspace || '')}`)
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ display: 'flex', color: 'var(--text-3)' }}>
                            <ChannelIcon channel={route?.channel || ''} size={16} color="currentColor" />
                          </span>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontSize: 12, fontWeight: 500 }}>
                              <AgentName name={route?.workspace} size="xs" />
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-4)' }}>
                              {route ? `${route.channel} ${route.from !== '*' ? route.from : route.group || '*'}` : `#${rIdx}`}
                            </div>
                          </div>
                        </div>
                      </Card>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </Panel>

      {/* Add email/calendar account */}
      <Panel open={addAccountOpen} title="Add email / calendar account" onClose={() => setAddAccountOpen(false)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <InfoBox title="How it works">
            Connect a Google account via <code style={codeInlineStyle}>gws-mail</code>. On submit, the
            Google login opens in your browser — authorize it and the account is live. Adding one creates
            both <code style={codeInlineStyle}>email:xxx</code> and <code style={codeInlineStyle}>calendar:xxx</code> tools.
          </InfoBox>

          <Field label="Email address">
            <Input
              type="text"
              value={newEmailAddr}
              onChange={(e) => setNewEmailAddr(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addEmailAccount()}
              placeholder="user@gmail.com"
            />
          </Field>

          <Field label="gws-mail shortname" hint="Short alias used as gws-mail <shortname> (a-z, 0-9, dash)">
            <Input
              type="text"
              value={newEmailAccount}
              onChange={(e) => setNewEmailAccount(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addEmailAccount()}
              placeholder="myaccount"
            />
          </Field>

          <Field label="Scopes" hint="Which Google services this account can access">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {[
                { id: 'gmail', label: 'Gmail' },
                { id: 'calendar', label: 'Calendar' },
                { id: 'drive', label: 'Drive' },
                { id: 'docs', label: 'Docs' },
                { id: 'sheets', label: 'Sheets' },
              ].map((s) => {
                const on = newServices.includes(s.id)
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setNewServices((prev) => on ? prev.filter((x) => x !== s.id) : [...prev, s.id])}
                    style={{
                      padding: '5px 12px',
                      fontSize: 12,
                      cursor: 'pointer',
                      borderRadius: 'var(--radius)',
                      border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border)'),
                      background: on ? 'var(--accent-dim, var(--bg-2))' : 'var(--bg-0)',
                      color: on ? 'var(--accent)' : 'var(--text-3)',
                    }}
                  >
                    {on ? '✓ ' : ''}{s.label}
                  </button>
                )
              })}
            </div>
          </Field>

          {emailAccounts.length > 0 && (
            <div>
              <SectionHeader title="Currently connected" count={emailAccounts.length} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {emailAccounts.map((ea) => {
                  const st = gwsStatus[ea.account]
                  const busy = authingAccount === ea.account
                  return (
                    <div
                      key={ea.email}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 12px',
                        fontSize: 12,
                        background: 'var(--bg-0)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius)',
                      }}
                    >
                      <span style={{ flex: 1 }}>{ea.email}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-4)', fontFamily: 'var(--mono)' }}>({ea.account})</span>
                      <Badge tone={st?.authed ? 'ok' : 'warn'}>
                        {st === undefined ? '…' : st.authed ? '✓ authed' : '⚠ not authed'}
                      </Badge>
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={busy}
                        onClick={() => authenticateAccount(ea.account, newServices)}
                      >
                        {st?.authed ? 'Re-auth' : 'Authenticate'}
                      </Button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="primary"
              size="md"
              onClick={addEmailAccount}
              loading={addingEmail || authingAccount !== null}
              disabled={!newEmailAddr.trim() || !newEmailAccount.trim() || newServices.length === 0}
            >
              Connect & authenticate
            </Button>
            <Button variant="secondary" size="md" onClick={() => setAddAccountOpen(false)}>Cancel</Button>
          </div>
        </div>
      </Panel>

      {/* Remove email account confirmation */}
      <Modal
        open={removingEmail !== null}
        title="Remove email account"
        confirmLabel="Remove"
        danger
        onConfirm={confirmRemoveEmail}
        onCancel={() => setRemovingEmail(null)}
      >
        Remove <strong>{removingEmail}</strong>? Both <code style={codeInlineStyle}>email:*</code> and{' '}
        <code style={codeInlineStyle}>calendar:*</code> tools will be deleted.
      </Modal>
    </div>
  )
}

const codeInlineStyle: React.CSSProperties = {
  background: 'var(--bg-2)',
  padding: '1px 5px',
  borderRadius: 'var(--radius-xs)',
  fontSize: '0.92em',
  fontFamily: 'var(--mono)',
}
