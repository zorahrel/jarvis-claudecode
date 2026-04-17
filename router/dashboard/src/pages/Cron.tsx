import { useState, useCallback, useEffect } from 'react'
import { Plus } from 'lucide-react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { Panel } from '../components/Panel'
import { Modal } from '../components/Modal'
import { PageHeader, SectionHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { Card } from '../components/ui/Card'
import { Tooltip } from '../components/ui/Tooltip'
import { EmptyState } from '../components/ui/EmptyState'
import { InfoBox } from '../components/ui/InfoBox'
import { Field, Input, Select, Textarea } from '../components/ui/Field'
import type { CronJob, CronRun } from '../api/client'
import { CronStatusIcon } from '../icons'
import { CronBuilder, humanizeCron } from '../components/CronBuilder'

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

function ago(ts: number | string) {
  if (!ts) return 'never'
  const d = typeof ts === 'number' ? ts : new Date(ts).getTime()
  const diff = Date.now() - d
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago'
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago'
  return Math.floor(diff / 86400000) + 'd ago'
}

function fmtInterval(ms: number): string {
  if (ms < 0) return 'now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const mm = m % 60
  if (h < 24) return `${h}h ${mm}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

/**
 * Compute the next fire time of a cron expression after `after`. Returns null
 * when the expression is too complex (step values, ranges, @-aliases) and the
 * caller should fall back to "?". Supports the common `m h dom mon dow` grammar
 * with exact numbers, commas, and wildcards — enough for daily/hourly crons.
 */
function nextCronRun(expr: string, after: Date = new Date()): Date | null {
  if (!expr) return null
  const parts = expr.trim().split(/\s+/)
  if (parts.length < 5) return null
  const [minF, hourF, domF, monF, dowF] = parts
  const simple = (f: string) => /^(\*|\d+(,\d+)*)$/.test(f)
  if (![minF, hourF, domF, monF, dowF].every(simple)) return null
  const match = (f: string, v: number, min: number, max: number): boolean => {
    if (f === '*') return true
    const allowed = f.split(',').map(n => parseInt(n, 10)).filter(n => n >= min && n <= max)
    return allowed.includes(v)
  }
  const cur = new Date(after.getTime() + 60_000 - (after.getTime() % 60_000))
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const m = cur.getMinutes()
    const h = cur.getHours()
    const dom = cur.getDate()
    const mon = cur.getMonth() + 1
    const dow = cur.getDay() // 0=Sun..6=Sat
    if (match(minF, m, 0, 59) && match(hourF, h, 0, 23) && match(monF, mon, 1, 12)) {
      const domOk = domF === '*' ? true : match(domF, dom, 1, 31)
      const dowOk = dowF === '*' ? true : match(dowF, dow, 0, 6)
      // cron semantics: when both dom and dow restrict, either may match.
      if ((domF === '*' && dowF === '*') || domOk || dowOk) return new Date(cur)
    }
    cur.setMinutes(cur.getMinutes() + 1)
  }
  return null
}

interface CronState {
  name: string
  schedule: string
  timezone: string
  workspace?: string
  model?: string
  prompt?: string
  delivery?: { channel: string; target: string } | null
  lastRun?: number
  lastStatus?: string
  lastDurationMs?: number
  lastError?: string
  runCount?: number
  consecutiveErrors?: number
  lastDeliveryStatus?: string | null
}

function fmtAbs(ts: number): string {
  try { return new Date(ts).toLocaleString() } catch { return '' }
}
function fmtDurationMs(ms: number): string {
  if (!ms || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rest = Math.round(s % 60)
  return `${m}m ${rest}s`
}
function fmtTokensCompact(n?: number): string {
  if (!n) return '—'
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1)}k`
}

export function Cron({ onToast }: { onToast: (msg: string, type: 'success' | 'error' | 'info') => void }) {
  const fetchCrons = useCallback(() => api.crons(), [])
  const { data: cronJobs, refresh: refreshCrons } = usePolling<CronJob[]>(fetchCrons, 10000)
  const [cronPanel, setCronPanel] = useState<string | null>(null)
  const [cronPanelData, setCronPanelData] = useState<CronState | null>(null)
  const [editingCron, setEditingCron] = useState(false)
  const [cronEditForm, setCronEditForm] = useState<Record<string, string>>({})
  const [savingCron, setSavingCron] = useState(false)
  const [newCronForm, setNewCronForm] = useState({
    name: '',
    schedule: '',
    timezone: 'Europe/Rome',
    workspace: '',
    model: 'opus',
    prompt: '',
    timeout: '300',
    deliveryChannel: '',
    deliveryTarget: '',
  })
  const [creatingCron, setCreatingCron] = useState(false)
  const [agentNames, setAgentNames] = useState<string[]>([])
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [runs, setRuns] = useState<CronRun[] | null>(null)
  const [runsLoading, setRunsLoading] = useState(false)
  const [expandedRun, setExpandedRun] = useState<number | null>(null)
  const [triggering, setTriggering] = useState(false)

  const loadRuns = useCallback(async (name: string): Promise<CronRun[]> => {
    setRunsLoading(true)
    try {
      const { runs } = await api.cronRuns(name, 50)
      setRuns(runs)
      return runs
    } catch {
      setRuns([])
      return []
    } finally {
      setRunsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (cronPanel === 'cron-detail' && cronPanelData?.name) {
      loadRuns(cronPanelData.name)
    } else {
      setRuns(null)
      setExpandedRun(null)
    }
  }, [cronPanel, cronPanelData?.name, loadRuns])

  // Keep the open detail panel in sync with the polled list — otherwise the
  // "Ultimo messaggio" section keeps showing the snapshot taken at open time.
  useEffect(() => {
    if (!cronPanelData || cronPanel !== 'cron-detail' || !cronJobs) return
    const fresh = cronJobs.find((cj) => (cj as unknown as CronState).name === cronPanelData.name)
    if (!fresh) return
    const freshState = fresh as unknown as CronState
    if (freshState.lastRun !== cronPanelData.lastRun || freshState.lastStatus !== cronPanelData.lastStatus) {
      setCronPanelData(freshState)
    }
  }, [cronJobs, cronPanel, cronPanelData])

  useEffect(() => {
    apiFetch<Record<string, unknown>>('/api/dashboard-state')
      .then((d) => { if (d.agentNames) setAgentNames(d.agentNames as string[]) })
      .catch(() => {})
  }, [])

  const triggerCron = useCallback(
    async (name: string) => {
      setTriggering(true)
      const before = runs && runs[0] ? runs[0].ts : 0
      try {
        await api.runCron(name)
        onToast('Cron avviato: ' + name, 'info')
        refreshCrons()
        // Poll up to ~20 min (timeout of the biggest cron). First tick after 3s, then every 4s.
        const deadline = Date.now() + 20 * 60 * 1000
        const tick = async () => {
          const latest = await loadRuns(name)
          refreshCrons()
          if (latest[0] && latest[0].ts > before) {
            setTriggering(false)
            onToast(
              latest[0].status === 'ok' ? 'Run OK: ' + name : 'Run failed: ' + name,
              latest[0].status === 'ok' ? 'success' : 'error',
            )
            return
          }
          if (Date.now() > deadline) {
            setTriggering(false)
            return
          }
          setTimeout(tick, 4000)
        }
        setTimeout(tick, 3000)
      } catch (e: unknown) {
        setTriggering(false)
        onToast(e instanceof Error ? e.message : String(e), 'error')
      }
    },
    [onToast, refreshCrons, loadRuns, runs],
  )

  const confirmDeleteCron = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await apiFetch('/api/crons/' + encodeURIComponent(deleteTarget), { method: 'DELETE' })
      setCronPanel(null)
      setCronPanelData(null)
      setDeleteTarget(null)
      onToast('Cron job deleted: ' + deleteTarget, 'success')
      refreshCrons()
    } catch (e: unknown) {
      onToast(e instanceof Error ? e.message : String(e), 'error')
    }
  }, [deleteTarget, onToast, refreshCrons])

  const saveCronEdit = useCallback(async () => {
    if (!cronPanelData) return
    setSavingCron(true)
    try {
      await apiFetch('/api/crons/' + encodeURIComponent(cronPanelData.name), {
        method: 'PUT',
        body: JSON.stringify(cronEditForm),
      })
      setEditingCron(false)
      setCronPanel(null)
      setCronPanelData(null)
      onToast('Cron job updated: ' + cronPanelData.name, 'success')
      refreshCrons()
    } catch (e: unknown) {
      onToast(e instanceof Error ? e.message : String(e), 'error')
    }
    setSavingCron(false)
  }, [cronPanelData, cronEditForm, onToast, refreshCrons])

  const createCron = useCallback(async () => {
    const f = newCronForm
    if (!f.name || !f.schedule || !f.prompt) {
      onToast('Name, schedule, and prompt required', 'error')
      return
    }
    setCreatingCron(true)
    try {
      const payload: Record<string, unknown> = {
        name: f.name,
        schedule: f.schedule,
        timezone: f.timezone,
        workspace: f.workspace || undefined,
        model: f.model,
        prompt: f.prompt,
        timeout: parseInt(f.timeout) || 300,
      }
      if (f.deliveryChannel && f.deliveryTarget) {
        payload.delivery = { channel: f.deliveryChannel, target: f.deliveryTarget }
      }
      await apiFetch('/api/crons', { method: 'POST', body: JSON.stringify(payload) })
      onToast('Cron job created: ' + f.name, 'success')
      setNewCronForm({
        name: '',
        schedule: '',
        timezone: 'Europe/Rome',
        workspace: '',
        model: 'opus',
        prompt: '',
        timeout: '300',
        deliveryChannel: '',
        deliveryTarget: '',
      })
      setCronPanel(null)
      refreshCrons()
    } catch (e: unknown) {
      onToast(e instanceof Error ? e.message : String(e), 'error')
    }
    setCreatingCron(false)
  }, [newCronForm, onToast, refreshCrons])

  const openCronDetail = useCallback((cj: CronState) => {
    setCronPanel('cron-detail')
    setCronPanelData(cj)
    setEditingCron(false)
  }, [])

  const openCronCreate = useCallback(() => {
    setNewCronForm({
      name: '',
      schedule: '',
      timezone: 'Europe/Rome',
      workspace: '',
      model: 'opus',
      prompt: '',
      timeout: '300',
      deliveryChannel: '',
      deliveryTarget: '',
    })
    setCronPanel('cron-create')
    setCronPanelData(null)
  }, [])

  const statusTone = (status?: string): 'ok' | 'err' | 'warn' | 'muted' => {
    if (status === 'ok') return 'ok'
    if (status === 'error') return 'err'
    if (status === 'running') return 'warn'
    return 'muted'
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        title="Cron Jobs"
        count={`${cronJobs ? cronJobs.length : 0} ${(!cronJobs || cronJobs.length !== 1) ? 'jobs' : 'job'}`}
        description="Scheduled tasks that run prompts on a cron expression. No MCP tools."
        actions={
          <Button variant="primary" size="sm" leading={<Plus size={14} />} onClick={openCronCreate}>
            New Cron Job
          </Button>
        }
      />

      {(!cronJobs || cronJobs.length === 0) ? (
        <EmptyState
          title="No cron jobs configured"
          hint="Add one via config.yaml or click New Cron Job above."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(cronJobs || []).map((cj) => {
            const cs = cj as unknown as CronState
            const nextRun = nextCronRun(cs.schedule || '')
            const nextLabel = nextRun ? `in ${fmtInterval(nextRun.getTime() - Date.now())}` : '?'
            return (
              <Card key={cs.name} padding="12px 16px">
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
                  onClick={() => openCronDetail(cs)}
                >
                  <span style={{ display: 'flex', alignItems: 'center' }}>
                    <CronStatusIcon status={cs.lastStatus} />
                  </span>
                  <span style={{ fontWeight: 600, color: 'var(--text-1)', fontSize: 13 }}>{cs.name}</span>
                  <Badge tone={statusTone(cs.lastStatus)} size="xs">
                    {cs.lastStatus || 'idle'}
                  </Badge>
                  {cs.delivery && (
                    <Tooltip content={`Target: ${cs.delivery.channel} → ${cs.delivery.target}`} placement="top">
                      <a
                        href={`#/channels?focus=${encodeURIComponent(cs.delivery.channel)}`}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          fontSize: 10,
                          padding: '1px 6px',
                          borderRadius: 'var(--radius-xs)',
                          background: 'var(--surface-subtle)',
                          border: '1px solid var(--border)',
                          color: 'var(--text-3)',
                          textDecoration: 'none',
                          fontFamily: 'var(--mono)',
                        }}
                      >
                        → {cs.delivery.channel}
                      </a>
                    </Tooltip>
                  )}
                  <Tooltip content={cs.schedule} placement="top">
                    <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 'auto' }}>
                      {humanizeCron(cs.schedule)}
                    </span>
                  </Tooltip>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11, color: 'var(--text-4)', marginTop: 6 }}>
                  <span>
                    {cs.lastStatus === 'never' || !cs.runCount
                      ? 'Never run'
                      : 'Last: ' + ago(cs.lastRun || 0) + ' · ' + (cs.runCount || 0) + ' runs'}
                  </span>
                  <span>Next run: <span style={{ color: 'var(--text-2)', fontFamily: 'var(--mono)' }}>{nextLabel}</span></span>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {/* Detail Panel */}
      <Panel
        open={cronPanel === 'cron-detail'}
        title={cronPanelData?.name || ''}
        onClose={() => { setCronPanel(null); setCronPanelData(null) }}
      >
        {cronPanel === 'cron-detail' && cronPanelData && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditingCron(!editingCron)
                  if (!editingCron) {
                    setCronEditForm({
                      schedule: cronPanelData.schedule,
                      timezone: cronPanelData.timezone,
                      model: cronPanelData.model || 'opus',
                      workspace: cronPanelData.workspace || '',
                      prompt: cronPanelData.prompt || '',
                    })
                  }
                }}
              >
                {editingCron ? 'Cancel edit' : 'Edit'}
              </Button>
            </div>

            {!editingCron ? (
              <>
                <div>
                  <SectionHeader title="Pianificazione" />
                  <dl style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 6, fontSize: 12, color: 'var(--text-2)', margin: 0 }}>
                    <dt style={dt}>Quando</dt>
                    <dd style={dd}>
                      {humanizeCron(cronPanelData.schedule)}
                      <code style={{ marginLeft: 8, color: 'var(--text-4)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                        {cronPanelData.schedule}
                      </code>
                    </dd>
                    <dt style={dt}>Timezone</dt>
                    <dd style={dd}>{cronPanelData.timezone}</dd>
                    <dt style={dt}>Model</dt>
                    <dd style={dd}>{cronPanelData.model}</dd>
                    <dt style={dt}>Workspace</dt>
                    <dd style={{ ...dd, fontFamily: 'var(--mono)', fontSize: 11 }}>{cronPanelData.workspace}</dd>
                    <dt style={dt}>Status</dt>
                    <dd style={dd}>{cronPanelData.lastStatus}</dd>
                    <dt style={dt}>Runs</dt>
                    <dd style={dd}>{cronPanelData.runCount}</dd>
                    {(cronPanelData.lastRun || 0) > 0 && (
                      <>
                        <dt style={dt}>Last run</dt>
                        <dd style={dd}>
                          {ago(cronPanelData.lastRun || 0)} ({((cronPanelData.lastDurationMs || 0) / 1000).toFixed(1)}s)
                        </dd>
                      </>
                    )}
                    {(() => {
                      const nr = nextCronRun(cronPanelData.schedule || '')
                      return (
                        <>
                          <dt style={dt}>Next run</dt>
                          <dd style={dd}>{nr ? `in ${fmtInterval(nr.getTime() - Date.now())} (${nr.toLocaleString()})` : '?'}</dd>
                        </>
                      )
                    })()}
                    {cronPanelData.delivery && (
                      <>
                        <dt style={dt}>Target</dt>
                        <dd style={dd}>
                          <a
                            href={`#/channels?focus=${encodeURIComponent(cronPanelData.delivery.channel)}`}
                            style={{ color: 'var(--accent-bright)', textDecoration: 'none' }}
                          >
                            {cronPanelData.delivery.channel}
                          </a>
                          <span style={{ color: 'var(--text-4)', marginLeft: 6, fontFamily: 'var(--mono)', fontSize: 11 }}>
                            → {cronPanelData.delivery.target}
                          </span>
                        </dd>
                      </>
                    )}
                  </dl>
                </div>

                <div>
                  <SectionHeader title="Prompt" />
                  <pre style={preStyle}>{cronPanelData.prompt}</pre>
                </div>

                {cronPanelData.lastError && cronPanelData.lastStatus === 'error' && (
                  <div>
                    <SectionHeader title="Ultimo errore" />
                    <div style={{ fontSize: 12, color: 'var(--err)' }}>{cronPanelData.lastError}</div>
                  </div>
                )}

                <div>
                  <SectionHeader
                    title="Run history"
                    action={
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => loadRuns(cronPanelData.name)}
                        loading={runsLoading}
                      >
                        Refresh
                      </Button>
                    }
                  />
                  <RunHistoryList
                    runs={runs}
                    loading={runsLoading}
                    expanded={expandedRun}
                    onToggle={(ts) => setExpandedRun(prev => (prev === ts ? null : ts))}
                  />
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  <Button
                    variant="primary"
                    size="md"
                    onClick={() => triggerCron(cronPanelData.name)}
                    loading={triggering}
                    disabled={triggering}
                  >
                    {triggering ? 'Running…' : 'Run Now'}
                  </Button>
                  <Button variant="danger-ghost" size="md" onClick={() => setDeleteTarget(cronPanelData.name)}>Delete</Button>
                </div>
              </>
            ) : (
              <>
                <Field label="Quando">
                  <CronBuilder
                    value={cronEditForm.schedule || ''}
                    onChange={(expr) => setCronEditForm((prev) => (prev.schedule === expr ? prev : { ...prev, schedule: expr }))}
                  />
                </Field>
                <Field label="Timezone">
                  <Input
                    value={cronEditForm.timezone || ''}
                    onChange={(e) => setCronEditForm({ ...cronEditForm, timezone: e.target.value })}
                    placeholder="Europe/Rome"
                  />
                </Field>
                <Field label="Model">
                  <Select
                    value={cronEditForm.model || 'opus'}
                    onChange={(e) => setCronEditForm({ ...cronEditForm, model: e.target.value })}
                  >
                    <option value="opus">Opus</option>
                    <option value="sonnet">Sonnet</option>
                    <option value="haiku">Haiku</option>
                  </Select>
                </Field>
                <Field label="Workspace">
                  <Input
                    value={cronEditForm.workspace || ''}
                    onChange={(e) => setCronEditForm({ ...cronEditForm, workspace: e.target.value })}
                    placeholder="~/.claude/jarvis/agents/jarvis"
                    style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
                  />
                </Field>
                <Field label="Prompt">
                  <Textarea
                    value={cronEditForm.prompt || ''}
                    onChange={(e) => setCronEditForm({ ...cronEditForm, prompt: e.target.value })}
                    style={{ minHeight: 140 }}
                  />
                </Field>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button variant="primary" size="md" onClick={saveCronEdit} loading={savingCron}>Save</Button>
                  <Button variant="secondary" size="md" onClick={() => setEditingCron(false)}>Cancel</Button>
                </div>
              </>
            )}
          </div>
        )}
      </Panel>

      {/* Delete confirmation */}
      <Modal
        open={deleteTarget !== null}
        title="Delete cron job"
        confirmLabel="Delete"
        danger
        onConfirm={confirmDeleteCron}
        onCancel={() => setDeleteTarget(null)}
      >
        Delete cron job <strong>{deleteTarget}</strong>? This cannot be undone.
      </Modal>

      {/* Create Panel */}
      <Panel
        open={cronPanel === 'cron-create'}
        title="New Cron Job"
        onClose={() => setCronPanel(null)}
      >
        {cronPanel === 'cron-create' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="Name *">
              <Input
                value={newCronForm.name}
                onChange={(e) => setNewCronForm({ ...newCronForm, name: e.target.value })}
                placeholder="daily-report"
              />
            </Field>
            <Field label="Quando *">
              <CronBuilder
                value={newCronForm.schedule}
                onChange={(expr) => setNewCronForm((prev) => (prev.schedule === expr ? prev : { ...prev, schedule: expr }))}
              />
            </Field>
            <Field label="Timezone">
              <Input
                value={newCronForm.timezone}
                onChange={(e) => setNewCronForm({ ...newCronForm, timezone: e.target.value })}
                placeholder="Europe/Rome"
              />
            </Field>
            <Field label="Workspace">
              <Select
                value={newCronForm.workspace}
                onChange={(e) => setNewCronForm({ ...newCronForm, workspace: e.target.value })}
              >
                <option value="">Default (business)</option>
                {agentNames.map((name) => (
                  <option key={name} value={'~/.claude/jarvis/agents/' + name}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Model">
              <Select
                value={newCronForm.model}
                onChange={(e) => setNewCronForm({ ...newCronForm, model: e.target.value })}
              >
                <option value="opus">Opus</option>
                <option value="sonnet">Sonnet</option>
                <option value="haiku">Haiku</option>
              </Select>
            </Field>
            <Field label="Prompt *">
              <Textarea
                value={newCronForm.prompt}
                onChange={(e) => setNewCronForm({ ...newCronForm, prompt: e.target.value })}
                placeholder="What should this cron job do?"
                style={{ minHeight: 140 }}
              />
            </Field>
            <Field label="Timeout (seconds)">
              <Input
                type="number"
                value={newCronForm.timeout}
                onChange={(e) => setNewCronForm({ ...newCronForm, timeout: e.target.value })}
                placeholder="300"
                style={{ width: 120 }}
              />
            </Field>
            <Field label="Delivery (optional)">
              <div style={{ display: 'flex', gap: 8 }}>
                <Select
                  value={newCronForm.deliveryChannel}
                  onChange={(e) => setNewCronForm({ ...newCronForm, deliveryChannel: e.target.value })}
                  style={{ width: 160 }}
                >
                  <option value="">No delivery</option>
                  <option value="telegram">Telegram</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="discord">Discord</option>
                </Select>
                {newCronForm.deliveryChannel && (
                  <Input
                    value={newCronForm.deliveryTarget}
                    onChange={(e) => setNewCronForm({ ...newCronForm, deliveryTarget: e.target.value })}
                    placeholder="Target ID"
                    style={{ flex: 1 }}
                  />
                )}
              </div>
            </Field>

            <InfoBox tone="neutral">
              Cron jobs run in a fresh isolated session and inherit the selected agent's config
              (<code style={codeInline}>model</code>, <code style={codeInline}>tools</code>,
              <code style={codeInline}>fullAccess</code>, MCP servers). Pick the agent whose scope
              matches the job — a personal job should run on <code style={codeInline}>jarvis</code>,
              a client job on its dedicated agent.
            </InfoBox>

            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                variant="primary"
                size="md"
                onClick={createCron}
                loading={creatingCron}
                disabled={!newCronForm.name || !newCronForm.schedule || !newCronForm.prompt}
              >
                Create Cron Job
              </Button>
              <Button variant="secondary" size="md" onClick={() => setCronPanel(null)}>Cancel</Button>
            </div>
          </div>
        )}
      </Panel>
    </div>
  )
}

function RunHistoryList({
  runs,
  loading,
  expanded,
  onToggle,
}: {
  runs: CronRun[] | null
  loading: boolean
  expanded: number | null
  onToggle: (ts: number) => void
}) {
  if (loading && !runs) {
    return <div style={{ fontSize: 11, color: 'var(--text-4)' }}>Loading run history…</div>
  }
  if (!runs || runs.length === 0) {
    return <div style={{ fontSize: 11, color: 'var(--text-4)' }}>No runs logged yet.</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {runs.map((run) => {
        const isOpen = expanded === run.ts
        const tone = run.status === 'ok' ? 'ok' : run.status === 'timeout' ? 'warn' : 'err'
        return (
          <div
            key={run.ts}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-0)',
              overflow: 'hidden',
            }}
          >
            <button
              onClick={() => onToggle(run.ts)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
                background: 'transparent',
                border: 'none',
                color: 'var(--text-2)',
                cursor: 'pointer',
                textAlign: 'left',
                fontSize: 11,
                fontFamily: 'var(--mono)',
              }}
            >
              <Badge tone={tone} size="xs">{run.status}</Badge>
              <span style={{ color: 'var(--text-3)' }}>{fmtAbs(run.runAtMs)}</span>
              <span style={{ color: 'var(--text-4)' }}>· {fmtDurationMs(run.durationMs)}</span>
              {run.trigger === 'manual' && (
                <Badge tone="muted" size="xs">manual</Badge>
              )}
              {run.delivery && (
                <span style={{ color: run.delivery.ok ? 'var(--ok)' : 'var(--err)', fontSize: 10 }}>
                  → {run.delivery.channel}
                </span>
              )}
              {run.usage?.total_tokens && (
                <span style={{ marginLeft: 'auto', color: 'var(--text-4)' }}>
                  {fmtTokensCompact(run.usage.total_tokens)} tok
                  {run.costUsd ? ` · $${run.costUsd.toFixed(3)}` : ''}
                </span>
              )}
            </button>
            {isOpen && (
              <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <dl style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '4px 12px', fontSize: 11, margin: 0, fontFamily: 'var(--mono)' }}>
                  <dt style={dt}>trigger</dt><dd style={dd}>{run.trigger}</dd>
                  <dt style={dt}>status</dt><dd style={dd}>{run.status}</dd>
                  <dt style={dt}>started</dt><dd style={dd}>{fmtAbs(run.runAtMs)}</dd>
                  <dt style={dt}>duration</dt><dd style={dd}>{fmtDurationMs(run.durationMs)}</dd>
                  {run.model && (<><dt style={dt}>model</dt><dd style={dd}>{run.model}</dd></>)}
                  {run.sessionId && (<><dt style={dt}>session</dt><dd style={{ ...dd, wordBreak: 'break-all' }}>{run.sessionId}</dd></>)}
                  {run.nextRunAtMs && (<><dt style={dt}>next fire</dt><dd style={dd}>{fmtAbs(run.nextRunAtMs)}</dd></>)}
                  {run.usage && (
                    <>
                      <dt style={dt}>tokens in</dt><dd style={dd}>{fmtTokensCompact(run.usage.input_tokens)}</dd>
                      <dt style={dt}>tokens out</dt><dd style={dd}>{fmtTokensCompact(run.usage.output_tokens)}</dd>
                    </>
                  )}
                  {run.costUsd != null && (<><dt style={dt}>cost</dt><dd style={dd}>${run.costUsd.toFixed(4)}</dd></>)}
                  {run.delivery && (
                    <>
                      <dt style={dt}>delivery</dt>
                      <dd style={{ ...dd, color: run.delivery.ok ? 'var(--ok)' : 'var(--err)' }}>
                        {run.delivery.channel} → {run.delivery.target} {run.delivery.ok ? '✓' : '✗'}
                        {run.delivery.error ? ` (${run.delivery.error})` : ''}
                      </dd>
                    </>
                  )}
                </dl>
                {run.result && (
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <div style={{ fontSize: 10, color: 'var(--text-4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Messaggio inviato</div>
                      <button
                        onClick={() => navigator.clipboard?.writeText(run.result || '')}
                        style={{
                          fontSize: 10,
                          color: 'var(--text-3)',
                          background: 'transparent',
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-xs)',
                          padding: '2px 6px',
                          cursor: 'pointer',
                        }}
                      >
                        Copia
                      </button>
                    </div>
                    <div style={messageBox}>{run.result}</div>
                  </div>
                )}
                {run.error && (
                  <div>
                    <div style={{ fontSize: 10, color: 'var(--err)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>Error</div>
                    <pre style={{ ...preStyle, color: 'var(--err)' }}>{run.error}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const dt: React.CSSProperties = { color: 'var(--text-4)', margin: 0 }
const dd: React.CSSProperties = { margin: 0 }
const messageBox: React.CSSProperties = {
  maxHeight: 320,
  overflow: 'auto',
  padding: 12,
  background: 'var(--bg-1)',
  borderRadius: 'var(--radius)',
  border: '1px solid var(--border)',
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--text-1)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontFamily: 'var(--sans, system-ui)',
}
const preStyle: React.CSSProperties = {
  maxHeight: 220,
  overflow: 'auto',
  padding: 12,
  background: 'var(--bg-0)',
  borderRadius: 'var(--radius)',
  border: '1px solid var(--border)',
  fontSize: 11,
  fontFamily: 'var(--mono)',
  color: 'var(--text-2)',
  whiteSpace: 'pre-wrap',
  margin: 0,
}
const codeInline: React.CSSProperties = {
  background: 'var(--bg-2)',
  padding: '1px 5px',
  borderRadius: 'var(--radius-xs)',
  fontSize: '0.92em',
  fontFamily: 'var(--mono)',
}
