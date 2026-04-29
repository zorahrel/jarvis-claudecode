import { useState, useCallback, useEffect } from 'react'
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { api } from '../api/client'
import { PageHeader, SectionHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { IconButton } from '../components/ui/IconButton'
import { Badge } from '../components/ui/Badge'
import { Card } from '../components/ui/Card'
import { InfoBox } from '../components/ui/InfoBox'
import { Textarea } from '../components/ui/Field'
import { AllowedCallers } from '../components/AllowedCallers'

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

export function Settings({ onToast }: { onToast: (msg: string, type: 'success' | 'error' | 'info') => void }) {
  const [yaml, setYaml] = useState('')
  const [yamlEdit, setYamlEdit] = useState('')
  const [yamlLoaded, setYamlLoaded] = useState(false)
  const [expandedYaml, setExpandedYaml] = useState(false)
  const [editingYaml, setEditingYaml] = useState(false)
  const [savingYaml, setSavingYaml] = useState(false)
  const [settingsHooks, setSettingsHooks] = useState<string[]>([])

  useEffect(() => {
    apiFetch<Record<string, unknown>>('/api/dashboard-state')
      .then((d) => {
        setSettingsHooks((d.settingsHooks as string[]) || [])
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!yamlLoaded) {
      api
        .config()
        .then((c) => {
          setYaml((c as { yaml: string }).yaml || '')
          setYamlLoaded(true)
        })
        .catch(() => {})
    }
  }, [yamlLoaded])

  const saveYaml = useCallback(async () => {
    setSavingYaml(true)
    try {
      await apiFetch('/api/config/yaml', {
        method: 'PUT',
        body: JSON.stringify({ content: yamlEdit }),
      })
      setYaml(yamlEdit)
      setEditingYaml(false)
      onToast('config.yaml saved and reloaded', 'success')
      setTimeout(() => window.location.reload(), 800)
    } catch (e: unknown) {
      onToast(e instanceof Error ? e.message : String(e), 'error')
    }
    setSavingYaml(false)
  }, [yamlEdit, onToast])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        title="Settings"
        description="Router configuration and infrastructure."
        actions={
          <IconButton
            icon={<RefreshCw size={13} />}
            label="Reload config from disk"
            onClick={() => {
              setYamlLoaded(false)
              apiFetch<Record<string, unknown>>('/api/dashboard-state')
                .then((d) => setSettingsHooks((d.settingsHooks as string[]) || []))
                .catch(() => {})
            }}
          />
        }
      />

      <InfoBox title="Where to find things">
        Always-reply groups in <a href="#routes" style={linkStyle}>Routes</a>.
        WhatsApp pairing in <a href="#channels" style={linkStyle}>Channels</a> → ⚙️.
        Email accounts in <a href="#tools" style={linkStyle}>Tools</a>. Memory scopes in{' '}
        <a href="#memory" style={linkStyle}>Memory</a>. Global CLAUDE.md in{' '}
        <a href="#agents" style={linkStyle}>Agents</a>. Costs in <a href="#analytics" style={linkStyle}>Analytics</a>.
      </InfoBox>

      <AllowedCallers onToast={onToast} />

      {/* Hooks */}
      <Card padding={16}>
        <SectionHeader
          title="Hooks"
          count={settingsHooks.length}
          action={
            <span style={{ fontSize: 11, color: 'var(--text-4)' }}>
              Plugins in <a href="#skills" style={linkStyle}>Skills</a> · MCP in <a href="#tools" style={linkStyle}>Tools</a>
            </span>
          }
        />
        {settingsHooks.length === 0 ? (
          <div style={{ color: 'var(--text-4)', fontSize: 12, padding: 8 }}>No hooks configured</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {settingsHooks.map((h) => (
              <Badge key={h} tone="neutral" size="sm" mono>{h}</Badge>
            ))}
          </div>
        )}
      </Card>

      {/* Config YAML */}
      <Card padding={16}>
        <div
          style={{ cursor: 'pointer', marginBottom: expandedYaml ? 12 : 0 }}
          onClick={() => setExpandedYaml(!expandedYaml)}
        >
          <SectionHeader
            title="Config YAML"
            action={<span style={{ display: 'inline-flex', color: 'var(--text-4)' }}>{expandedYaml ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>}
          />
        </div>
        {expandedYaml && (
          <div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
              <Button
                size="xs"
                variant={!editingYaml ? 'primary' : 'secondary'}
                onClick={() => setEditingYaml(false)}
              >
                View
              </Button>
              <Button
                size="xs"
                variant={editingYaml ? 'primary' : 'secondary'}
                onClick={() => {
                  if (!editingYaml) {
                    setYamlEdit(yaml)
                    setEditingYaml(true)
                  }
                }}
              >
                Edit
              </Button>
            </div>
            {!editingYaml ? (
              <pre
                style={{
                  maxHeight: 400,
                  overflow: 'auto',
                  padding: 16,
                  background: 'var(--bg-0)',
                  borderRadius: 'var(--radius)',
                  border: '1px solid var(--border)',
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                  color: 'var(--text-2)',
                  whiteSpace: 'pre-wrap',
                  margin: 0,
                }}
              >
                {yaml}
              </pre>
            ) : (
              <div>
                <Textarea
                  value={yamlEdit}
                  onChange={(e) => setYamlEdit(e.target.value)}
                  style={{ minHeight: 400 }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <Button variant="primary" size="md" onClick={saveYaml} loading={savingYaml}>Save & Reload</Button>
                  <Button variant="secondary" size="md" onClick={() => setEditingYaml(false)}>Cancel</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  )
}

const linkStyle: React.CSSProperties = {
  color: 'var(--accent-bright)',
  textDecoration: 'none',
  fontWeight: 500,
}
