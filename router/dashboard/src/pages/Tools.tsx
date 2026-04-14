import { useState, useCallback, useEffect } from 'react'
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
import type { Tool, ToolsResponse, FullRoute } from '../api/client'
import { ChannelIcon, ToolIcon } from '../icons'

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
  const [selectedTool, setSelectedTool] = useState<ToolDef | null>(null)

  // Email/Calendar account management
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([])
  const [addAccountOpen, setAddAccountOpen] = useState(false)
  const [newEmailAddr, setNewEmailAddr] = useState('')
  const [newEmailAccount, setNewEmailAccount] = useState('')
  const [addingEmail, setAddingEmail] = useState(false)
  const [removingEmail, setRemovingEmail] = useState<string | null>(null)

  const toast = onToast || (() => {})

  const loadEmailAccounts = useCallback(async () => {
    try {
      const r = await apiFetch<{ accounts: EmailAccount[] }>('/api/config/email-accounts')
      setEmailAccounts(r.accounts || [])
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    api.routesFull().then(setRoutes).catch(() => {})
    loadEmailAccounts()
  }, [loadEmailAccounts])

  const addEmailAccount = async () => {
    const email = newEmailAddr.trim()
    const account = newEmailAccount.trim()
    if (!email || !account) {
      toast('Email and account name required', 'error')
      return
    }
    setAddingEmail(true)
    try {
      await apiFetch('/api/config/email-accounts', {
        method: 'POST',
        body: JSON.stringify({ email, account }),
      })
      setNewEmailAddr('')
      setNewEmailAccount('')
      setAddAccountOpen(false)
      toast('Email account added: ' + email, 'success')
      loadEmailAccounts()
      refresh()
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
  const categories = categorizeTools(tools)

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
            onClick={() => { refresh(); loadEmailAccounts() }}
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

                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <Badge tone="accent" size="xs">{toolRoutesCount(t.id)} routes</Badge>
                    {(routeMap[t.id] || []).map((rIdx: number) => {
                      const workspace = routes[rIdx]?.workspace
                      const isJarvis = workspace === 'jarvis'
                      return (
                        <Badge
                          key={rIdx}
                          tone={isJarvis ? 'jarvis' : 'muted'}
                          size="xs"
                          onClick={(e) => { e.stopPropagation(); window.location.hash = 'routes' }}
                        >
                          {workspace || `#${rIdx}`}
                        </Badge>
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
                          window.location.hash = 'routes'
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
            Connect a Gmail account via <code style={codeInlineStyle}>gws-mail</code>. Adding one account creates both{' '}
            <code style={codeInlineStyle}>email:xxx</code> and <code style={codeInlineStyle}>calendar:xxx</code> tools.
          </InfoBox>

          <InfoBox tone="accent">
            Before adding here:<br />
            1. Install gws CLI: <code style={codeInlineStyle}>brew install gws</code><br />
            2. Run: <code style={codeInlineStyle}>gws-mail &lt;shortname&gt; auth login</code><br />
            3. Complete OAuth flow in browser<br />
            4. Fill the form below with the same shortname
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

          <Field label="gws-mail shortname" hint="Must match the shortname used in gws-mail auth login">
            <Input
              type="text"
              value={newEmailAccount}
              onChange={(e) => setNewEmailAccount(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addEmailAccount()}
              placeholder="myaccount"
            />
          </Field>

          {emailAccounts.length > 0 && (
            <div>
              <SectionHeader title="Currently connected" count={emailAccounts.length} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {emailAccounts.map((ea) => (
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
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant="primary"
              size="md"
              onClick={addEmailAccount}
              loading={addingEmail}
              disabled={!newEmailAddr.trim() || !newEmailAccount.trim()}
            >
              Connect
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
