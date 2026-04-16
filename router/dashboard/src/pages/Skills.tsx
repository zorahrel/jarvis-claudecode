import { useState, useEffect, useCallback, useMemo } from 'react'
import { RefreshCw, Wrench, Paperclip, Clock } from 'lucide-react'
import { Panel } from '../components/Panel'
import { PageHeader, SectionHeader } from '../components/ui/PageHeader'
import { Card } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { IconButton } from '../components/ui/IconButton'
import { EmptyState } from '../components/ui/EmptyState'
import { Textarea } from '../components/ui/Field'

type UnifiedSkill = {
  key: string
  name: string
  description?: string
  source: string
  isPlugin: boolean
  custom?: CustomSkill
  plugin?: PluginSkill
}

// ── Types ──

interface CustomSkill {
  name: string
  dirName: string
  description?: string
  path?: string
  content?: string
  type: string
  allowedTools?: string[]
  resources?: string[]
  lastModified?: string | null
}

interface PluginSkill {
  name: string
  plugin: string
  pluginName?: string
  description?: string
  content?: string
  type: string
  allowedTools?: string[]
  resources?: string[]
  lastModified?: string | null
}

interface InstalledPlugin {
  name: string
  scope?: string
  enabled?: boolean
  project?: string
  installedAt?: string
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

function relTime(iso?: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const days = Math.floor(ms / 86400000)
  if (days === 0) return 'today'
  if (days === 1) return '1d ago'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

export function Skills({ onToast }: { onToast: (msg: string, type: 'success' | 'error' | 'info') => void }) {
  const [customSkills, setCustomSkills] = useState<CustomSkill[]>([])
  const [pluginSkills, setPluginSkills] = useState<PluginSkill[]>([])
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([])

  const [panelType, setPanelType] = useState<string | null>(null)
  const [panelData, setPanelData] = useState<Record<string, unknown> | null>(null)
  const [editorMode, setEditorMode] = useState<'preview' | 'edit'>('preview')
  const [editContent, setEditContent] = useState('')
  const [editingName, setEditingName] = useState('')
  const [saving, setSaving] = useState(false)

  const loadSkills = useCallback(async () => {
    try {
      const d = await apiFetch<{
        plugins?: InstalledPlugin[]
        customSkills?: CustomSkill[]
        pluginSkills?: PluginSkill[]
      }>('/api/skills')
      setPlugins(d.plugins || [])
      setCustomSkills(d.customSkills || [])
      setPluginSkills(d.pluginSkills || [])
    } catch { /* silent */ }
  }, [])

  useEffect(() => { loadSkills() }, [loadSkills])

  const allSkills: UnifiedSkill[] = useMemo(() => {
    const custom: UnifiedSkill[] = customSkills.map((s) => ({
      key: 'local:' + s.dirName,
      name: s.name,
      description: s.description,
      source: 'local',
      isPlugin: false,
      custom: s,
    }))
    const plug: UnifiedSkill[] = pluginSkills.map((s) => ({
      key: 'plugin:' + s.plugin + ':' + s.name,
      name: s.name,
      description: s.description,
      source: s.pluginName || s.plugin,
      isPlugin: true,
      plugin: s,
    }))
    return [...custom, ...plug].sort((a, b) => a.name.localeCompare(b.name))
  }, [customSkills, pluginSkills])

  const openSkillDetail = useCallback((skill: CustomSkill) => {
    setPanelType('skill-detail')
    setPanelData(skill as unknown as Record<string, unknown>)
    setEditorMode('preview')
  }, [])

  const openPluginSkillDetail = useCallback((skill: PluginSkill) => {
    setPanelType('plugin-skill-detail')
    setPanelData(skill as unknown as Record<string, unknown>)
  }, [])

  const openPluginDetail = useCallback((plugin: InstalledPlugin) => {
    setPanelType('plugin-detail')
    setPanelData(plugin as unknown as Record<string, unknown>)
  }, [])

  const openSkillEdit = useCallback(async (dirName: string) => {
    try {
      const r = await apiFetch<{ content: string }>('/api/skills/' + encodeURIComponent(dirName) + '/content')
      setEditContent(r.content || '')
      setEditingName(dirName)
      setEditorMode('edit')
      setPanelType('skill-edit')
      setPanelData({ dirName })
    } catch (e: unknown) {
      onToast(e instanceof Error ? e.message : String(e), 'error')
    }
  }, [onToast])

  const saveSkillContent = useCallback(async () => {
    setSaving(true)
    try {
      await apiFetch('/api/skills/' + encodeURIComponent(editingName) + '/content', {
        method: 'PUT',
        body: JSON.stringify({ content: editContent }),
      })
      await loadSkills()
      setPanelType(null)
      setPanelData(null)
      onToast('SKILL.md saved for ' + editingName, 'success')
    } catch (e: unknown) {
      onToast(e instanceof Error ? e.message : String(e), 'error')
    }
    setSaving(false)
  }, [editingName, editContent, loadSkills, onToast])

  const closePanel = useCallback(() => {
    setPanelType(null)
    setPanelData(null)
  }, [])

  const togglePlugin = useCallback(async (pluginName: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const r = await apiFetch<{ enabled: boolean }>('/api/plugins/' + encodeURIComponent(pluginName) + '/toggle', { method: 'POST' })
      await loadSkills()
      onToast(`${pluginName.split('@')[0]} ${r.enabled ? 'enabled' : 'disabled'}`, 'success')
    } catch (err: unknown) {
      onToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }, [loadSkills, onToast])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Skills & Plugins"
        count={`${allSkills.length} skills · ${plugins.length} plugins`}
        description="Skills discovered in ~/.claude/skills/ and from installed plugins."
        actions={
          <IconButton
            icon={<RefreshCw size={13} />}
            label="Reload from disk"
            onClick={loadSkills}
          />
        }
      />

      <div>
        <SectionHeader title="Skills" count={allSkills.length} />
        {allSkills.length === 0 ? (
          <EmptyState title="No skills" hint="Drop a folder with SKILL.md in ~/.claude/skills/ to add one." />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
            {allSkills.map((s) => {
              const meta = (s.isPlugin ? s.plugin : s.custom) as { allowedTools?: string[]; resources?: string[]; lastModified?: string | null } | undefined
              const toolCount = meta?.allowedTools?.length ?? 0
              const resCount = meta?.resources?.length ?? 0
              return (
                <Card
                  key={s.key}
                  interactive
                  padding="12px 14px"
                  onClick={() => (s.isPlugin ? openPluginSkillDetail(s.plugin!) : openSkillDetail(s.custom!))}
                >
                  <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>
                      {s.name}
                    </span>
                    <Badge tone="muted" size="xs">{s.source}</Badge>
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--text-3)',
                      lineHeight: 1.45,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                      marginBottom: 6,
                    }}
                  >
                    {s.description || 'No description'}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 10, color: 'var(--text-4)' }}>
                    {toolCount > 0 && (
                      <span title="allowed-tools directives" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <Wrench size={10} /> {toolCount}
                      </span>
                    )}
                    {resCount > 0 && (
                      <span title="resources in skill directory" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <Paperclip size={10} /> {resCount}
                      </span>
                    )}
                    {meta?.lastModified && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <Clock size={10} /> {relTime(meta.lastModified)}
                      </span>
                    )}
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      <div>
        <SectionHeader title="Installed Plugins" count={plugins.length} />
        {plugins.length === 0 ? (
          <EmptyState title="No plugins installed" />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
            {plugins.map((p) => {
              const on = p.enabled !== false
              return (
                <Card
                  key={p.name + (p.scope || '')}
                  interactive
                  padding="12px 14px"
                  onClick={() => openPluginDetail(p)}
                  style={{ opacity: on ? 1 : 0.65 }}
                >
                  <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: 'var(--text-1)', flex: 1 }}>
                      {p.name.split('@')[0]}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => togglePlugin(p.name, e)}
                      role="switch"
                      aria-checked={on}
                      title={on ? 'Disable plugin' : 'Enable plugin'}
                      style={{
                        border: 'none', cursor: 'pointer', padding: 0,
                        width: 28, height: 16, borderRadius: 8,
                        background: on ? 'var(--ok)' : 'var(--bg-2)',
                        position: 'relative', transition: 'background 120ms ease',
                      }}
                    >
                      <span style={{
                        position: 'absolute', top: 2, left: on ? 14 : 2,
                        width: 12, height: 12, borderRadius: '50%',
                        background: 'var(--text-1)', transition: 'left 120ms ease',
                      }} />
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-4)' }}>
                    {p.scope}
                    {p.project ? ' — ' + p.project.split('/').pop() : ''}
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Custom Skill Detail */}
      <Panel
        open={panelType === 'skill-detail'}
        title={(panelData as CustomSkill | null)?.name || ''}
        onClose={closePanel}
      >
        {panelType === 'skill-detail' && panelData && (() => {
          const sk = panelData as unknown as CustomSkill
          return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <dl style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 6, fontSize: 12, color: 'var(--text-2)', margin: 0 }}>
              <dt style={dtStyle}>Name</dt>
              <dd style={ddStyle}>{sk.name}</dd>
              <dt style={dtStyle}>Path</dt>
              <dd style={{ ...ddStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{sk.path}</dd>
              <dt style={dtStyle}>Modified</dt>
              <dd style={ddStyle}>{sk.lastModified ? relTime(sk.lastModified) + ' · ' + new Date(sk.lastModified).toLocaleString('en-US') : '—'}</dd>
              <dt style={dtStyle}>Description</dt>
              <dd style={ddStyle}>{sk.description || '—'}</dd>
              {sk.allowedTools && sk.allowedTools.length > 0 && (<>
                <dt style={dtStyle}>Allowed tools</dt>
                <dd style={ddStyle}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {sk.allowedTools.map((t, i) => <Badge key={i} tone="muted" size="xs">{t}</Badge>)}
                  </div>
                </dd>
              </>)}
              {sk.resources && sk.resources.length > 0 && (<>
                <dt style={dtStyle}>Resources</dt>
                <dd style={{ ...ddStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{sk.resources.join(', ')}</dd>
              </>)}
            </dl>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <SectionHeader title="SKILL.md" />
              <Button size="xs" variant="ghost" onClick={() => openSkillEdit((panelData as unknown as CustomSkill).dirName)}>
                Edit
              </Button>
            </div>
            <pre
              style={{
                maxHeight: '60vh',
                overflow: 'auto',
                fontSize: 11,
                padding: 12,
                background: 'var(--bg-0)',
                borderRadius: 'var(--radius)',
                border: '1px solid var(--border)',
                whiteSpace: 'pre-wrap',
                fontFamily: 'var(--mono)',
                color: 'var(--text-2)',
                lineHeight: 1.55,
                margin: 0,
              }}
            >
              {sk.content || ''}
            </pre>
          </div>
          )
        })()}
      </Panel>

      {/* Plugin Skill Detail */}
      <Panel
        open={panelType === 'plugin-skill-detail'}
        title={(panelData as PluginSkill | null)?.name || ''}
        onClose={closePanel}
      >
        {panelType === 'plugin-skill-detail' && panelData && (() => {
          const ps = panelData as unknown as PluginSkill
          return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <dl style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 6, fontSize: 12, color: 'var(--text-2)', margin: 0 }}>
              <dt style={dtStyle}>Name</dt>
              <dd style={ddStyle}>{ps.name}</dd>
              <dt style={dtStyle}>Plugin</dt>
              <dd style={{ ...ddStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{ps.plugin}</dd>
              <dt style={dtStyle}>Modified</dt>
              <dd style={ddStyle}>{ps.lastModified ? relTime(ps.lastModified) + ' · ' + new Date(ps.lastModified).toLocaleString('en-US') : '—'}</dd>
              <dt style={dtStyle}>Description</dt>
              <dd style={ddStyle}>{ps.description || '—'}</dd>
              {ps.allowedTools && ps.allowedTools.length > 0 && (<>
                <dt style={dtStyle}>Allowed tools</dt>
                <dd style={ddStyle}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {ps.allowedTools.map((t, i) => <Badge key={i} tone="muted" size="xs">{t}</Badge>)}
                  </div>
                </dd>
              </>)}
              {ps.resources && ps.resources.length > 0 && (<>
                <dt style={dtStyle}>Resources</dt>
                <dd style={{ ...ddStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{ps.resources.join(', ')}</dd>
              </>)}
            </dl>
            <SectionHeader title="SKILL.md" />
            <pre
              style={{
                maxHeight: '60vh',
                overflow: 'auto',
                fontSize: 11,
                padding: 12,
                background: 'var(--bg-0)',
                borderRadius: 'var(--radius)',
                border: '1px solid var(--border)',
                whiteSpace: 'pre-wrap',
                fontFamily: 'var(--mono)',
                color: 'var(--text-2)',
                lineHeight: 1.55,
                margin: 0,
              }}
            >
              {ps.content || ''}
            </pre>
          </div>
          )
        })()}
      </Panel>

      {/* Plugin Detail */}
      <Panel
        open={panelType === 'plugin-detail'}
        title={((panelData as InstalledPlugin | null)?.name || '').split('@')[0]}
        onClose={closePanel}
      >
        {panelType === 'plugin-detail' && panelData && (
          <dl style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 6, fontSize: 12, color: 'var(--text-2)', margin: 0 }}>
            <dt style={dtStyle}>Plugin</dt>
            <dd style={ddStyle}>{(panelData as unknown as InstalledPlugin).name}</dd>
            <dt style={dtStyle}>Scope</dt>
            <dd style={ddStyle}>{(panelData as unknown as InstalledPlugin).scope}</dd>
            <dt style={dtStyle}>Status</dt>
            <dd style={{ ...ddStyle, color: (panelData as unknown as InstalledPlugin).enabled !== false ? 'var(--ok)' : 'var(--text-3)' }}>
              {(panelData as unknown as InstalledPlugin).enabled !== false ? 'Enabled' : 'Disabled'}
            </dd>
            {(panelData as unknown as InstalledPlugin).project && (
              <>
                <dt style={dtStyle}>Project</dt>
                <dd style={{ ...ddStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{(panelData as unknown as InstalledPlugin).project}</dd>
              </>
            )}
            {(panelData as unknown as InstalledPlugin).installedAt && (
              <>
                <dt style={dtStyle}>Installed</dt>
                <dd style={ddStyle}>{new Date((panelData as unknown as InstalledPlugin).installedAt!).toLocaleDateString('en-US')}</dd>
              </>
            )}
          </dl>
        )}
      </Panel>

      {/* Skill Edit */}
      <Panel
        open={panelType === 'skill-edit'}
        title={'Edit SKILL.md — ' + editingName}
        onClose={closePanel}
      >
        {panelType === 'skill-edit' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: 'calc(100vh - 160px)' }}>
            <div style={{ display: 'flex', gap: 4 }}>
              <Button size="xs" variant={editorMode === 'preview' ? 'primary' : 'secondary'} onClick={() => setEditorMode('preview')}>Preview</Button>
              <Button size="xs" variant={editorMode === 'edit' ? 'primary' : 'secondary'} onClick={() => setEditorMode('edit')}>Edit</Button>
            </div>
            {editorMode === 'edit' ? (
              <Textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                placeholder="SKILL.md content…"
                style={{ flex: 1, minHeight: 300 }}
              />
            ) : (
              <pre
                style={{
                  flex: 1,
                  minHeight: 200,
                  overflowY: 'auto',
                  padding: 12,
                  background: 'var(--bg-0)',
                  borderRadius: 'var(--radius)',
                  border: '1px solid var(--border)',
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  color: 'var(--text-2)',
                  lineHeight: 1.55,
                  margin: 0,
                }}
              >
                {editContent}
              </pre>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="primary" size="md" onClick={saveSkillContent} loading={saving}>Save</Button>
              <Button variant="secondary" size="md" onClick={closePanel}>Cancel</Button>
            </div>
          </div>
        )}
      </Panel>
    </div>
  )
}

const dtStyle: React.CSSProperties = { color: 'var(--text-4)', margin: 0 }
const ddStyle: React.CSSProperties = { margin: 0 }
