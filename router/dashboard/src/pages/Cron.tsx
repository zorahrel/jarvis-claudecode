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
import { EmptyState } from '../components/ui/EmptyState'
import { InfoBox } from '../components/ui/InfoBox'
import { Field, Input, Select, Textarea } from '../components/ui/Field'
import type { CronJob } from '../api/client'
import { CronStatusIcon } from '../icons'

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
  lastResult?: string
  runCount?: number
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

  useEffect(() => {
    apiFetch<Record<string, unknown>>('/api/dashboard-state')
      .then((d) => { if (d.agentNames) setAgentNames(d.agentNames as string[]) })
      .catch(() => {})
  }, [])

  const triggerCron = useCallback(
    async (name: string) => {
      try {
        await api.runCron(name)
        onToast('Cron triggered: ' + name, 'success')
        refreshCrons()
      } catch (e: unknown) {
        onToast(e instanceof Error ? e.message : String(e), 'error')
      }
    },
    [onToast, refreshCrons],
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
            return (
              <Card
                key={cs.name}
                interactive
                padding="12px 16px"
                onClick={() => openCronDetail(cs)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ display: 'flex', alignItems: 'center' }}>
                    <CronStatusIcon status={cs.lastStatus} />
                  </span>
                  <span style={{ fontWeight: 600, color: 'var(--text-1)', fontSize: 13 }}>{cs.name}</span>
                  <Badge tone={statusTone(cs.lastStatus)} size="xs">
                    {cs.lastStatus || 'idle'}
                  </Badge>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-4)', marginLeft: 'auto' }}>
                    {cs.schedule}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 6 }}>
                  {cs.lastStatus === 'never' || !cs.runCount
                    ? 'Never run'
                    : 'Last: ' + ago(cs.lastRun || 0) + ' · ' + (cs.runCount || 0) + ' runs'}
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
                  <SectionHeader title="Schedule" />
                  <dl style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 6, fontSize: 12, color: 'var(--text-2)', margin: 0 }}>
                    <dt style={dt}>Cron</dt>
                    <dd style={{ ...dd, fontFamily: 'var(--mono)' }}>{cronPanelData.schedule}</dd>
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
                  </dl>
                </div>

                <div>
                  <SectionHeader title="Prompt" />
                  <pre style={preStyle}>{cronPanelData.prompt}</pre>
                </div>

                {cronPanelData.lastResult && (
                  <div>
                    <SectionHeader title="Last Result" />
                    <pre style={preStyle}>{cronPanelData.lastResult}</pre>
                  </div>
                )}

                {cronPanelData.lastError && (
                  <div>
                    <SectionHeader title="Last Error" />
                    <div style={{ fontSize: 12, color: 'var(--err)' }}>{cronPanelData.lastError}</div>
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8 }}>
                  <Button variant="primary" size="md" onClick={() => triggerCron(cronPanelData.name)}>Run Now</Button>
                  <Button variant="danger-ghost" size="md" onClick={() => setDeleteTarget(cronPanelData.name)}>Delete</Button>
                </div>
              </>
            ) : (
              <>
                <Field label="Schedule (cron expression)">
                  <Input
                    value={cronEditForm.schedule || ''}
                    onChange={(e) => setCronEditForm({ ...cronEditForm, schedule: e.target.value })}
                    placeholder="0 9 * * 1-5"
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
            <Field label="Schedule (cron expression) *" hint="minute hour day month weekday">
              <Input
                value={newCronForm.schedule}
                onChange={(e) => setNewCronForm({ ...newCronForm, schedule: e.target.value })}
                placeholder="0 9 * * *"
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

            <InfoBox tone="warn">
              Cron jobs run in isolation without MCP tools or email access. They can only execute prompts using the
              agent's <code style={codeInline}>CLAUDE.md</code> context.
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

const dt: React.CSSProperties = { color: 'var(--text-4)', margin: 0 }
const dd: React.CSSProperties = { margin: 0 }
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
