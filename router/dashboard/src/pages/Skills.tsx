import { useState, useEffect, useCallback, useMemo } from 'react'
import { RefreshCw } from 'lucide-react'
import { Panel } from '../components/Panel'
import { PageHeader, SectionHeader } from '../components/ui/PageHeader'
import { Card } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { IconButton } from '../components/ui/IconButton'
import { EmptyState } from '../components/ui/EmptyState'
import { Textarea } from '../components/ui/Field'

// ── Types ──

interface CustomSkill {
  name: string
  dirName: string
  description?: string
  path?: string
  content?: string
  type: string
}

interface PluginSkill {
  name: string
  plugin: string
  pluginName?: string
  description?: string
  content?: string
  type: string
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

  const groupedPluginSkills = useMemo(() => {
    const groups: Record<string, { pluginName: string; skills: PluginSkill[] }> = {}
    for (const s of pluginSkills) {
      const key = s.pluginName || s.plugin
      if (!groups[key]) groups[key] = { pluginName: key, skills: [] }
      groups[key].skills.push(s)
    }
    return Object.values(groups)
  }, [pluginSkills])

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader
        title="Skills & Plugins"
        count={`${customSkills.length + pluginSkills.length} skills · ${plugins.length} plugins`}
        description="Custom skills from ~/.claude/ and skills bundled with installed plugins."
        actions={
          <IconButton
            icon={<RefreshCw size={13} />}
            label="Reload from disk"
            onClick={loadSkills}
          />
        }
      />

      <div>
        <SectionHeader title="Custom Skills" count={customSkills.length} />
        {customSkills.length === 0 ? (
          <EmptyState title="No custom skills" hint="Drop a folder with SKILL.md in ~/.claude/skills/ to add one." />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
            {customSkills.map((s) => (
              <Card key={s.dirName} interactive padding="12px 14px" onClick={() => openSkillDetail(s)}>
                <div style={{ marginBottom: 4 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>
                    {s.name}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-3)',
                    marginBottom: 6,
                    lineHeight: 1.45,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {s.description || 'No description'}
                </div>
                <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text-4)' }}>{s.path}</div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <div>
        <SectionHeader title="Plugin Skills" count={pluginSkills.length} />
        {pluginSkills.length === 0 ? (
          <EmptyState title="No plugin skills" />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {groupedPluginSkills.map((group) => (
              <div key={group.pluginName}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-2)', fontWeight: 500 }}>{group.pluginName}</span>
                  <Badge tone="muted" size="xs">{group.skills.length}</Badge>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                  {group.skills.map((s) => (
                    <Card
                      key={s.name + s.plugin}
                      interactive
                      padding="12px 14px"
                      onClick={() => openPluginSkillDetail(s)}
                    >
                      <div style={{ marginBottom: 4 }}>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>
                          {s.name}
                        </span>
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
                        }}
                      >
                        {s.description || 'No description'}
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <SectionHeader title="Installed Plugins" count={plugins.length} />
        {plugins.length === 0 ? (
          <EmptyState title="No plugins installed" />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
            {plugins.map((p) => (
              <Card
                key={p.name + (p.scope || '')}
                interactive
                padding="12px 14px"
                onClick={() => openPluginDetail(p)}
                style={{ opacity: p.enabled === false ? 0.6 : 1 }}
              >
                <div style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>
                    {p.name.split('@')[0]}
                  </span>
                  <Badge tone={p.enabled !== false ? 'ok' : 'muted'} size="xs">
                    {p.enabled !== false ? 'enabled' : 'disabled'}
                  </Badge>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-4)' }}>
                  {p.scope}
                  {p.project ? ' — ' + p.project.split('/').pop() : ''}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Custom Skill Detail */}
      <Panel
        open={panelType === 'skill-detail'}
        title={(panelData as CustomSkill | null)?.name || ''}
        onClose={closePanel}
      >
        {panelType === 'skill-detail' && panelData && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <dl style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 6, fontSize: 12, color: 'var(--text-2)', margin: 0 }}>
              <dt style={dtStyle}>Name</dt>
              <dd style={ddStyle}>{(panelData as unknown as CustomSkill).name}</dd>
              <dt style={dtStyle}>Path</dt>
              <dd style={{ ...ddStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{(panelData as unknown as CustomSkill).path}</dd>
              <dt style={dtStyle}>Description</dt>
              <dd style={ddStyle}>{(panelData as unknown as CustomSkill).description || '—'}</dd>
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
              {(panelData as unknown as CustomSkill).content || ''}
            </pre>
          </div>
        )}
      </Panel>

      {/* Plugin Skill Detail */}
      <Panel
        open={panelType === 'plugin-skill-detail'}
        title={(panelData as PluginSkill | null)?.name || ''}
        onClose={closePanel}
      >
        {panelType === 'plugin-skill-detail' && panelData && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <dl style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 6, fontSize: 12, color: 'var(--text-2)', margin: 0 }}>
              <dt style={dtStyle}>Name</dt>
              <dd style={ddStyle}>{(panelData as unknown as PluginSkill).name}</dd>
              <dt style={dtStyle}>Plugin</dt>
              <dd style={{ ...ddStyle, fontFamily: 'var(--mono)', fontSize: 11 }}>{(panelData as unknown as PluginSkill).plugin}</dd>
              <dt style={dtStyle}>Description</dt>
              <dd style={ddStyle}>{(panelData as unknown as PluginSkill).description || '—'}</dd>
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
              {(panelData as unknown as PluginSkill).content || ''}
            </pre>
          </div>
        )}
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
                <dd style={ddStyle}>{new Date((panelData as unknown as InstalledPlugin).installedAt!).toLocaleDateString('it-IT')}</dd>
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
