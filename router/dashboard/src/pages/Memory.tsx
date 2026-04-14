import type React from 'react'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import * as THREE from 'three'
import { Search, MoreHorizontal, RefreshCw, Layers, X } from 'lucide-react'
import { Panel } from '../components/Panel'
import { SectionHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { Input, Field } from '../components/ui/Field'

// ── Types ──

interface MemFile {
  path: string
  name: string
  category: string
  size: number
  mtime?: number
  preview?: string
  title?: string
}

interface MemMemory {
  id: string
  user_id?: string
  memory?: string
  created_at?: string
}

interface MemSearchDoc {
  text?: string
  score?: number
  metadata?: { file?: string; path?: string; scope?: string }
}

interface MemSearchMem {
  id: string
  user_id?: string
  memory?: string
  created_at?: string
  score?: number
}

interface MemSearchResults {
  docs?: MemSearchDoc[]
  memories?: MemSearchMem[]
  partial?: string[]
}

interface MemDoctor {
  totalFiles: number
  issueCount: number
  duplicateNames: Array<{ name: string; paths: string[] }>
  tinyFiles: Array<{ path: string; size: number }>
  orphans: string[]
  dailyCollisions: Array<{ date: string; paths: string[] }>
}

interface GraphNode {
  id: string
  label: string
  category: string
  size: number
  links: number
  x?: number
  y?: number
  z?: number
}

interface GraphEdge {
  source: string | GraphNode
  target: string | GraphNode
}

interface MemStatsData {
  docs?: { total_files?: number; total_chunks?: number; by_scope?: Record<string, number> }
  memories?: { total?: number }
}

type ViewMode = 'graph' | 'list' | 'grid'

// ── Constants ──

const kbdStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 6px',
  fontSize: 11,
  fontFamily: 'var(--mono)',
  background: 'rgba(255,255,255,0.10)',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 4,
  marginRight: 4,
  color: 'var(--text-2)',
  lineHeight: 1.2,
  minWidth: 14,
  textAlign: 'center' as const,
}

const GRAPH_COLORS: Record<string, string> = {
  people: '#f59e0b',
  projects: '#8b5cf6',
  procedures: '#06b6d4',
  tools: '#10b981',
  daily: '#64748b',
  _root: '#94a3b8',
  archive: '#475569',
  reviews: '#ec4899',
}

// ── Helpers ──

const BASE = ''

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const method = (opts?.method || 'GET').toUpperCase()
  const extraHeaders: Record<string, string> =
    method === 'GET' ? {} : { 'X-Confirm': 'true' }
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
      ...(opts?.headers || {}),
    },
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

function short(s: string, max: number) {
  return s.length > max ? s.slice(0, max) + '…' : s
}

function escHtml(s: string) {
  const d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

function highlightText(text: string, query: string) {
  if (!query || !text) return escHtml(text || '')
  const safe = escHtml(text)
  const q = escHtml(query)
  const escaped = q.replace(/[.+?^$|()]/g, '\\$&')
  const parts = safe.split(new RegExp('(' + escaped + ')', 'gi'))
  return parts
    .map((p, i) =>
      i % 2 === 1
        ? `<mark style="background:rgba(94,106,210,0.3);color:var(--text-1);border-radius:2px;padding:0 1px">${p}</mark>`
        : p,
    )
    .join('')
}

function formatMemDate(d?: string) {
  if (!d) return ''
  try {
    const dt = new Date(d)
    return dt.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return d
  }
}

function formatFileDate(mtime?: number) {
  if (!mtime) return ''
  try {
    return new Date(mtime).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })
  } catch { return '' }
}

function relPathFromAny(p: string) {
  const marker = '/memory/'
  const i = p.indexOf(marker)
  return i >= 0 ? p.slice(i + marker.length) : p
}

// ── Component ──

export function Memory({ onToast }: { onToast: (msg: string, type: 'success' | 'error' | 'info') => void }) {
  // ── State ──
  const [memQuery, setMemQuery] = useState('')
  const [memScope, setMemScope] = useState('')
  const [scopeHelp, setScopeHelp] = useState<Record<string, string>>({})
  const [reindexing, setReindexing] = useState(false)
  const [scopesPanelOpen, setScopesPanelOpen] = useState(false)
  const [newMemScope, setNewMemScope] = useState('')
  const [addingScope, setAddingScope] = useState(false)
  const [doctor, setDoctor] = useState<MemDoctor | null>(null)
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [doctorDismissed, setDoctorDismissed] = useState(() => {
    if (typeof window === 'undefined') return false
    return sessionStorage.getItem('memory:doctorDismissed') === '1'
  })

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === 'undefined') return 'graph'
    const stored = localStorage.getItem('memory:viewMode') as ViewMode | null
    return stored === 'graph' || stored === 'list' || stored === 'grid' ? stored : 'graph'
  })

  const [files, setFiles] = useState<MemFile[]>([])
  const [memories, setMemories] = useState<MemMemory[]>([])
  const [_stats, setStats] = useState<MemStatsData | null>(null)

  const [browseView, setBrowseView] = useState<'documents' | 'facts'>('documents')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState('')
  const [editorMode, setEditorMode] = useState<'preview' | 'edit'>('preview')
  const [savingFile, setSavingFile] = useState(false)
  const [related, setRelated] = useState<MemSearchDoc[]>([])

  const [memsUserFilter, setMemsUserFilter] = useState('')
  const [memsSort, setMemsSort] = useState('date-desc')

  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<MemSearchResults>({})
  const hasSearchResults = useMemo(
    () => !!(searchResults.docs?.length || searchResults.memories?.length),
    [searchResults],
  )

  const [showQuickAdd, setShowQuickAdd] = useState(false)
  const [qaTitle, setQaTitle] = useState('')
  const [qaContent, setQaContent] = useState('')
  const [qaCategory, setQaCategory] = useState('_root')
  const [qaSaving, setQaSaving] = useState(false)

  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([])
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([])
  const [loadingGraph, setLoadingGraph] = useState(false)
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null)

  const graphContainerRef = useRef<HTMLDivElement>(null)
  const graphInstanceRef = useRef<any>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const fullGraphDataRef = useRef<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] })
  const hoveredNodeRef = useRef<GraphNode | null>(null)
  const filesRef = useRef<MemFile[]>([])
  const highlightedIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => { hoveredNodeRef.current = hoveredNode }, [hoveredNode])
  useEffect(() => { filesRef.current = files }, [files])

  useEffect(() => {
    try { localStorage.setItem('memory:viewMode', viewMode) } catch { /* ignore */ }
  }, [viewMode])

  // ── Derived data ──
  const graphStats = useMemo(() => {
    return `${graphNodes.length} nodes · ${graphEdges.length} edges`
  }, [graphNodes, graphEdges])

  const filteredFiles = useMemo(() => {
    if (!memScope) return files
    return files.filter((f) => f.path.includes(`/${memScope}/`) || f.category === memScope)
  }, [files, memScope])

  const scopeChips = useMemo(() => {
    const counts: Record<string, number> = {}
    files.forEach((f) => {
      const cat = f.category || '_root'
      counts[cat] = (counts[cat] || 0) + 1
    })
    return Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .map(([id, count]) => ({ id, count, color: GRAPH_COLORS[id] || '#94a3b8' }))
  }, [files])

  const filesByCategory = useMemo(() => {
    const groups: Record<string, MemFile[]> = {}
    filteredFiles.forEach((f) => {
      const cat = f.category || '_root'
      if (!groups[cat]) groups[cat] = []
      groups[cat].push(f)
    })
    return groups
  }, [filteredFiles])

  const memsUsers = useMemo(() => {
    const set = new Set<string>()
    memories.forEach((m) => { if (m.user_id) set.add(m.user_id) })
    return Array.from(set).sort()
  }, [memories])

  const filteredMems = useMemo(() => {
    let out = [...memories]
    if (memsUserFilter) out = out.filter((m) => m.user_id === memsUserFilter)
    if (memsSort === 'date-desc') out.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    else if (memsSort === 'date-asc') out.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    else if (memsSort === 'user') out.sort((a, b) => (a.user_id || '').localeCompare(b.user_id || ''))
    return out
  }, [memories, memsUserFilter, memsSort])

  const sortedGridFiles = useMemo(() => {
    return [...filteredFiles].sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
  }, [filteredFiles])

  // ── API calls ──
  const loadStats = useCallback(async () => {
    try {
      const data = await apiFetch<MemStatsData>('/api/memory/stats')
      setStats(data)
    } catch { /* ignore */ }
  }, [])

  const loadFiles = useCallback(async () => {
    try {
      const data = await apiFetch<{ files: MemFile[] }>('/api/memory/files')
      setFiles(data.files || [])
    } catch { /* ignore */ }
  }, [])

  const loadMemories = useCallback(async () => {
    try {
      const scopeParam = memScope ? `?scope=${encodeURIComponent(memScope)}` : ''
      const data = await apiFetch<{ memories: MemMemory[] }>(`/api/memory/memories${scopeParam}`)
      setMemories(data.memories || [])
    } catch { /* ignore */ }
  }, [memScope])

  const loadGraph = useCallback(async () => {
    setLoadingGraph(true)
    try {
      const data = await apiFetch<{ nodes: GraphNode[]; edges: GraphEdge[] }>('/api/memory/graph')
      const nodes = (data.nodes || []).map((n) => ({ ...n, links: 0 }))
      const edges = data.edges || []
      const linkCounts: Record<string, number> = {}
      edges.forEach((e) => {
        const src = typeof e.source === 'string' ? e.source : e.source.id
        const tgt = typeof e.target === 'string' ? e.target : e.target.id
        linkCounts[src] = (linkCounts[src] || 0) + 1
        linkCounts[tgt] = (linkCounts[tgt] || 0) + 1
      })
      nodes.forEach((n) => { n.links = linkCounts[n.id] || 0 })
      setGraphNodes(nodes)
      setGraphEdges(edges)
      fullGraphDataRef.current = { nodes, edges }
    } catch {
      onToast('Failed to load graph', 'error')
    } finally {
      setLoadingGraph(false)
    }
  }, [onToast])

  const loadDoctor = useCallback(async () => {
    try {
      const data = await apiFetch<MemDoctor>('/api/memory/doctor')
      setDoctor(data)
    } catch { /* doctor is advisory — don't toast on failure */ }
  }, [])

  const loadScopeHelp = useCallback(async () => {
    try {
      const data = await apiFetch<{ scopeHelp?: Record<string, string> }>('/api/dashboard-state')
      if (data.scopeHelp) setScopeHelp(data.scopeHelp)
    } catch { /* ignore */ }
  }, [])

  // ── File operations ──
  const loadRelated = useCallback(async (path: string) => {
    try {
      const name = path.split('/').pop()?.replace(/\.md$/, '') || ''
      if (!name) return
      const data = await apiFetch<MemSearchResults>(`/api/memory/search?q=${encodeURIComponent(name)}`)
      const matches = (data.docs || []).filter((d) => {
        const p = d.metadata?.path || d.metadata?.file || ''
        return relPathFromAny(p) !== path
      }).slice(0, 5)
      setRelated(matches)
    } catch { setRelated([]) }
  }, [])

  const selectFile = useCallback(async (path: string) => {
    setSelectedFile(path)
    setEditorMode('preview')
    setRelated([])
    try {
      const data = await apiFetch<{ content: string }>(`/api/memory/file?path=${encodeURIComponent(path)}`)
      setFileContent(data.content || '')
      loadRelated(path)
    } catch {
      setFileContent('(failed to load)')
    }
  }, [loadRelated])

  const saveFile = useCallback(async () => {
    if (!selectedFile) return
    setSavingFile(true)
    try {
      await apiFetch('/api/memory/file', {
        method: 'PUT',
        body: JSON.stringify({ path: selectedFile, content: fileContent }),
      })
      onToast('Saved', 'success')
      loadFiles()
    } catch {
      onToast('Save failed', 'error')
    } finally {
      setSavingFile(false)
    }
  }, [selectedFile, fileContent, onToast, loadFiles])

  const deleteFile = useCallback(async (path: string) => {
    if (!confirm(`Delete ${path}?`)) return
    try {
      await apiFetch(`/api/memory/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
      onToast('Deleted', 'success')
      setSelectedFile(null)
      setFileContent('')
      loadFiles()
      loadGraph()
    } catch {
      onToast('Delete failed', 'error')
    }
  }, [onToast, loadFiles, loadGraph])

  const deleteMem = useCallback(async (id: string) => {
    try {
      await apiFetch(`/api/memory/${id}`, { method: 'DELETE' })
      onToast('Deleted', 'success')
      loadMemories()
    } catch {
      onToast('Delete failed', 'error')
    }
  }, [onToast, loadMemories])

  const reindex = useCallback(async () => {
    setReindexing(true)
    try {
      await apiFetch('/api/memory/reindex', { method: 'POST' })
      onToast('Reindex started', 'info')
      setTimeout(() => {
        loadStats()
        loadFiles()
        loadGraph()
        loadMemories()
      }, 2000)
    } catch {
      onToast('Reindex failed', 'error')
    } finally {
      setReindexing(false)
    }
  }, [onToast, loadStats, loadFiles, loadGraph, loadMemories])

  const addMemScope = useCallback(async () => {
    const scope = newMemScope.trim()
    if (!scope) return
    setAddingScope(true)
    try {
      await fetch('/api/config/memory-scopes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      })
      setNewMemScope('')
      onToast('Memory scope added: ' + scope, 'success')
      const res = await fetch('/api/dashboard-state')
      const data = await res.json() as { scopeHelp?: Record<string, string> }
      if (data.scopeHelp) setScopeHelp(data.scopeHelp)
    } catch (e: unknown) {
      onToast(e instanceof Error ? e.message : String(e), 'error')
    }
    setAddingScope(false)
  }, [newMemScope, onToast])

  const openDocFromSearch = useCallback((filePath?: string) => {
    if (!filePath) return
    const rel = relPathFromAny(filePath)
    selectFile(rel)
  }, [selectFile])

  const saveQuickAdd = useCallback(async () => {
    const slug = qaTitle.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `note-${Date.now()}`
    const folder = qaCategory === '_root' ? '' : qaCategory + '/'
    const path = `${folder}${slug}.md`
    const body = `# ${qaTitle || 'Untitled'}\n\n${qaContent}\n`
    setQaSaving(true)
    try {
      await apiFetch('/api/memory/file', {
        method: 'PUT',
        body: JSON.stringify({ path, content: body }),
      })
      onToast('Created', 'success')
      setShowQuickAdd(false)
      setQaTitle('')
      setQaContent('')
      loadFiles()
      loadGraph()
    } catch {
      onToast('Create failed', 'error')
    } finally {
      setQaSaving(false)
    }
  }, [qaTitle, qaContent, qaCategory, onToast, loadFiles, loadGraph])

  // ── Search: highlight (not filter) ──
  const refreshGraphNodeAppearance = useCallback(() => {
    const g = graphInstanceRef.current
    if (!g) return
    const matched = highlightedIdsRef.current
    const isActive = matched.size > 0
    const nodes = g.graphData().nodes as any[]
    for (const n of nodes) {
      const obj = n.__threeObj
      if (!obj) continue
      const isMatch = isActive && matched.has(n.id)
      obj.traverse((o: any) => {
        if (o.isSprite && o.material) {
          o.material.opacity = isActive && !isMatch ? 0.04 : (isMatch ? 0.9 : 0.5)
          const baseScale = (3 + (n.links || 0) * 0.6) * (isMatch ? 4 : 2.5)
          o.scale.set(baseScale, baseScale, 1)
        }
        if (o.isMesh && o.material) {
          o.material.opacity = isActive && !isMatch ? 0.1 : 0.92
          o.material.transparent = true
          if (!o.userData.origColor) {
            o.userData.origColor = o.material.color?.clone?.()
          }
          if (isMatch) {
            o.material.color?.set?.('#ffffff')
          } else if (o.userData.origColor) {
            o.material.color?.copy?.(o.userData.origColor)
          }
        }
      })
    }
    g.refresh?.()
  }, [])

  const applyGraphHighlight = useCallback((results: MemSearchResults) => {
    const matchedFiles = new Set<string>()
    ;(results.docs || []).forEach((d) => {
      if (d.metadata?.path) matchedFiles.add(relPathFromAny(d.metadata.path))
      if (d.metadata?.file) matchedFiles.add(d.metadata.file)
    })
    highlightedIdsRef.current = matchedFiles
    refreshGraphNodeAppearance()
  }, [refreshGraphNodeAppearance])

  const clearGraphHighlight = useCallback(() => {
    highlightedIdsRef.current = new Set()
    refreshGraphNodeAppearance()
  }, [refreshGraphNodeAppearance])

  const runSearch = useCallback(async (val: string) => {
    if (!val.trim()) {
      setSearchResults({})
      clearGraphHighlight()
      return
    }
    setSearching(true)
    try {
      const scopeParam = memScope ? `&scope=${encodeURIComponent(memScope)}` : ''
      const data = await apiFetch<MemSearchResults>(`/api/memory/search?q=${encodeURIComponent(val)}${scopeParam}`)
      setSearchResults(data)
      applyGraphHighlight(data)
      if (data.partial?.length) {
        onToast(`Partial results — ${data.partial.join(' + ')} timed out`, 'info')
      }
    } catch {
      onToast('Search failed', 'error')
    } finally {
      setSearching(false)
    }
  }, [memScope, onToast, applyGraphHighlight, clearGraphHighlight])

  const onSearchInput = useCallback((val: string) => {
    setMemQuery(val)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => runSearch(val), 400)
  }, [runSearch])

  // ── 3D Graph setup ──
  const initGraph = useCallback(() => {
    const container = graphContainerRef.current
    if (!container) return

    import('3d-force-graph').then(({ default: ForceGraph3D }) => {
      if (graphInstanceRef.current) {
        graphInstanceRef.current._destructor?.()
        graphInstanceRef.current = null
      }
      container.innerHTML = ''

      const graph = (ForceGraph3D as any)({ controlType: 'orbit', alpha: true })(container)
        .backgroundColor('rgba(0,0,0,0)')
        .nodeRelSize(2)
        .nodeVal((n: any) => 1.5 + (n.links || 0) * 1)
        .nodeColor((n: any) => {
          const hovered = hoveredNodeRef.current
          const highlighted = highlightedIdsRef.current
          const isHighlightedActive = highlighted.size > 0
          const isMatch = isHighlightedActive && highlighted.has(n.id)
          if (isHighlightedActive && !isMatch) return 'rgba(80,80,90,0.3)'
          if (hovered) {
            if (n.id === hovered.id) return '#ffffff'
            const edges = fullGraphDataRef.current.edges
            const isNeighbor = edges.some((e) => {
              const src = typeof e.source === 'string' ? e.source : (e.source as GraphNode).id
              const tgt = typeof e.target === 'string' ? e.target : (e.target as GraphNode).id
              return (src === hovered.id && tgt === n.id) || (tgt === hovered.id && src === n.id)
            })
            if (!isNeighbor) return 'rgba(100,100,100,0.3)'
          }
          return GRAPH_COLORS[n.category] || '#94a3b8'
        })
        .nodeOpacity(0.92)
        .nodeLabel((n: any) => {
          const links = n.links || 0
          const sizeStr = n.size > 1024 ? `${(n.size / 1024).toFixed(1)}K` : `${n.size || 0}B`
          return `<div style="background:rgba(15,15,20,0.92);padding:6px 10px;border-radius:6px;font-size:11px;line-height:1.4;border:1px solid rgba(255,255,255,0.08);max-width:240px">
            <div style="font-weight:600;color:#e2e8f0;margin-bottom:2px">${escHtml(n.label || n.id)}</div>
            <div style="color:${GRAPH_COLORS[n.category] || '#94a3b8'};font-size:10px">${escHtml(n.category || 'unknown')}</div>
            <div style="color:#94a3b8;font-size:10px;margin-top:2px">${sizeStr} &middot; ${links} link${links !== 1 ? 's' : ''}</div>
          </div>`
        })
        .nodeThreeObject((n: any) => {
          const group = new THREE.Group()
          const canvas = document.createElement('canvas')
          canvas.width = 64
          canvas.height = 64
          const ctx = canvas.getContext('2d')!
          const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
          gradient.addColorStop(0, 'rgba(255,255,255,1)')
          gradient.addColorStop(1, 'rgba(255,255,255,0)')
          ctx.fillStyle = gradient
          ctx.fillRect(0, 0, 64, 64)

          const texture = new THREE.CanvasTexture(canvas)
          const highlighted = highlightedIdsRef.current
          const isHighlightedActive = highlighted.size > 0
          const isMatch = isHighlightedActive && highlighted.has(n.id)
          const material = new THREE.SpriteMaterial({
            map: texture,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            depthTest: false,
            opacity: isHighlightedActive && !isMatch ? 0.08 : 0.5,
            color: new THREE.Color(GRAPH_COLORS[n.category] || '#94a3b8'),
          })
          const sprite = new THREE.Sprite(material)
          const scale = (3 + (n.links || 0) * 0.6) * (isMatch ? 3.5 : 2.5)
          sprite.scale.set(scale, scale, 1)
          group.add(sprite)
          return group
        })
        .nodeThreeObjectExtend(true)
        .linkWidth((link: any) => {
          const hovered = hoveredNodeRef.current
          if (!hovered) return 0.4
          const src = typeof link.source === 'object' ? (link.source as GraphNode).id : link.source
          const tgt = typeof link.target === 'object' ? (link.target as GraphNode).id : link.target
          return src === hovered.id || tgt === hovered.id ? 1.4 : 0.2
        })
        .linkOpacity(0.18)
        .linkColor((link: any) => {
          const hovered = hoveredNodeRef.current
          const src = typeof link.source === 'object' ? link.source as GraphNode : null
          const srcId = src?.id ?? link.source
          const tgtId = typeof link.target === 'object' ? (link.target as GraphNode).id : link.target
          if (hovered) {
            const isConn = srcId === hovered.id || tgtId === hovered.id
            if (isConn) return GRAPH_COLORS[(src?.category) || ''] || 'rgba(255,255,255,0.85)'
            return 'rgba(255,255,255,0.04)'
          }
          return 'rgba(255,255,255,0.45)'
        })
        .linkDirectionalParticles((link: any) => {
          const hovered = hoveredNodeRef.current
          if (!hovered) return 2
          const src = typeof link.source === 'object' ? (link.source as GraphNode).id : link.source
          const tgt = typeof link.target === 'object' ? (link.target as GraphNode).id : link.target
          return src === hovered.id || tgt === hovered.id ? 4 : 0
        })
        .linkDirectionalParticleWidth(1.2)
        .linkDirectionalParticleSpeed(0.005)
        .linkDirectionalParticleColor((link: any) => {
          const src = typeof link.source === 'object' ? link.source : null
          return src ? (GRAPH_COLORS[src.category] || '#94a3b8') : '#94a3b8'
        })
        .d3AlphaDecay(0.02)
        .d3VelocityDecay(0.3)
        .warmupTicks(100)

      graph.d3Force('charge')?.strength(-150).distanceMax(500)
      graph.d3Force('link')?.distance(60).strength(0.08)

      const catCenters: Record<string, { x: number; y: number; z: number }> = {}
      const catKeys = Object.keys(GRAPH_COLORS)
      catKeys.forEach((cat, i) => {
        const angle = (i / catKeys.length) * Math.PI * 2
        catCenters[cat] = {
          x: Math.cos(angle) * 100,
          y: Math.sin(angle) * 100,
          z: (Math.random() - 0.5) * 50,
        }
      })
      graph.d3Force('cluster', (alpha: number) => {
        const nodes = graph.graphData().nodes as GraphNode[]
        nodes.forEach((n: any) => {
          const center = catCenters[n.category] || { x: 0, y: 0, z: 0 }
          const k = alpha * 0.3
          n.vx = (n.vx || 0) + (center.x - (n.x || 0)) * k
          n.vy = (n.vy || 0) + (center.y - (n.y || 0)) * k
          n.vz = (n.vz || 0) + (center.z - (n.z || 0)) * k
        })
      })

      const style = document.createElement('style')
      style.textContent = `.scene-nav-info { display: none !important; } .scene-container { position: absolute !important; inset: 0 !important; } .scene-container canvas { position: absolute !important; z-index: -1 !important; }`
      document.head.appendChild(style)
      setTimeout(() => {
        const c = container.querySelector('canvas')
        if (c) { c.style.zIndex = '-1'; c.style.position = 'absolute' }
        const sc = container.querySelector('.scene-container') as HTMLElement
        if (sc) { sc.style.position = 'absolute'; sc.style.inset = '0'; sc.style.zIndex = '0'; sc.style.overflow = 'hidden' }
      }, 100)

      const graphParent = container.parentElement
      if (graphParent) {
        graph.width(graphParent.clientWidth).height(graphParent.clientHeight)
        const ro2 = new ResizeObserver(() => {
          graph.width(graphParent.clientWidth).height(graphParent.clientHeight)
        })
        ro2.observe(graphParent)
      }

      graph.onNodeHover((node: any) => {
        setHoveredNode(node || null)
        if (container) container.style.cursor = node ? 'pointer' : 'default'
        // Trigger redraw of colors/links so neighbour highlight applies
        const g: any = graph
        g.nodeColor(g.nodeColor())
        g.linkColor(g.linkColor())
        g.linkWidth(g.linkWidth())
        g.linkDirectionalParticles(g.linkDirectionalParticles())
      })

      graph.onNodeClick((node: any) => {
        if (!node) return
        const distance = 120
        const distRatio = 1 + distance / Math.hypot(node.x || 0, node.y || 0, node.z || 0)
        graph.cameraPosition(
          { x: (node.x || 0) * distRatio, y: (node.y || 0) * distRatio, z: (node.z || 0) * distRatio },
          node,
          600,
        )
        if (node.id || node.label) {
          const match = filesRef.current.find((f) => f.path === node.id || f.name === node.label || f.path.endsWith(node.label))
          if (match) selectFile(match.path)
        }
      })

      graphInstanceRef.current = graph

      if (fullGraphDataRef.current.nodes.length) {
        graph.graphData({
          nodes: fullGraphDataRef.current.nodes,
          links: fullGraphDataRef.current.edges,
        })
      }

      setTimeout(() => {
        graph.cameraPosition({ x: 0, y: 40, z: 500 }, { x: 0, y: 0, z: 0 }, 800)
      }, 500)
    })
  }, [selectFile])

  // ── Resize observer for graph ──
  useEffect(() => {
    const container = graphContainerRef.current
    const parent = container?.parentElement
    if (!parent) return

    const doResize = () => {
      if (graphInstanceRef.current && parent) {
        const { width, height } = parent.getBoundingClientRect()
        if (width > 0 && height > 0) {
          graphInstanceRef.current.width(width)
          graphInstanceRef.current.height(height)
        }
      }
    }

    resizeObserverRef.current = new ResizeObserver(doResize)
    resizeObserverRef.current.observe(parent)
    setTimeout(doResize, 200)
    setTimeout(doResize, 1000)

    return () => {
      resizeObserverRef.current?.disconnect()
    }
  }, [viewMode])

  // ── Initial data load ──
  useEffect(() => {
    loadStats()
    loadFiles()
    loadMemories()
    loadGraph()
    loadScopeHelp()
    loadDoctor()
  }, [loadStats, loadFiles, loadMemories, loadGraph, loadScopeHelp, loadDoctor])

  useEffect(() => {
    loadMemories()
  }, [loadMemories])

  // ── Init graph only when graph view is active ──
  useEffect(() => {
    if (viewMode !== 'graph') return
    if (graphNodes.length || graphEdges.length) {
      if (!graphInstanceRef.current) {
        initGraph()
      } else {
        graphInstanceRef.current.graphData({
          nodes: graphNodes,
          links: graphEdges,
        })
      }
    }
  }, [graphNodes, graphEdges, initGraph, viewMode])

  // ── Scope chip also filters the graph (runs after graph init/data resets) ──
  useEffect(() => {
    if (viewMode !== 'graph') return
    const g = graphInstanceRef.current
    if (!g) return
    const { nodes, edges } = fullGraphDataRef.current
    if (!nodes.length || !memScope) return
    // small delay to win the race against the init useEffect that resets to full data
    const t = setTimeout(() => {
      const visibleIds = new Set(filteredFiles.map((f) => f.path))
      const visNodes = nodes.filter((n) => visibleIds.has(n.id))
      const visEdges = edges.filter((e) => {
        const s = typeof e.source === 'string' ? e.source : (e.source as GraphNode).id
        const t = typeof e.target === 'string' ? e.target : (e.target as GraphNode).id
        return visibleIds.has(s) && visibleIds.has(t)
      })
      g.graphData({ nodes: visNodes, links: visEdges })
    }, 50)
    return () => clearTimeout(t)
  }, [memScope, filteredFiles, graphNodes, graphEdges, viewMode])

  // ── Cleanup graph when switching away ──
  useEffect(() => {
    if (viewMode !== 'graph' && graphInstanceRef.current) {
      graphInstanceRef.current._destructor?.()
      graphInstanceRef.current = null
      const c = graphContainerRef.current
      if (c) c.innerHTML = ''
    }
  }, [viewMode])

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === '/') { e.preventDefault(); (document.querySelector('[data-memsearch]') as HTMLInputElement)?.focus() }
      else if (e.key === 'g') setViewMode('graph')
      else if (e.key === 'l') setViewMode('list')
      else if (e.key === 'r') setViewMode('grid')
      else if (e.key === 'Escape') { setShowQuickAdd(false); setMemQuery(''); runSearch('') }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runSearch])

  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
      if (graphInstanceRef.current) {
        graphInstanceRef.current._destructor?.()
        graphInstanceRef.current = null
      }
    }
  }, [])

  // ── Shared components ──
  const Chip = ({ active, onClick, label, color }: { active: boolean; onClick: () => void; label: string; color?: string }) => (
    <button
      onClick={onClick}
      style={{
        padding: '3px 10px',
        fontSize: 11,
        borderRadius: 999,
        border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
        background: active ? 'rgba(94,106,210,0.18)' : 'transparent',
        color: active ? 'var(--text-1)' : 'var(--text-3)',
        cursor: 'pointer',
        whiteSpace: 'nowrap' as const,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
      }}
    >
      {color && <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />}
      {label}
    </button>
  )

  const ViewBtn = ({ mode, label, shortcut }: { mode: ViewMode; label: string; shortcut: string }) => (
    <button
      onClick={() => setViewMode(mode)}
      title={`${label} view (${shortcut})`}
      style={{
        padding: '5px 12px',
        fontSize: 11,
        background: viewMode === mode ? 'var(--accent-tint-strong)' : 'transparent',
        color: viewMode === mode ? 'var(--accent-bright)' : 'var(--text-3)',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        fontWeight: viewMode === mode ? 600 : 500,
        transition: 'background 0.15s, color 0.15s',
      }}
    >
      {label}
    </button>
  )

  // ── Render ──
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Top bar */}
      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          padding: '16px 24px 8px',
          flexShrink: 0,
          position: 'relative' as const,
          zIndex: 10,
        }}
      >
        <h1
          className="page-title"
          style={{ marginBottom: 0, marginRight: 6, fontSize: 18 }}
        >
          Memory
        </h1>
        <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center' }}>
          <span style={{ position: 'absolute', left: 10, color: 'var(--text-4)', pointerEvents: 'none', display: 'inline-flex' }}><Search size={13} /></span>
          <input
            type="text"
            data-memsearch
            value={memQuery}
            onChange={(e) => onSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch(memQuery)
              if (e.key === 'Escape') { setMemQuery(''); runSearch('') }
            }}
            placeholder="Search memory…  ( / )"
            style={{
              flex: 1,
              width: '100%',
              padding: '7px 60px 7px 28px',
              fontSize: 12,
              background: 'var(--bg-3)',
              border: '1px solid ' + (memQuery ? 'var(--border-focus)' : 'var(--border-strong)'),
              borderRadius: 'var(--radius)',
              color: 'var(--text-1)',
              outline: 'none',
              transition: 'border-color 0.15s',
            }}
          />
          {searching && (
            <span
              aria-label="searching"
              style={{
                position: 'absolute',
                right: memQuery ? 30 : 10,
                width: 12,
                height: 12,
                border: '2px solid var(--border-strong)',
                borderTopColor: 'var(--accent-bright)',
                borderRadius: '50%',
                animation: 'spin 0.7s linear infinite',
              }}
            />
          )}
          {memQuery && !searching && (
            <button
              onClick={() => { setMemQuery(''); runSearch('') }}
              title="Clear search (Esc)"
              aria-label="Clear search"
              style={{
                position: 'absolute',
                right: 6,
                width: 20,
                height: 20,
                padding: 0,
                background: 'var(--surface-hover-strong)',
                color: 'var(--text-3)',
                border: 'none',
                borderRadius: '50%',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <X size={12} />
            </button>
          )}
          {memQuery && !searching && hasSearchResults && (
            <span style={{ position: 'absolute', right: 32, fontSize: 10, color: 'var(--text-4)', fontFamily: 'var(--mono)' }}>
              {(searchResults.docs?.length || 0) + (searchResults.memories?.length || 0)}
            </span>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            gap: 2,
            background: 'var(--bg-0)',
            borderRadius: 'var(--radius)',
            padding: 2,
            border: '1px solid var(--border)',
          }}
        >
          <ViewBtn mode="graph" label="Graph" shortcut="g" />
          <ViewBtn mode="list" label="List" shortcut="l" />
          <ViewBtn mode="grid" label="Grid" shortcut="r" />
        </div>
        <button
          onClick={() => setShowQuickAdd(true)}
          title="Create new note"
          style={{
            padding: '7px 14px',
            fontSize: 12,
            background: 'var(--accent)',
            color: '#fff',
            border: '1px solid var(--accent)',
            borderRadius: 'var(--radius)',
            cursor: 'pointer',
            fontWeight: 500,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            lineHeight: 1,
          }}
        >
          <span style={{ fontSize: 14, lineHeight: 1 }}>+</span> New
        </button>
        <KebabMenu reindexing={reindexing} onReindex={reindex} onManageScopes={() => setScopesPanelOpen(true)} />
      </div>
      {memQuery && !searching && !hasSearchResults && (
        <div style={{ padding: '4px 20px 0', fontSize: 11, color: 'var(--text-4)', flexShrink: 0 }}>
          No matches for <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-2)' }}>"{memQuery}"</span>. Try a different term or check Reindex.
        </div>
      )}
      {doctor && doctor.issueCount > 0 && !doctorDismissed && (
        <DoctorBanner
          doctor={doctor}
          open={doctorOpen}
          setOpen={setDoctorOpen}
          onDismiss={() => {
            setDoctorDismissed(true)
            try { sessionStorage.setItem('memory:doctorDismissed', '1') } catch { /* ignore */ }
          }}
          onFileClick={(p) => selectFile(p)}
        />
      )}

      {/* Scope chips */}
      <div style={{ display: 'flex', gap: 4, padding: '4px 20px 10px', flexShrink: 0, overflowX: 'auto', position: 'relative' as const, zIndex: 10 }}>
        <Chip active={!memScope} onClick={() => setMemScope('')} label={`All (${files.length})`} />
        {scopeChips.map((c) => (
          <Chip
            key={c.id}
            active={memScope === c.id}
            onClick={() => setMemScope(c.id)}
            label={`${c.id === '_root' ? 'logs' : c.id} (${c.count})`}
            color={c.color}
          />
        ))}
        {Object.keys(scopeHelp).filter(s => s && !scopeChips.find(c => c.id === s)).slice(0, 6).map((s) => (
          <Chip key={s} active={memScope === s} onClick={() => setMemScope(s)} label={s} />
        ))}
      </div>

      {/* Main area — varies by viewMode */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' }}>
        {viewMode === 'graph' && (
          <>
            <div style={{ width: selectedFile || hasSearchResults ? 'calc(100% - 361px)' : '100%', position: 'relative', overflow: 'hidden' }}>
              <div ref={graphContainerRef} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
                {loadingGraph && (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontSize: 12, zIndex: 5 }}>
                    Loading graph…
                  </div>
                )}
              </div>
              {/* Graph stats + controls + reindex (left) */}
              <div style={{ position: 'absolute', bottom: 12, left: 12, display: 'flex', gap: 8, alignItems: 'center', zIndex: 10, background: 'rgba(15,16,17,0.78)', backdropFilter: 'blur(8px)', padding: '7px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
                <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>{graphStats}</span>
                <button onClick={loadGraph} disabled={loadingGraph} title="Refresh graph data" style={{ padding: '3px 10px', fontSize: 11, background: 'rgba(255,255,255,0.06)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}>Reload</button>
              </div>
              {/* Help / shortcuts toggle (bottom-right) */}
              <GraphHelpPanel />
            </div>
            {(selectedFile || hasSearchResults) && (
              <Sidebar
                files={filteredFiles}
                filesByCategory={filesByCategory}
                selectedFile={selectedFile}
                fileContent={fileContent}
                editorMode={editorMode}
                setEditorMode={setEditorMode}
                savingFile={savingFile}
                saveFile={saveFile}
                setFileContent={setFileContent}
                deleteFile={deleteFile}
                onSelectFile={selectFile}
                hasSearchResults={hasSearchResults}
                searchResults={searchResults}
                searching={searching}
                memQuery={memQuery}
                openDocFromSearch={openDocFromSearch}
                browseView={browseView}
                setBrowseView={setBrowseView}
                filteredMems={filteredMems}
                memsUsers={memsUsers}
                memsUserFilter={memsUserFilter}
                setMemsUserFilter={setMemsUserFilter}
                memsSort={memsSort}
                setMemsSort={setMemsSort}
                deleteMem={deleteMem}
                related={related}
              />
            )}
          </>
        )}

        {viewMode === 'list' && (
          <ListView
            filesByCategory={filesByCategory}
            selectedFile={selectedFile}
            onSelectFile={selectFile}
            fileContent={fileContent}
            editorMode={editorMode}
            setEditorMode={setEditorMode}
            savingFile={savingFile}
            saveFile={saveFile}
            setFileContent={setFileContent}
            deleteFile={deleteFile}
            memQuery={memQuery}
            searchResults={searchResults}
            hasSearchResults={hasSearchResults}
            related={related}
          />
        )}

        {viewMode === 'grid' && (
          <GridView
            files={sortedGridFiles}
            memQuery={memQuery}
            selectedFile={selectedFile}
            onSelectFile={selectFile}
            fileContent={fileContent}
            editorMode={editorMode}
            setEditorMode={setEditorMode}
            savingFile={savingFile}
            saveFile={saveFile}
            setFileContent={setFileContent}
            deleteFile={deleteFile}
            related={related}
          />
        )}
      </div>

      {/* Quick add modal */}
      {showQuickAdd && (
        <div
          onClick={(e) => e.target === e.currentTarget && setShowQuickAdd(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
        >
          <div style={{ width: 520, background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 10, padding: 20, boxShadow: '0 12px 40px rgba(0,0,0,0.4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-1)' }}>New memory</div>
              <button onClick={() => setShowQuickAdd(false)} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--text-4)', cursor: 'pointer', display: 'inline-flex', padding: 4 }}><X size={14} /></button>
            </div>
            <input
              type="text"
              value={qaTitle}
              onChange={(e) => setQaTitle(e.target.value)}
              placeholder="Title…"
              autoFocus
              style={{ width: '100%', padding: '8px 10px', fontSize: 13, background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-1)', outline: 'none', marginBottom: 8 }}
            />
            <textarea
              value={qaContent}
              onChange={(e) => setQaContent(e.target.value)}
              placeholder="Content (markdown supported)…"
              rows={8}
              style={{ width: '100%', padding: 10, fontSize: 12, fontFamily: 'var(--mono)', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-2)', outline: 'none', resize: 'vertical', marginBottom: 10 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--text-4)' }}>Save to:</span>
              <select value={qaCategory} onChange={(e) => setQaCategory(e.target.value)} style={{ padding: '4px 8px', fontSize: 11, background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-2)' }}>
                <option value="_root">daily logs</option>
                <option value="people">people</option>
                <option value="projects">projects</option>
                <option value="procedures">procedures</option>
                <option value="tools">tools</option>
                <option value="reviews">reviews</option>
              </select>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button onClick={() => setShowQuickAdd(false)} style={{ padding: '6px 14px', fontSize: 11, background: 'transparent', color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' }}>Cancel</button>
                <button onClick={saveQuickAdd} disabled={qaSaving || !qaTitle.trim()} style={{ padding: '6px 14px', fontSize: 11, background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', opacity: qaSaving || !qaTitle.trim() ? 0.6 : 1 }}>
                  {qaSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Scopes management */}
      <Panel open={scopesPanelOpen} title="Memory scopes" onClose={() => setScopesPanelOpen(false)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.55 }}>
            Scopes organize memory entries by topic (people, projects, procedures…). Each scope is a folder under{' '}
            <code style={{ background: 'var(--bg-0)', padding: '1px 5px', borderRadius: 'var(--radius-xs)', fontFamily: 'var(--mono)', fontSize: 11 }}>~/.claude/jarvis/memory/</code>.
          </div>

          <div>
            <SectionHeader title="Active scopes" count={Object.keys(scopeHelp).filter((k) => k).length} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {Object.entries(scopeHelp).filter(([k]) => k).map(([scope, desc]) => (
                <div
                  key={scope}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '8px 12px',
                    fontSize: 12,
                    background: 'var(--bg-0)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                  }}
                >
                  <span style={{ fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--text-1)', minWidth: 90 }}>{scope}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>{desc as string}</span>
                </div>
              ))}
              {Object.keys(scopeHelp).filter((k) => k).length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-4)', padding: 8 }}>No scopes defined yet.</div>
              )}
            </div>
          </div>

          <div>
            <SectionHeader title="Add scope" />
            <Field hint="Lowercase, no spaces. Creates a folder and adds it to the memory index.">
              <div style={{ display: 'flex', gap: 8 }}>
                <Input
                  value={newMemScope}
                  onChange={(e) => setNewMemScope(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addMemScope()}
                  placeholder="scope-name"
                  style={{ flex: 1 }}
                />
                <Button
                  variant="primary"
                  size="md"
                  onClick={addMemScope}
                  loading={addingScope}
                  disabled={!newMemScope.trim()}
                >
                  Add
                </Button>
              </div>
            </Field>
          </div>
        </div>
      </Panel>
    </div>
  )
}

// ── Sub-components ──

interface FilePaneProps {
  selectedFile: string | null
  fileContent: string
  editorMode: 'preview' | 'edit'
  setEditorMode: (m: 'preview' | 'edit') => void
  savingFile: boolean
  saveFile: () => void
  setFileContent: (s: string) => void
  deleteFile: (p: string) => void
  related: MemSearchDoc[]
}

function FilePane({ selectedFile, fileContent, editorMode, setEditorMode, savingFile, saveFile, setFileContent, deleteFile, related }: FilePaneProps) {
  if (!selectedFile) return null
  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: 12, flex: 1, overflowY: 'auto', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedFile}</span>
        <button onClick={() => setEditorMode(editorMode === 'edit' ? 'preview' : 'edit')} style={{ fontSize: 9, padding: '2px 6px', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-3)', cursor: 'pointer' }}>
          {editorMode === 'edit' ? 'Preview' : 'Edit'}
        </button>
        {editorMode === 'edit' && (
          <button onClick={saveFile} disabled={savingFile} style={{ fontSize: 9, padding: '2px 6px', background: 'var(--accent)', border: 'none', borderRadius: 3, color: 'white', cursor: 'pointer' }}>
            {savingFile ? '…' : 'Save'}
          </button>
        )}
        <button onClick={() => deleteFile(selectedFile)} style={{ fontSize: 9, padding: '2px 6px', background: 'none', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--err)', cursor: 'pointer' }}>Del</button>
      </div>
      {editorMode === 'edit' ? (
        <textarea value={fileContent} onChange={(e) => setFileContent(e.target.value)} style={{ width: '100%', minHeight: 200, fontSize: 11, background: 'var(--bg-0)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-2)', padding: 8, resize: 'vertical', fontFamily: 'var(--mono)' }} />
      ) : (
        <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5, whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)' }}>{fileContent}</div>
      )}
      {related.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: 10, color: 'var(--text-4)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Related</div>
          {related.map((r, i) => (
            <div key={i} style={{ padding: '4px 6px', marginBottom: 2, background: 'var(--bg-2)', borderRadius: 4, fontSize: 10, display: 'flex', gap: 6 }}>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)', fontWeight: 600 }}>{(r.score || 0).toFixed(2)}</span>
              <span style={{ color: 'var(--text-3)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {(r.metadata?.path || r.metadata?.file || '').split('/').pop()?.replace('.md', '') || ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface SidebarProps extends FilePaneProps {
  files: MemFile[]
  filesByCategory: Record<string, MemFile[]>
  onSelectFile: (p: string) => void
  hasSearchResults: boolean
  searchResults: MemSearchResults
  searching: boolean
  memQuery: string
  openDocFromSearch: (p?: string) => void
  browseView: 'documents' | 'facts'
  setBrowseView: (v: 'documents' | 'facts') => void
  filteredMems: MemMemory[]
  memsUsers: string[]
  memsUserFilter: string
  setMemsUserFilter: (v: string) => void
  memsSort: string
  setMemsSort: (v: string) => void
  deleteMem: (id: string) => void
}

function Sidebar(props: SidebarProps) {
  const { filesByCategory, selectedFile, onSelectFile, hasSearchResults, searchResults, searching, memQuery, openDocFromSearch, browseView, setBrowseView, filteredMems, memsUsers, memsUserFilter, setMemsUserFilter, memsSort, setMemsSort, deleteMem, files } = props
  return (
    <div style={{ width: 360, flexShrink: 0, borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-1)', position: 'relative', zIndex: 10 }}>
      <div style={{ display: 'flex', gap: 2, padding: '8px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <button onClick={() => setBrowseView('documents')} style={{ flex: 1, padding: '4px 8px', fontSize: 11, background: browseView === 'documents' ? 'rgba(94,106,210,0.15)' : 'transparent', color: browseView === 'documents' ? 'var(--text-1)' : 'var(--text-4)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}>
          Docs ({files.length})
        </button>
        <button onClick={() => setBrowseView('facts')} style={{ flex: 1, padding: '4px 8px', fontSize: 11, background: browseView === 'facts' ? 'rgba(94,106,210,0.15)' : 'transparent', color: browseView === 'facts' ? 'var(--text-1)' : 'var(--text-4)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' }}>
          Facts ({filteredMems.length})
        </button>
      </div>

      {searching && (
        <div style={{ padding: 12 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{ background: 'var(--bg-2)', borderRadius: 4, padding: 8, marginBottom: 4 }}>
              <div style={{ width: 60 + i * 20, height: 10, background: 'rgba(255,255,255,0.06)', borderRadius: 3 }} />
            </div>
          ))}
        </div>
      )}
      {!searching && hasSearchResults && (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', maxHeight: 220, overflowY: 'auto', flexShrink: 0 }}>
          <div style={{ fontSize: 10, color: 'var(--text-4)', marginBottom: 4 }}>
            {(searchResults.docs?.length || 0)} docs + {(searchResults.memories?.length || 0)} facts
          </div>
          {(searchResults.docs || []).slice(0, 5).map((d, idx) => (
            <div key={d.metadata?.path || d.metadata?.file || idx} onClick={() => openDocFromSearch(d.metadata?.path || d.metadata?.file)} style={{ padding: '4px 6px', marginBottom: 2, background: 'var(--bg-2)', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
              <span style={{ fontSize: 9, fontFamily: 'var(--mono)', padding: '0 4px', borderRadius: 2, background: 'rgba(94,106,210,0.15)', color: 'var(--accent)', fontWeight: 600 }}>{(d.score || 0).toFixed(2)}</span>
              <span style={{ color: 'var(--text-2)', marginLeft: 4 }}>{(d.metadata?.path || d.metadata?.file || '').split('/').pop()?.replace('.md', '') || ''}</span>
            </div>
          ))}
          {(searchResults.memories || []).slice(0, 3).map((m) => (
            <div key={m.id} style={{ padding: '4px 6px', marginBottom: 2, background: 'var(--bg-2)', borderRadius: 4, fontSize: 11 }}>
              <span style={{ fontSize: 9, fontFamily: 'var(--mono)', padding: '0 4px', borderRadius: 2, background: 'rgba(94,106,210,0.15)', color: 'var(--accent)', fontWeight: 600 }}>{(m.score || 0).toFixed(2)}</span>
              <span style={{ color: 'var(--text-4)', marginLeft: 4 }}>{m.user_id}</span>
              <div style={{ color: 'var(--text-3)', marginTop: 2, fontSize: 10 }} dangerouslySetInnerHTML={{ __html: highlightText(short(m.memory || '', 80), memQuery) }} />
            </div>
          ))}
        </div>
      )}

      {browseView === 'documents' && !hasSearchResults && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
          {Object.keys(filesByCategory).sort().map((cat) => (
            <div key={cat} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 2 }}>
                {cat === '_root' ? 'daily logs' : cat} ({filesByCategory[cat].length})
              </div>
              {filesByCategory[cat].map((f) => (
                <div key={f.path} onClick={() => onSelectFile(f.path)} style={{ padding: '3px 6px', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, borderRadius: 4, background: selectedFile === f.path ? 'rgba(94,106,210,0.15)' : 'transparent', color: selectedFile === f.path ? 'var(--text-1)' : 'var(--text-3)' }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(f.title || f.name).replace(/\.md$/, '')}</span>
                  <span style={{ fontSize: 9, color: 'var(--text-4)', flexShrink: 0 }}>{f.size > 1024 ? (f.size / 1024).toFixed(0) + 'K' : f.size + 'B'}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {browseView === 'facts' && !hasSearchResults && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
            <select value={memsUserFilter} onChange={(e) => setMemsUserFilter(e.target.value)} style={{ fontSize: 10, padding: '2px 4px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-2)' }}>
              <option value="">All agents</option>
              {memsUsers.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
            <select value={memsSort} onChange={(e) => setMemsSort(e.target.value)} style={{ fontSize: 10, padding: '2px 4px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-2)' }}>
              <option value="date-desc">Newest</option>
              <option value="date-asc">Oldest</option>
              <option value="user">By agent</option>
            </select>
          </div>
          {filteredMems.map((m) => (
            <div key={m.id} style={{ padding: '6px 8px', marginBottom: 4, background: 'var(--bg-2)', borderRadius: 4, border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                <span style={{ fontSize: 10, color: 'var(--accent)' }}>{m.user_id || 'unknown'}</span>
                <span style={{ fontSize: 9, color: 'var(--text-4)' }}>{formatMemDate(m.created_at)}</span>
                <button onClick={() => deleteMem(m.id)} aria-label="Delete memory" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-4)', cursor: 'pointer', display: 'inline-flex', padding: 2 }}><X size={12} /></button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.4 }}>{short(m.memory || '', 150)}</div>
            </div>
          ))}
        </div>
      )}

      <FilePane
        selectedFile={props.selectedFile}
        fileContent={props.fileContent}
        editorMode={props.editorMode}
        setEditorMode={props.setEditorMode}
        savingFile={props.savingFile}
        saveFile={props.saveFile}
        setFileContent={props.setFileContent}
        deleteFile={props.deleteFile}
        related={props.related}
      />
    </div>
  )
}

interface ListViewProps extends FilePaneProps {
  filesByCategory: Record<string, MemFile[]>
  onSelectFile: (p: string) => void
  memQuery: string
  searchResults: MemSearchResults
  hasSearchResults: boolean
}

function ListView({ filesByCategory, selectedFile, onSelectFile, fileContent, editorMode, setEditorMode, savingFile, saveFile, setFileContent, deleteFile, memQuery, searchResults, hasSearchResults, related }: ListViewProps) {
  const cats = Object.keys(filesByCategory).sort()
  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
        {hasSearchResults && (
          <div style={{ marginBottom: 16, padding: 10, background: 'rgba(94,106,210,0.08)', borderRadius: 6, border: '1px solid rgba(94,106,210,0.2)' }}>
            <div style={{ fontSize: 10, color: 'var(--text-4)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Search results · {searchResults.docs?.length || 0} docs · {searchResults.memories?.length || 0} facts
            </div>
            {(searchResults.docs || []).slice(0, 8).map((d, idx) => (
              <div key={idx} onClick={() => onSelectFile(relPathFromAny(d.metadata?.path || d.metadata?.file || ''))} style={{ padding: '6px 8px', marginBottom: 2, background: 'var(--bg-2)', borderRadius: 4, cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--accent)', fontWeight: 600 }}>{(d.score || 0).toFixed(2)}</span>
                <span style={{ fontSize: 11, color: 'var(--text-2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(d.metadata?.path || d.metadata?.file || '').split('/').pop()?.replace('.md', '')}</span>
                <span style={{ fontSize: 10, color: 'var(--text-4)' }} dangerouslySetInnerHTML={{ __html: highlightText(short(d.text || '', 60), memQuery) }} />
              </div>
            ))}
          </div>
        )}
        {cats.map((cat) => (
          <div key={cat} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', marginBottom: 6, letterSpacing: 0.5 }}>
              {cat === '_root' ? 'daily logs' : cat} <span style={{ color: 'var(--text-4)', fontWeight: 400 }}>({filesByCategory[cat].length})</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 6 }}>
              {filesByCategory[cat].map((f) => (
                <div key={f.path} onClick={() => onSelectFile(f.path)} style={{ padding: '6px 10px', cursor: 'pointer', background: selectedFile === f.path ? 'rgba(94,106,210,0.15)' : 'var(--bg-2)', borderRadius: 4, border: '1px solid ' + (selectedFile === f.path ? 'rgba(94,106,210,0.4)' : 'transparent'), display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 12, color: selectedFile === f.path ? 'var(--text-1)' : 'var(--text-2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(f.title || f.name).replace(/\.md$/, '')}</span>
                  <span style={{ fontSize: 9, color: 'var(--text-4)' }}>{f.size > 1024 ? (f.size / 1024).toFixed(0) + 'K' : f.size + 'B'}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {selectedFile && (
        <div style={{ width: 420, flexShrink: 0, borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-1)' }}>
          <FilePane
            selectedFile={selectedFile}
            fileContent={fileContent}
            editorMode={editorMode}
            setEditorMode={setEditorMode}
            savingFile={savingFile}
            saveFile={saveFile}
            setFileContent={setFileContent}
            deleteFile={deleteFile}
            related={related}
          />
        </div>
      )}
    </div>
  )
}

interface GridViewProps extends FilePaneProps {
  files: MemFile[]
  memQuery: string
  onSelectFile: (p: string) => void
}

function DoctorBanner({ doctor, open, setOpen, onDismiss, onFileClick }: {
  doctor: MemDoctor
  open: boolean
  setOpen: (v: boolean) => void
  onDismiss: () => void
  onFileClick: (p: string) => void
}) {
  const rows: Array<{ label: string; items: string[]; desc: string }> = []
  if (doctor.duplicateNames.length) rows.push({
    label: `Duplicate names (${doctor.duplicateNames.length})`,
    desc: 'Same filename in multiple folders — wikilinks resolve ambiguously',
    items: doctor.duplicateNames.map((d) => `${d.name} → ${d.paths.join(', ')}`),
  })
  if (doctor.dailyCollisions.length) rows.push({
    label: `Daily log collisions (${doctor.dailyCollisions.length})`,
    desc: 'Same date present in both root and daily/ — different contents',
    items: doctor.dailyCollisions.map((d) => `${d.date}: ${d.paths.join(' vs ')}`),
  })
  if (doctor.orphans.length) rows.push({
    label: `Orphans (${doctor.orphans.length})`,
    desc: 'Files with no incoming/outgoing graph links',
    items: doctor.orphans,
  })
  if (doctor.tinyFiles.length) rows.push({
    label: `Tiny files (${doctor.tinyFiles.length})`,
    desc: 'Under 200 bytes — likely empty stubs',
    items: doctor.tinyFiles.map((t) => `${t.path} (${t.size}B)`),
  })
  return (
    <div style={{ margin: '4px 20px 0', flexShrink: 0, background: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.25)', borderRadius: 6, padding: '6px 10px', fontSize: 11, color: 'var(--text-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: '#eab308', fontSize: 13 }}>⚠</span>
        <span><b>{doctor.issueCount}</b> memory health issue{doctor.issueCount !== 1 ? 's' : ''} across {doctor.totalFiles} files</span>
        <button onClick={() => setOpen(!open)} style={{ marginLeft: 'auto', fontSize: 10, background: 'transparent', color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}>
          {open ? 'Hide' : 'Details'}
        </button>
        <button onClick={onDismiss} title="Dismiss for this session" aria-label="Dismiss" style={{ background: 'transparent', color: 'var(--text-4)', border: 'none', cursor: 'pointer', padding: 4, display: 'inline-flex' }}><X size={12} /></button>
      </div>
      {open && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(234,179,8,0.2)', display: 'grid', gap: 10, maxHeight: 260, overflowY: 'auto' }}>
          {rows.map((r) => (
            <div key={r.label}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 }}>{r.label}</div>
              <div style={{ fontSize: 10, color: 'var(--text-4)', marginBottom: 4 }}>{r.desc}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {r.items.slice(0, 10).map((it, i) => {
                  // Extract first plausible path for click (orphans / tiny / dup cases)
                  const firstPath = it.match(/[\w\-./]+\.md/)?.[0]
                  return (
                    <div key={i} onClick={firstPath ? () => onFileClick(firstPath) : undefined}
                      style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-3)', cursor: firstPath ? 'pointer' : 'default', padding: '1px 0' }}
                      onMouseEnter={(e) => { if (firstPath) e.currentTarget.style.color = 'var(--text-1)' }}
                      onMouseLeave={(e) => { if (firstPath) e.currentTarget.style.color = 'var(--text-3)' }}
                    >{it}</div>
                  )
                })}
                {r.items.length > 10 && (<div style={{ fontSize: 10, color: 'var(--text-4)' }}>+ {r.items.length - 10} more</div>)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function KebabMenu({
  reindexing,
  onReindex,
  onManageScopes,
}: {
  reindexing: boolean
  onReindex: () => void
  onManageScopes: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="More actions"
        style={{
          width: 32,
          height: 30,
          padding: 0,
          fontSize: 16,
          lineHeight: 1,
          background: 'transparent',
          color: 'var(--text-3)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius)',
          cursor: 'pointer',
        }}
      ><MoreHorizontal size={14} /></button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            background: 'var(--bg-2)',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            padding: 4,
            minWidth: 220,
            zIndex: 50,
          }}
        >
          <MenuItem
            icon={<RefreshCw size={13} />}
            title={reindexing ? 'Indexing…' : 'Reindex memory'}
            hint="Rebuild vector index in ChromaDB"
            disabled={reindexing}
            onClick={() => { onReindex(); setOpen(false) }}
          />
          <MenuItem
            icon={<Layers size={13} />}
            title="Manage scopes"
            hint="Add or review memory scopes"
            onClick={() => { onManageScopes(); setOpen(false) }}
          />
        </div>
      )}
    </div>
  )
}

function MenuItem({
  icon,
  title,
  hint,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  hint: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%',
        padding: '8px 10px',
        fontSize: 12,
        background: 'transparent',
        color: 'var(--text-2)',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        textAlign: 'left' as const,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = 'var(--surface-hover)' }}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, color: 'var(--text-3)' }}>{icon}</span>
      <div style={{ flex: 1 }}>
        <div>{title}</div>
        <div style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 1 }}>{hint}</div>
      </div>
    </button>
  )
}

function GraphHelpPanel() {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'absolute', bottom: 12, right: 12, zIndex: 10 }}>
      {open && (
        <div style={{ marginBottom: 6, background: 'rgba(15,16,17,0.92)', backdropFilter: 'blur(10px)', padding: '10px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.10)', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', alignItems: 'center', fontSize: 12, color: 'var(--text-2)', minWidth: 220 }}>
          <span style={{ fontWeight: 600, color: 'var(--text-3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, gridColumn: '1 / -1', marginBottom: 2 }}>Mouse</span>
          <kbd style={kbdStyle}>drag</kbd><span>orbit camera</span>
          <kbd style={kbdStyle}>scroll</kbd><span>zoom in / out</span>
          <kbd style={kbdStyle}>right-drag</kbd><span>pan view</span>
          <kbd style={kbdStyle}>hover</kbd><span>highlight neighbours</span>
          <kbd style={kbdStyle}>click</kbd><span>open document</span>
          <span style={{ fontWeight: 600, color: 'var(--text-3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, gridColumn: '1 / -1', marginTop: 6, marginBottom: 2, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6 }}>Keyboard</span>
          <kbd style={kbdStyle}>/</kbd><span>focus search</span>
          <kbd style={kbdStyle}>g / l / r</kbd><span>graph / list / grid</span>
          <kbd style={kbdStyle}>esc</kbd><span>clear search</span>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        title="Graph controls & shortcuts"
        style={{ width: 32, height: 32, borderRadius: '50%', background: open ? 'rgba(94,106,210,0.25)' : 'rgba(15,16,17,0.78)', backdropFilter: 'blur(8px)', border: '1px solid ' + (open ? 'rgba(94,106,210,0.5)' : 'rgba(255,255,255,0.10)'), color: 'var(--text-2)', cursor: 'pointer', fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(0,0,0,0.35)' }}
      >?</button>
    </div>
  )
}

function GridView({ files, memQuery, selectedFile, onSelectFile, fileContent, editorMode, setEditorMode, savingFile, saveFile, setFileContent, deleteFile, related }: GridViewProps) {
  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
          {files.map((f) => {
            const color = GRAPH_COLORS[f.category] || '#94a3b8'
            return (
              <div
                key={f.path}
                onClick={() => onSelectFile(f.path)}
                style={{
                  padding: 12,
                  background: selectedFile === f.path ? 'rgba(94,106,210,0.12)' : 'var(--bg-2)',
                  border: '1px solid ' + (selectedFile === f.path ? 'rgba(94,106,210,0.5)' : 'var(--border)'),
                  borderRadius: 6,
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  minHeight: 100,
                  transition: 'all 120ms ease',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
                  <span style={{ fontSize: 10, color: 'var(--text-4)', textTransform: 'uppercase', letterSpacing: 0.3 }}>{f.category === '_root' ? 'daily' : f.category}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--text-4)' }}>{formatFileDate(f.mtime)}</span>
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)', lineHeight: 1.3, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
                     dangerouslySetInnerHTML={{ __html: highlightText((f.title || f.name).replace(/\.md$/, ''), memQuery) }} />
                {f.preview && (
                  <div style={{ fontSize: 10, color: 'var(--text-3)', lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}
                       dangerouslySetInnerHTML={{ __html: highlightText(f.preview, memQuery) }} />
                )}
                <div style={{ marginTop: 'auto', fontSize: 9, color: 'var(--text-4)', display: 'flex', gap: 8 }}>
                  <span>{f.size > 1024 ? (f.size / 1024).toFixed(0) + 'K' : f.size + 'B'}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {selectedFile && (
        <div style={{ width: 420, flexShrink: 0, borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-1)' }}>
          <FilePane
            selectedFile={selectedFile}
            fileContent={fileContent}
            editorMode={editorMode}
            setEditorMode={setEditorMode}
            savingFile={savingFile}
            saveFile={saveFile}
            setFileContent={setFileContent}
            deleteFile={deleteFile}
            related={related}
          />
        </div>
      )}
    </div>
  )
}
