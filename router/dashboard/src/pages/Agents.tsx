import { useState, useCallback, useEffect, useMemo } from 'react'
import { Plus, Sparkles, LayoutGrid, Table2 } from 'lucide-react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { Panel } from '../components/Panel'
import { Modal } from '../components/Modal'
import { PageHeader, SectionHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { Card } from '../components/ui/Card'
import { Tooltip } from '../components/ui/Tooltip'
import { AgentName } from '../components/ui/AgentName'
import { InfoBox } from '../components/ui/InfoBox'
import { Input, Select, Textarea } from '../components/ui/Field'
import { BadgeLink } from '../components/BadgeLink'
import { AgentBaselineList } from '../components/context/AgentBaselineList'
import { RelatedList } from '../components/RelatedList'
import { ToolIcon } from '../icons'
import type { FullAgent, ProcessSession, Tool } from '../api/client'
import { parseHashFilter, parseHashFocus } from '../lib/hashFilter'

interface AgentAggEntry {
  key: string
  count: number
}

interface AgentCostsResponse {
  aggregated: AgentAggEntry[]
}

interface SharedFile {
  name: string
  size: number
}

// Note: renderMarkdown is used only for trusted content (agent CLAUDE.md files from local filesystem).
// The old Alpine.js dashboard used the same approach with x-html. No user-supplied content is rendered.
function renderMarkdown(text: string): string {
  if (!text) return ''
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3 style="color:var(--text-1);font-size:14px;margin:12px 0 4px">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="color:var(--text-1);font-size:16px;margin:16px 0 6px">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="color:var(--text-1);font-size:18px;margin:20px 0 8px">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--text-1)">$1</strong>')
    .replace(/`([^`]+)`/g, '<code style="background:var(--bg-0);padding:1px 4px;border-radius:3px;font-size:12px">$1</code>')
    .replace(/^- (.+)$/gm, '<div style="padding-left:12px">\u2022 $1</div>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>')
}

function MarkdownPreview({ content, style }: { content: string; style?: React.CSSProperties }) {
  // Safe: content comes from local agent files on disk, not from user input
  return <div className="rounded-md overflow-y-auto text-xs" style={{ background: 'var(--bg-0)', border: '1px solid var(--border)', padding: '12px', color: 'var(--text-2)', minHeight: 200, ...style }} dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
}

function splitImports(content: string): { header: string; imports: string[]; body: string } {
  const lines = (content || '').split('\n')
  const header: string[] = []
  const imports: string[] = []
  const body: string[] = []
  let seenNonImport = false
  for (const ln of lines) {
    const t = ln.trim()
    if (/^@/.test(t)) { imports.push(t); continue }
    if (!seenNonImport && /^#/.test(t)) { header.push(ln); continue }
    if (!seenNonImport && t === '') { header.push(ln); continue }
    seenNonImport = true
    body.push(ln)
  }
  while (header.length && header[header.length - 1].trim() === '') header.pop()
  while (body.length && body[0].trim() === '') body.shift()
  while (body.length && body[body.length - 1].trim() === '') body.pop()
  return { header: header.join('\n'), imports, body: body.join('\n') }
}

function joinImports(parts: { header: string; imports: string[]; body: string }): string {
  const out: string[] = []
  if (parts.header) out.push(parts.header)
  if (parts.imports?.length) out.push(parts.imports.join('\n'))
  if (parts.body) out.push(parts.body)
  return out.join('\n\n') + '\n'
}

function scopeBadges(scopes: FullAgent['scopes']) {
  const items = [
    { id: 'soul', label: 'SOUL', on: scopes.soul },
    { id: 'agents', label: 'AGENTS', on: scopes.agents },
    { id: 'tools', label: 'TOOLS', on: scopes.tools },
    { id: 'user', label: 'USER', on: scopes.user },
    { id: 'memory', label: 'MEMORY', on: scopes.memory },
  ]
  return items.map(s => (
    <Badge
      key={s.id}
      tone={s.on ? 'ok' : 'muted'}
      size="xs"
      title={s.on ? `Imported: ${s.label}` : 'Not imported'}
    >
      {s.label}
    </Badge>
  ))
}

const sharedFileDescriptions: Record<string, string> = {
  'SOUL.md': 'Personality, core truths, boundaries. Safe to share with every agent.',
  'AGENTS.md': 'Operating rules: session startup, memory hygiene, group-chat safety, hard rules.',
  'TOOLS.md': 'Quick reference for CLI tools. Privileged agents only.',
}

const codeInlineStyle: React.CSSProperties = {
  background: 'var(--bg-2)',
  padding: '1px 5px',
  borderRadius: 'var(--radius-xs)',
  fontSize: '0.92em',
  fontFamily: 'var(--mono)',
}

const tableHeadCell: React.CSSProperties = {
  textAlign: 'left',
  padding: '9px 12px',
  borderBottom: '1px solid var(--border)',
  fontWeight: 600,
}

const tableBodyCell: React.CSSProperties = {
  padding: '10px 12px',
  verticalAlign: 'top',
}

const jarvisHeadCell: React.CSSProperties = {
  textAlign: 'left',
  padding: '9px 14px',
  borderBottom: '1px solid var(--jarvis-border)',
  fontWeight: 600,
}

const jarvisBodyCell: React.CSSProperties = {
  padding: '12px 14px',
  verticalAlign: 'top',
}

export function Agents({ onToast }: { onToast: (msg: string, type: 'success' | 'error' | 'info') => void }) {
  const fetchAgents = useCallback(() => api.agentsFull(), [])
  const { data, refresh } = usePolling<FullAgent[]>(fetchAgents, 5000)

  const [view, setView] = useState<'table' | 'cards'>('table')
  const [newAgentName, setNewAgentName] = useState('')
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [processes, setProcesses] = useState<ProcessSession[]>([])
  const [sharedFiles, setSharedFiles] = useState<SharedFile[]>([])

  // Panel state
  const [panelType, setPanelType] = useState<'agent-file' | 'shared-file' | null>(null)
  const [fileEditorAgent, setFileEditorAgent] = useState('')
  const [fileEditorFile, setFileEditorFile] = useState('')
  const [fileEditorContent, setFileEditorContent] = useState('')
  const [fileEditorHeader, setFileEditorHeader] = useState('')
  const [fileEditorImports, setFileEditorImports] = useState<string[]>([])
  const [editorMode, setEditorMode] = useState<'preview' | 'edit'>('preview')
  const [fileSaving, setFileSaving] = useState(false)

  // Shared file editor
  const [sharedEditorFile, setSharedEditorFile] = useState('')
  const [sharedEditorContent, setSharedEditorContent] = useState('')
  const [sharedEditorMode, setSharedEditorMode] = useState<'preview' | 'edit'>('preview')
  const [sharedSaving, setSharedSaving] = useState(false)

  // Tools picker state
  const [toolsPanel, setToolsPanel] = useState<string | null>(null)
  const [toolsData, setToolsData] = useState<Tool[]>([])
  const [agentTools, setAgentTools] = useState<string[]>([])
  const [togglingTool, setTogglingTool] = useState<string | null>(null)

  // Global CLAUDE.md (system-wide, auto-loaded by all agents)
  const [globalClaudeMd, setGlobalClaudeMd] = useState('')
  const [globalClaudeMdSize, setGlobalClaudeMdSize] = useState(0)
  const [globalPanel, setGlobalPanel] = useState(false)
  const [globalEditContent, setGlobalEditContent] = useState('')
  const [globalEditorMode, setGlobalEditorMode] = useState<'preview' | 'edit'>('preview')
  const [savingGlobal, setSavingGlobal] = useState(false)

  const [turnsByAgent7d, setTurnsByAgent7d] = useState<Record<string, number>>({})
  const [hashFilter, setHashFilter] = useState(() => parseHashFilter(window.location.hash))
  const [hashFocus, setHashFocus] = useState(() => parseHashFocus(window.location.hash))
  const [detailAgent, setDetailAgent] = useState<string | null>(null)
  const [allRoutes, setAllRoutes] = useState<Array<{ index: number; channel: string; workspace: string; from: string; group: string | null }>>([])

  const agents = data || []
  const jarvisAgent = agents.find(a => a.name === 'jarvis')
  const otherAgents = agents.filter(a => a.name !== 'jarvis')

  // Load processes & shared files + global CLAUDE.md
  useEffect(() => {
    api.dashboardState().then(d => {
      setProcesses(d.processes)
      const ds = d as unknown as { globalClaudeMd?: string; globalClaudeMdSize?: number }
      setGlobalClaudeMd(ds.globalClaudeMd || '')
      setGlobalClaudeMdSize(ds.globalClaudeMdSize || 0)
    }).catch(() => {})
    api.getSharedFiles().then(d => setSharedFiles(d.files || [])).catch(() => {})
  }, [])

  useEffect(() => {
    api.routesFull().then(rs => {
      setAllRoutes(rs.map((r, index) => ({
        index,
        channel: r.channel,
        workspace: r.workspace,
        from: r.from,
        group: r.group || null,
      })))
    }).catch(() => {})
    fetch('/api/costs?days=7&groupBy=route')
      .then(r => r.json())
      .then((r: AgentCostsResponse) => {
        const map: Record<string, number> = {}
        for (const a of r.aggregated || []) map[a.key] = a.count
        setTurnsByAgent7d(map)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const onHash = () => {
      setHashFilter(parseHashFilter(window.location.hash))
      setHashFocus(parseHashFocus(window.location.hash))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Auto-open detail panel when ?focus=<name>
  useEffect(() => {
    if (hashFocus && agents.find(a => a.name === hashFocus)) setDetailAgent(hashFocus)
  }, [hashFocus, agents])

  // Map tool IDs to agent names for `?filter=tool:<toolId>`.
  const agentsByTool = useMemo(() => {
    const map: Record<string, Set<string>> = {}
    for (const a of agents) {
      for (const tid of a.tools || []) {
        if (!map[tid]) map[tid] = new Set()
        map[tid].add(a.name)
      }
    }
    return map
  }, [agents])

  const matchesHashFilter = (a: FullAgent): boolean => {
    if (!hashFilter) return true
    if (hashFilter.type === 'tool') {
      const set = agentsByTool[hashFilter.value]
      return !!(set && set.has(a.name))
    }
    return true
  }

  const visibleOtherAgents = otherAgents.filter(matchesHashFilter)

  const clearHashFilter = () => {
    setHashFilter(null)
    if (window.location.hash.includes('?')) {
      window.history.replaceState(null, '', '#/agents')
    }
  }

  const openGlobalEdit = async () => {
    try {
      const res = await fetch('/api/config/global-claude-md')
      const r = await res.json() as { content: string }
      setGlobalEditContent(r.content || '')
      setGlobalEditorMode('preview')
      setGlobalPanel(true)
    } catch (e) {
      onToast((e as Error).message || 'Failed to load global CLAUDE.md', 'error')
    }
  }

  const saveGlobal = async () => {
    setSavingGlobal(true)
    try {
      await fetch('/api/config/global-claude-md', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: globalEditContent }),
      })
      setGlobalClaudeMd(globalEditContent)
      setGlobalClaudeMdSize(globalEditContent.length)
      setGlobalPanel(false)
      onToast('Global CLAUDE.md saved', 'success')
    } catch (e) {
      onToast((e as Error).message || 'Failed to save', 'error')
    }
    setSavingGlobal(false)
  }

  const agentActiveSessions = (name: string) =>
    processes.filter(p => p.alive && (p.agentName as string | undefined) === name)

  const agentRouteLabels = (a: FullAgent) =>
    a.routes.map(r => {
      const ch = r.channel
      const target = r.group ? ' (group)' : r.from !== '*' ? ` (${r.from})` : ''
      return `${ch}${target}`
    })

  const agentTotalSize = (a: FullAgent) => {
    const own = (a.files || []).reduce((sum, f) => sum + (f.size || 0), 0)
    const scopes = a.scopes || {} as FullAgent['scopes']
    let sharedSize = 0
    const find = (name: string) => sharedFiles.find(f => f.name === name)?.size ?? 0
    if (scopes.soul) sharedSize += find('SOUL.md')
    if (scopes.agents) sharedSize += find('AGENTS.md')
    if (scopes.tools) sharedSize += find('TOOLS.md')
    return own + sharedSize
  }

  const sharedFileImporters = (name: string) => {
    const key = { 'SOUL.md': 'soul', 'AGENTS.md': 'agents', 'TOOLS.md': 'tools' }[name] as keyof FullAgent['scopes'] | undefined
    if (!key) return 'unknown'
    const importers = agents.filter(a => a.scopes?.[key]).map(a => a.name)
    return importers.length ? importers.join(', ') : 'none'
  }

  const createAgent = async () => {
    const name = newAgentName.trim()
    if (!name) { onToast('Agent name required', 'error'); return }
    setCreating(true)
    try {
      await api.createAgent({ name })
      setNewAgentName('')
      onToast(`Agent created: ${name}`, 'success')
      refresh()
    } catch (e) {
      onToast((e as Error).message || 'Failed to create agent', 'error')
    }
    setCreating(false)
  }

  const confirmDeleteAgent = async () => {
    if (!deleteTarget) return
    try {
      await api.deleteAgent(deleteTarget)
      onToast(`Agent deleted: ${deleteTarget}`, 'success')
      setDeleteTarget(null)
      refresh()
    } catch (e) {
      onToast((e as Error).message || 'Failed to delete agent', 'error')
    }
  }

  const openAgentFile = async (agentName: string, fileName: string) => {
    try {
      const r = await api.getAgentFile(agentName, fileName)
      if ((r as unknown as { error?: string }).error) {
        onToast((r as unknown as { error: string }).error, 'error'); return
      }
      const raw = r.content || ''
      if (fileName === 'CLAUDE.md') {
        const parts = splitImports(raw)
        setFileEditorHeader(parts.header)
        setFileEditorImports(parts.imports)
        setFileEditorContent(parts.body)
      } else {
        setFileEditorHeader('')
        setFileEditorImports([])
        setFileEditorContent(raw)
      }
      setFileEditorAgent(agentName)
      setFileEditorFile(fileName)
      setEditorMode('preview')
      setPanelType('agent-file')
    } catch (e) {
      onToast((e as Error).message || 'Failed to load file', 'error')
    }
  }

  const saveAgentFile = async () => {
    setFileSaving(true)
    try {
      let payload = fileEditorContent
      if (fileEditorFile === 'CLAUDE.md' && fileEditorImports.length) {
        payload = joinImports({
          header: fileEditorHeader,
          imports: fileEditorImports,
          body: fileEditorContent,
        })
      }
      await api.putAgentFile(fileEditorAgent, fileEditorFile, payload)
      onToast(`Saved ${fileEditorAgent}/${fileEditorFile}`, 'success')
      setPanelType(null)
      refresh()
    } catch (e) {
      onToast((e as Error).message || 'Failed to save file', 'error')
    }
    setFileSaving(false)
  }

  const openSharedFile = async (fileName: string) => {
    try {
      const r = await api.getSharedFile(fileName)
      setSharedEditorFile(fileName)
      setSharedEditorContent(r.content || '')
      setSharedEditorMode('preview')
      setPanelType('shared-file')
    } catch (e) {
      onToast((e as Error).message || 'Failed to load shared file', 'error')
    }
  }

  const saveSharedFile = async () => {
    setSharedSaving(true)
    try {
      await api.putSharedFile(sharedEditorFile, sharedEditorContent)
      onToast(`Saved _shared/${sharedEditorFile}`, 'success')
      setPanelType(null)
      api.getSharedFiles().then(d => setSharedFiles(d.files || [])).catch(() => {})
    } catch (e) {
      onToast((e as Error).message || 'Failed to save shared file', 'error')
    }
    setSharedSaving(false)
  }

  const saveAgentConfig = async (agentName: string, field: string, value: string | null) => {
    try {
      await api.updateAgentConfig(agentName, { [field]: value || undefined })
      onToast(`${agentName}: ${field} = ${value || 'default'}`, 'success')
      refresh()
    } catch (e) {
      onToast((e as Error).message || 'Failed to save config', 'error')
    }
  }

  const openToolsPicker = async (agentName: string, currentTools: string[]) => {
    setToolsPanel(agentName)
    setAgentTools(currentTools)
    try {
      const r = await api.tools()
      setToolsData(r.tools || [])
    } catch (e) { onToast((e as Error).message, 'error') }
  }

  const toggleTool = async (toolId: string) => {
    if (!toolsPanel || togglingTool) return
    const isOn = agentTools.includes(toolId)
    setTogglingTool(toolId)
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(toolsPanel)}/tools`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isOn ? { removeTool: toolId } : { addTool: toolId }),
      })
      if (!res.ok) throw new Error(`${res.status}`)
      const data = await res.json()
      setAgentTools(data.tools || [])
      refresh()
    } catch (e) { onToast((e as Error).message, 'error') }
    setTogglingTool(null)
  }

  const FileBadge = ({ file, onClick }: { file: { name: string; size: number }; onClick: () => void }) => (
    <Tooltip content={`${(file.size / 1024).toFixed(1)}KB — click to edit`} placement="top">
      <span
        onClick={(e) => { e.stopPropagation(); onClick() }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
          padding: '2px 8px',
          fontSize: 10,
          fontFamily: 'var(--mono)',
          border: '1px solid var(--border)',
          background: 'var(--surface-subtle)',
          color: 'var(--text-3)',
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
        }}
      >
        <span>{file.name}</span>
        <span style={{ color: 'var(--text-4)', fontSize: 9 }}>{(file.size / 1024).toFixed(1)}KB</span>
      </span>
    </Tooltip>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        title="Agents"
        count={`${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`}
        description="One folder per agent. Behavior (model, tools, CLAUDE.md) lives on the agent."
        actions={
          <>
            <div style={{ display: 'flex', gap: 2, background: 'var(--bg-0)', borderRadius: 'var(--radius)', padding: 2, border: '1px solid var(--border)' }}>
              <Tooltip content="Table view" placement="bottom"><button
                onClick={() => setView('table')}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 30, height: 26, padding: 0,
                  borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
                  background: view === 'table' ? 'var(--accent-tint-strong)' : 'transparent',
                  color: view === 'table' ? 'var(--accent-bright)' : 'var(--text-4)',
                  transition: 'background 0.15s',
                }}
              >
                <Table2 size={14} />
              </button></Tooltip>
              <Tooltip content="Cards view" placement="bottom"><button
                onClick={() => setView('cards')}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 30, height: 26, padding: 0,
                  borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
                  background: view === 'cards' ? 'var(--accent-tint-strong)' : 'transparent',
                  color: view === 'cards' ? 'var(--accent-bright)' : 'var(--text-4)',
                  transition: 'background 0.15s',
                }}
              >
                <LayoutGrid size={14} />
              </button></Tooltip>
            </div>
            <Input
              type="text"
              placeholder="new-agent-name"
              value={newAgentName}
              onChange={e => setNewAgentName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createAgent()}
              style={{ width: 180, padding: '6px 10px', fontSize: 12 }}
            />
            <Button
              variant="primary"
              size="sm"
              leading={<Plus size={14} />}
              onClick={createAgent}
              disabled={creating || !newAgentName.trim()}
              loading={creating}
            >
              New Agent
            </Button>
          </>
        }
      />

      {/* CONTEXT BASELINE — quanto pesa ogni agente prima di parlare */}
      <Card padding={16}>
        <SectionHeader
          title="🧠 Context baseline"
          count="static, no live data"
        />
        <p style={{ margin: '0 0 12px 0', fontSize: 12, color: 'var(--text-3)' }}>
          Token alla nascita di ogni agente — system + tools + MCP + skills + CLAUDE.md chain.
          Click su un agente per vedere il breakdown 8-categorie e i suggerimenti cruft.
        </p>
        <AgentBaselineList />
      </Card>

      {/* JARVIS HERO */}
      {jarvisAgent && (
        <Card tone="jarvis" padding={0} style={{ overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--jarvis-border)' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 28,
                height: 28,
                borderRadius: 'var(--radius)',
                background: 'var(--jarvis-gradient)',
                boxShadow: '0 0 14px rgba(113,112,255,0.4)',
              }}
            >
              <Sparkles size={15} color="#fff" strokeWidth={2.2} />
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
              <span className="jarvis-text" style={{ fontSize: 15, letterSpacing: -0.2 }}>Jarvis</span>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                Full-access orchestrator · {agentRouteLabels(jarvisAgent).join(', ') || 'no routes'}
              </span>
            </div>
            <Badge tone="jarvis" size="sm" uppercase>orchestrator</Badge>
          </div>

          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-0)', color: 'var(--text-4)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                <th style={jarvisHeadCell}>Core context (shared)</th>
                <th style={jarvisHeadCell}>Own files</th>
                <th style={jarvisHeadCell}>Model</th>
                <th style={jarvisHeadCell}>Tools</th>
                <th style={{ ...jarvisHeadCell, textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={jarvisBodyCell}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {sharedFiles.map(f => (
                      <FileBadge key={f.name} file={f} onClick={() => openSharedFile(f.name)} />
                    ))}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 8, lineHeight: 1.5 }}>
                    <strong style={{ color: 'var(--text-3)' }}>SOUL</strong> and <strong style={{ color: 'var(--text-3)' }}>AGENTS</strong> are universal. <strong style={{ color: 'var(--text-3)' }}>TOOLS</strong> is opt-in.
                  </div>
                </td>
                <td style={jarvisBodyCell}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {(jarvisAgent.files || []).map(f => (
                      <FileBadge key={f.name} file={f} onClick={() => openAgentFile('jarvis', f.name)} />
                    ))}
                  </div>
                </td>
                <td style={jarvisBodyCell}>
                  <Select
                    value={jarvisAgent.model || 'opus'}
                    onChange={e => saveAgentConfig('jarvis', 'model', e.target.value)}
                    style={{ padding: '4px 8px', fontSize: 11, fontFamily: 'var(--mono)', width: 'auto', background: 'var(--bg-0)' }}
                  >
                    <option value="opus">opus</option>
                    <option value="sonnet">sonnet</option>
                    <option value="haiku">haiku</option>
                  </Select>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 9, color: 'var(--text-4)' }}>effort</span>
                    <Select
                      value={jarvisAgent.effort || ''}
                      onChange={e => saveAgentConfig('jarvis', 'effort', e.target.value || null)}
                      style={{ padding: '2px 6px', fontSize: 10, width: 'auto', background: 'var(--bg-0)' }}
                    >
                      <option value="">default</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                      <option value="max">max</option>
                    </Select>
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--text-4)', marginTop: 4 }}>
                    fallback: {(jarvisAgent.fallbacks || []).join(', ') || 'none'}
                  </div>
                </td>
                <td style={jarvisBodyCell}>
                  <Badge tone="jarvis" size="sm" title="fullAccess: all MCP servers, no tool restrictions">FULL</Badge>
                  <div style={{ fontSize: 9, color: 'var(--text-4)', marginTop: 5 }}>all MCP, no filters</div>
                </td>
                <td style={{ ...jarvisBodyCell, textAlign: 'right', fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 13, color: 'var(--text-1)' }}>
                  {(agentTotalSize(jarvisAgent) / 1024).toFixed(1)}KB
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
      )}

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

      {/* Info bar */}
      <InfoBox title="Other agents">
        One folder per agent. <code style={codeInlineStyle}>SOUL.md</code> and <code style={codeInlineStyle}>AGENTS.md</code> are loaded automatically.{' '}
        <code style={codeInlineStyle}>TOOLS.md</code> is opt-in — agents that include it show a <Badge tone="ok" size="xs" mono>+TOOLS.md</Badge> badge.
      </InfoBox>

      {/* TABLE VIEW */}
      {view === 'table' && (
        <div style={{ borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', overflow: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-0)', color: 'var(--text-4)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                <th style={tableHeadCell}>Agent</th>
                <th style={tableHeadCell}>Model</th>
                <th style={tableHeadCell}>Routes</th>
                <th style={tableHeadCell}>Own files</th>
                <th style={tableHeadCell}>Tools</th>
                <th style={{ ...tableHeadCell, textAlign: 'right' }}>Total</th>
                <th style={{ ...tableHeadCell, textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {visibleOtherAgents.map(a => {
                const sessions = agentActiveSessions(a.name)
                const routeLabels = agentRouteLabels(a)
                const hasFullAccess = a.routes.some(r => r.fullAccess)
                const turns7d = turnsByAgent7d[a.name] || 0
                return (
                  <tr key={a.name} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={tableBodyCell}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <AgentName name={a.name} size="xs" onClick={() => setDetailAgent(a.name)} />
                        {hasFullAccess && <Badge tone="accent" size="xs" title="fullAccess: true">FULL</Badge>}
                        {a.scopes?.tools && (
                          <Badge tone="ok" size="xs" mono title="Imports _shared/TOOLS.md" onClick={(e) => { e.stopPropagation(); openSharedFile('TOOLS.md') }}>
                            +TOOLS.md
                          </Badge>
                        )}
                        {routeLabels.length === 0 && <Badge tone="muted" size="xs">unused</Badge>}
                        {a.routes.length > 0 && (
                          <BadgeLink
                            href={`#/routes?filter=agent:${encodeURIComponent(a.name)}`}
                            tone="neutral"
                            size="xs"
                            count={a.routes.length}
                            label="routes"
                            title="Filter Routes by this agent"
                            stopPropagation
                          />
                        )}
                        {sessions.length > 0 && (
                          <BadgeLink
                            href={`#/sessions?filter=agent:${encodeURIComponent(a.name)}`}
                            tone="ok"
                            size="xs"
                            count={sessions.length}
                            label="active"
                            title="Open active sessions for this agent"
                            stopPropagation
                          />
                        )}
                        {turns7d > 0 && (
                          <BadgeLink
                            href={`#/analytics?groupBy=route&period=7d&filter=agent:${encodeURIComponent(a.name)}`}
                            tone="muted"
                            size="xs"
                            count={turns7d}
                            label="msgs 7d"
                            title="Analytics breakdown for this agent over the last 7 days"
                            stopPropagation
                          />
                        )}
                      </div>
                    </td>
                    <td style={tableBodyCell}>
                      <Select
                        value={a.model || 'opus'}
                        onChange={e => saveAgentConfig(a.name, 'model', e.target.value)}
                        style={{ padding: '3px 6px', fontSize: 11, fontFamily: 'var(--mono)', width: 'auto', background: 'var(--bg-0)' }}
                      >
                        <option value="opus">opus</option>
                        <option value="sonnet">sonnet</option>
                        <option value="haiku">haiku</option>
                      </Select>
                      {a.effort && <div style={{ fontSize: 9, color: 'var(--text-4)', marginTop: 3 }}>effort: {a.effort}</div>}
                    </td>
                    <td style={tableBodyCell}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {routeLabels.length > 0 ? routeLabels.map((label, i) => (
                          <BadgeLink
                            key={i}
                            href={`#/routes?filter=agent:${encodeURIComponent(a.name)}`}
                            tone="accent"
                            size="xs"
                            label={label}
                            title="Open Routes filtered by this agent"
                            stopPropagation
                          />
                        )) : <span style={{ fontSize: 10, color: 'var(--text-4)' }}>not routed</span>}
                      </div>
                    </td>
                    <td style={tableBodyCell}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {(a.files || []).map(f => <FileBadge key={f.name} file={f} onClick={() => openAgentFile(a.name, f.name)} />)}
                      </div>
                    </td>
                    <td style={tableBodyCell}>
                      {hasFullAccess
                        ? <Badge tone="accent" size="xs">FULL</Badge>
                        : (
                          <span
                            style={{ fontSize: 11, color: 'var(--accent-bright)', cursor: 'pointer' }}
                            onClick={(e) => { e.stopPropagation(); openToolsPicker(a.name, a.tools || []) }}
                          >
                            {a.tools?.length || 0} tools
                          </span>
                        )}
                    </td>
                    <td style={{ ...tableBodyCell, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
                      {(agentTotalSize(a) / 1024).toFixed(1)}KB
                    </td>
                    <td style={{ ...tableBodyCell, textAlign: 'right' }}>
                      {routeLabels.length === 0 && (
                        <Button size="xs" variant="danger-ghost" onClick={() => setDeleteTarget(a.name)}>Delete</Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* CARDS VIEW */}
      {view === 'cards' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {visibleOtherAgents.map(a => {
            const sessions = agentActiveSessions(a.name)
            const routeLabels = agentRouteLabels(a)
            const hasFullAccess = a.routes.some(r => r.fullAccess)
            const turns7d = turnsByAgent7d[a.name] || 0
            return (
              <Card key={a.name} interactive padding="14px 16px" onClick={() => setDetailAgent(a.name)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                  <AgentName name={a.name} size="sm" />
                  {hasFullAccess && <Badge tone="accent" size="xs">FULL</Badge>}
                  {a.routes.length > 0 && (
                    <BadgeLink
                      href={`#/routes?filter=agent:${encodeURIComponent(a.name)}`}
                      tone="neutral"
                      size="xs"
                      count={a.routes.length}
                      label="routes"
                      stopPropagation
                    />
                  )}
                  {sessions.length > 0 && (
                    <BadgeLink
                      href={`#/sessions?filter=agent:${encodeURIComponent(a.name)}`}
                      tone="ok"
                      size="xs"
                      count={sessions.length}
                      label="active"
                      stopPropagation
                    />
                  )}
                  {turns7d > 0 && (
                    <BadgeLink
                      href={`#/analytics?groupBy=route&period=7d&filter=agent:${encodeURIComponent(a.name)}`}
                      tone="muted"
                      size="xs"
                      count={turns7d}
                      label="msgs 7d"
                      stopPropagation
                    />
                  )}
                </div>
                {a.scopes && <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>{scopeBadges(a.scopes)}</div>}
                <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
                  {(a.files || []).map(f => <FileBadge key={f.name} file={f} onClick={() => openAgentFile(a.name, f.name)} />)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-4)', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--mono)' }}>{(agentTotalSize(a) / 1024).toFixed(1)}KB total</span>
                  {!hasFullAccess && (
                    <span
                      style={{ fontSize: 10, color: 'var(--accent-bright)', cursor: 'pointer' }}
                      onClick={(e) => { e.stopPropagation(); openToolsPicker(a.name, a.tools || []) }}
                    >
                      {a.tools?.length || 0} tools
                    </span>
                  )}
                  {routeLabels.length === 0 && (
                    <Button size="xs" variant="danger-ghost" onClick={() => setDeleteTarget(a.name)}>Delete</Button>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {/* GLOBAL CLAUDE.md — system-wide, auto-loaded by all agents */}
      <div style={{ marginTop: 12 }}>
        <SectionHeader
          title="Global context"
          action={<span style={{ fontSize: 11, color: 'var(--text-4)' }}>Auto-loaded by every agent</span>}
        />
        <Card interactive padding="14px 16px" onClick={openGlobalEdit}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>
              CLAUDE.md
            </span>
            <Badge tone="muted" size="xs" mono>{(globalClaudeMdSize / 1024).toFixed(1)}KB</Badge>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
            Lives in <code style={codeInlineStyle}>~/.claude/CLAUDE.md</code>. Loaded automatically before every
            agent-specific CLAUDE.md. Use it for identity, global rules, and references shared across all agents.
          </div>
        </Card>
      </div>

      {/* SHARED FILES SECTION */}
      <div style={{ marginTop: 4 }}>
        <SectionHeader title="Shared Files" />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {sharedFiles.map(f => (
            <Card key={f.name} interactive padding="14px 16px" onClick={() => openSharedFile(f.name)}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600, color: 'var(--text-1)' }}>
                  {f.name}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-4)' }}>
                  {(f.size / 1024).toFixed(1)}KB
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 8 }}>
                {sharedFileDescriptions[f.name] || '(no description)'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-4)' }}>
                Used by: <span style={{ color: 'var(--text-2)' }}>{sharedFileImporters(f.name)}</span>
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* AGENT FILE EDIT PANEL */}
      <Panel open={panelType === 'agent-file'} title={`${fileEditorAgent} / ${fileEditorFile}`} onClose={() => setPanelType(null)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--text-4)' }}>
            Agent-specific file in <code style={codeInlineStyle}>~/.claude/jarvis/agents/{fileEditorAgent}/</code>
          </div>
          {fileEditorHeader && (
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--text-2)',
                padding: '10px 12px',
                background: 'var(--bg-0)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                whiteSpace: 'pre-wrap',
              }}
            >
              {fileEditorHeader}
            </div>
          )}
          {fileEditorImports.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-4)', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 }}>
                Imports · structural, not editable here
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  padding: '10px 12px',
                  background: 'var(--surface-subtle)',
                  border: '1px dashed var(--border-strong)',
                  borderRadius: 'var(--radius)',
                }}
              >
                {fileEditorImports.map((imp, i) => (
                  <span key={i} style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>{imp}</span>
                ))}
              </div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 4 }}>
            <Button
              size="xs"
              variant={editorMode === 'preview' ? 'primary' : 'secondary'}
              onClick={() => setEditorMode('preview')}
            >
              Preview
            </Button>
            <Button
              size="xs"
              variant={editorMode === 'edit' ? 'primary' : 'secondary'}
              onClick={() => setEditorMode('edit')}
            >
              Edit
            </Button>
          </div>
          {editorMode === 'edit' ? (
            <Textarea
              value={fileEditorContent}
              onChange={e => setFileEditorContent(e.target.value)}
              placeholder="Content…"
              style={{ minHeight: 'calc(100vh - 420px)' }}
            />
          ) : (
            <MarkdownPreview content={fileEditorContent} style={{ maxHeight: 'calc(100vh - 420px)' }} />
          )}
          {editorMode === 'edit' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="primary" size="md" onClick={saveAgentFile} loading={fileSaving}>Save</Button>
              <Button variant="secondary" size="md" onClick={() => setPanelType(null)}>Cancel</Button>
            </div>
          )}
        </div>
      </Panel>

      {/* SHARED FILE EDIT PANEL */}
      <Panel open={panelType === 'shared-file'} title={`_shared / ${sharedEditorFile}`} onClose={() => setPanelType(null)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {sharedEditorFile === 'TOOLS.md' ? (
            <>
              <InfoBox title="Tool reference cheatsheet">
                Imported by privileged agents via <code style={codeInlineStyle}>@imports</code>.
              </InfoBox>
              <MarkdownPreview content={sharedEditorContent} style={{ maxHeight: 'calc(100vh - 240px)' }} />
            </>
          ) : (
            <>
              <div style={{ fontSize: 11, color: 'var(--text-4)' }}>
                Shared across every agent that imports it. Editing affects all of them.
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <Button
                  size="xs"
                  variant={sharedEditorMode === 'preview' ? 'primary' : 'secondary'}
                  onClick={() => setSharedEditorMode('preview')}
                >
                  Preview
                </Button>
                <Button
                  size="xs"
                  variant={sharedEditorMode === 'edit' ? 'primary' : 'secondary'}
                  onClick={() => setSharedEditorMode('edit')}
                >
                  Edit
                </Button>
              </div>
              {sharedEditorMode === 'edit' ? (
                <Textarea
                  value={sharedEditorContent}
                  onChange={e => setSharedEditorContent(e.target.value)}
                  style={{ minHeight: 'calc(100vh - 280px)' }}
                />
              ) : (
                <MarkdownPreview content={sharedEditorContent} style={{ maxHeight: 'calc(100vh - 280px)' }} />
              )}
              {sharedEditorMode === 'edit' && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button variant="primary" size="md" onClick={saveSharedFile} loading={sharedSaving}>Save</Button>
                  <Button variant="secondary" size="md" onClick={() => setPanelType(null)}>Cancel</Button>
                </div>
              )}
            </>
          )}
        </div>
      </Panel>

      {/* AGENT DETAIL PANEL (Related routes / sessions / memory) */}
      <Panel
        open={detailAgent !== null}
        title={detailAgent ? `${detailAgent} — Related` : ''}
        onClose={() => setDetailAgent(null)}
      >
        {detailAgent && (() => {
          const a = agents.find(x => x.name === detailAgent)
          if (!a) return null
          const sessions = agentActiveSessions(a.name)
          const routesForAgent = allRoutes.filter(r => r.workspace === a.name)
          const turns7d = turnsByAgent7d[a.name] || 0
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Button size="sm" onClick={() => { setDetailAgent(null); openAgentFile(a.name, 'CLAUDE.md') }}>
                  Edit CLAUDE.md →
                </Button>
                <Button size="sm" onClick={() => { setDetailAgent(null); openToolsPicker(a.name, a.tools || []) }}>
                  Edit tools →
                </Button>
                <Button size="sm" onClick={() => { window.location.hash = `#/memory?agent=${encodeURIComponent(a.name)}` }}>
                  View memory →
                </Button>
              </div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <BadgeLink
                  href={`#/routes?filter=agent:${encodeURIComponent(a.name)}`}
                  tone="accent"
                  size="sm"
                  count={routesForAgent.length}
                  label="routes"
                />
                <BadgeLink
                  href={`#/sessions?filter=agent:${encodeURIComponent(a.name)}`}
                  tone={sessions.length > 0 ? 'ok' : 'muted'}
                  size="sm"
                  count={sessions.length}
                  label="sessions"
                />
                <BadgeLink
                  href={`#/analytics?groupBy=route&period=7d&filter=agent:${encodeURIComponent(a.name)}`}
                  tone="muted"
                  size="sm"
                  count={turns7d}
                  label="msgs 7d"
                />
              </div>

              <div>
                <SectionHeader title="Routes" count={routesForAgent.length} />
                <RelatedList
                  empty="No route uses this agent"
                  items={routesForAgent.map(r => ({
                    key: `r-${r.index}`,
                    href: `#/routes?filter=agent:${encodeURIComponent(a.name)}`,
                    primary: (
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                        {r.channel} · {r.group || (r.from !== '*' ? r.from : 'any')}
                      </span>
                    ),
                    secondary: `#${r.index}`,
                  }))}
                />
              </div>

              <div>
                <SectionHeader title="Active sessions" count={sessions.length} />
                <RelatedList
                  empty="No active sessions"
                  items={sessions.map(sp => ({
                    key: sp.key,
                    href: `#/sessions?filter=key:${encodeURIComponent(sp.key)}`,
                    primary: <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{sp.key.length > 32 ? sp.key.slice(0, 32) + '…' : sp.key}</span>,
                    secondary: `${sp.channel || '?'} · ${sp.messageCount} turns · ~${(sp.estimatedTokens / 1000).toFixed(0)}k tok`,
                    trailing: (
                      <span
                        style={{
                          width: 8, height: 8, borderRadius: '50%',
                          background: sp.alive ? 'var(--ok)' : 'var(--err)',
                        }}
                      />
                    ),
                  }))}
                />
              </div>

              <div>
                <SectionHeader title="Memory" />
                <RelatedList
                  items={[{
                    key: 'mem',
                    href: `#/memory?agent=${encodeURIComponent(a.name)}`,
                    primary: 'Open memory filtered by agent',
                    secondary: `~/.claude/jarvis/agents/${a.name}/`,
                  }]}
                />
              </div>
            </div>
          )
        })()}
      </Panel>

      {/* TOOLS PICKER PANEL */}
      <Panel open={!!toolsPanel} title={`${toolsPanel} — Tools`} onClose={() => setToolsPanel(null)}>
        {toolsPanel && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <InfoBox>
              Click any tool to toggle it <strong style={{ color: 'var(--text-2)' }}>ON/OFF</strong> for this agent.
              Changes save to <code style={codeInlineStyle}>agents/{toolsPanel}/agent.yaml</code>.
            </InfoBox>
            {['Media', 'Email', 'Calendar', 'Memory', 'System', 'MCP'].map(cat => {
              const catTools = toolsData.filter(t => (t.category || 'System') === cat)
              if (!catTools.length) return null
              return (
                <div key={cat}>
                  <SectionHeader title={cat} count={catTools.length} />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    {catTools.map(td => {
                      const isOn = agentTools.includes(td.id)
                      return (
                        <div
                          key={td.id}
                          onClick={() => toggleTool(td.id)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '7px 12px',
                            borderRadius: 'var(--radius)',
                            cursor: 'pointer',
                            background: isOn ? 'var(--accent-tint)' : 'var(--bg-0)',
                            border: `1px solid ${isOn ? 'var(--accent-border)' : 'var(--border)'}`,
                            opacity: togglingTool === td.id ? 0.5 : 1,
                            transition: 'background 0.15s, border-color 0.15s',
                          }}
                        >
                          <span style={{ display: 'inline-flex', color: 'var(--text-3)' }}><ToolIcon id={td.id} type={td.type} size={14} /></span>
                          <span style={{ fontSize: 12, color: 'var(--text-2)', flex: 1 }}>{td.label}</span>
                          <span
                            style={{
                              fontSize: 10,
                              color: isOn ? 'var(--ok)' : 'var(--text-4)',
                              fontWeight: 500,
                              textTransform: 'uppercase',
                              letterSpacing: 0.4,
                            }}
                          >
                            {isOn ? 'On' : 'Off'}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Panel>

      {/* Global CLAUDE.md editor */}
      <Panel open={globalPanel} title="Global CLAUDE.md" onClose={() => setGlobalPanel(false)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--text-4)', lineHeight: 1.55 }}>
            System prompt auto-loaded by every agent. Lives in <code style={codeInlineStyle}>~/.claude/CLAUDE.md</code>.
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <Button
              size="xs"
              variant={globalEditorMode === 'preview' ? 'primary' : 'secondary'}
              onClick={() => setGlobalEditorMode('preview')}
            >
              Preview
            </Button>
            <Button
              size="xs"
              variant={globalEditorMode === 'edit' ? 'primary' : 'secondary'}
              onClick={() => setGlobalEditorMode('edit')}
            >
              Edit
            </Button>
          </div>
          {globalEditorMode === 'edit' ? (
            <Textarea
              value={globalEditContent}
              onChange={(e) => setGlobalEditContent(e.target.value)}
              style={{ minHeight: 'calc(100vh - 280px)' }}
            />
          ) : (
            <pre
              style={{
                minHeight: 200,
                maxHeight: 'calc(100vh - 280px)',
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
              {globalEditContent || globalClaudeMd}
            </pre>
          )}
          {globalEditorMode === 'edit' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="primary" size="md" onClick={saveGlobal} loading={savingGlobal}>Save</Button>
              <Button variant="secondary" size="md" onClick={() => setGlobalPanel(false)}>Cancel</Button>
            </div>
          )}
        </div>
      </Panel>

      {/* Delete confirmation */}
      <Modal open={deleteTarget !== null} title="Delete Agent" onConfirm={confirmDeleteAgent} onCancel={() => setDeleteTarget(null)} confirmLabel="Delete" danger>
        Delete agent &quot;{deleteTarget}&quot; and its CLAUDE.md?
      </Modal>
    </div>
  )
}
