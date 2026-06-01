// Types

export interface Stats {
  totalMessages: number
  messagesByChannel: Record<string, number>
  uptimeMs: number
  uptime: string
  activeProcesses: number
}

export interface ServiceStatus {
  name: string
  port: number
  status: 'ok' | 'down'
  linkUrl?: string
}

export interface Route {
  channel: string
  match: string
  agent: string
  action?: string
  workspace?: string
  from?: string
  group?: string
  jid?: string
  use?: string
  [key: string]: unknown
}

export interface FullRoute {
  channel: string
  from: string
  fromLabel: string | null
  fromRawId: string
  group: string | null
  groupLabel: string | null
  groupRawId: string
  workspace: string
  fullWorkspace: string
  model: string
  fallbacks: string[]
  alwaysReply: boolean
  action: string
  claudeMdPreview: string
  claudeMdSize: number
  tools: string[]
  fullAccess: boolean
}

export interface AgentScope {
  soul: boolean
  agents: boolean
  tools: boolean
  user: boolean
  memory: boolean
  imports: string[]
}

export interface AgentFile {
  name: string
  size: number
}

export type Tier = 'owner' | 'team' | 'family' | 'personal' | 'client'

export interface ChannelScope {
  allowedGuilds?: string[]
  allowedChannels?: string[]
  denyChannels?: string[]
  allowedJids?: string[]
  denyJids?: string[]
  allowedChats?: string[]
  denyChats?: string[]
  allowCrossChatWrite?: boolean
}

export interface AgentRateLimit {
  maxMessages?: number
  windowSeconds?: number
}

export interface FullAgent {
  name: string
  workspace: string
  content: string
  size: number
  files: AgentFile[]
  scopes: AgentScope
  model: string | null
  effort: string | null
  fallbacks: string[]
  fullAccess: boolean
  tools: string[]
  inheritUserScope?: boolean
  tier: Tier
  rateLimit: AgentRateLimit | null
  channelScope: {
    discord: ChannelScope | null
    whatsapp: ChannelScope | null
    telegram: ChannelScope | null
  }
  routes: Array<{ index: number; channel: string; from: string; group: string | null; fullAccess: boolean }>
}

export interface AuditEntry {
  ts: string
  event: string
  actor: string
  agent?: string
  target?: string
  diff?: { added?: string[]; removed?: string[]; before?: unknown; after?: unknown }
  killedSessions?: number
  details?: Record<string, unknown>
  result?: 'ok' | 'denied' | 'error'
  reason?: string
}

export interface PermissionMatrix {
  agents: Array<{
    name: string
    tier: Tier
    fullAccess: boolean
    tools: string[]
    inheritUserScope: boolean
    model: string | null
    rateLimit: AgentRateLimit | null
    channelScope: { discord: ChannelScope | null; whatsapp: ChannelScope | null; telegram: ChannelScope | null }
  }>
  allTools: Array<{ id: string; type: string; label: string; icon: string | null; allowedFor: Tier[] }>
  tiers: Tier[]
  tierWhitelist: Record<Tier, string[]>
}

export interface Agent {
  name: string
  model?: string
  tools?: string[]
  routes?: string[]
  claudeMd?: string
  config?: Record<string, unknown>
  [key: string]: unknown
}

export interface Session {
  key: string
  model?: string
  workspace?: string
  uptime?: string
  messages?: number
  tokens?: number
  alive?: boolean
  createdAt?: number
  lastMessageAt?: number
  messageCount?: number
  estimatedTokens?: number
  [key: string]: unknown
}

export interface ProcessSession {
  key: string
  model: string
  workspace: string
  alive: boolean
  pid: number | null
  pending: boolean
  needsContext: boolean
  createdAt: number
  lastMessageAt: number
  inactivityExpiresAt: number
  lifetimeExpiresAt: number
  messageCount: number
  consecutiveTimeouts: number
  pendingFilesCount: number
  charsIn: number
  charsOut: number
  totalTimeMs: number
  avgResponseMs: number
  lastDurationMs: number
  lastApiDurationMs: number
  inputTokens: number
  outputTokens: number
  cacheCreation: number
  cacheRead: number
  costUsd: number
  estimatedTokens: number
  channel: string
  target: string
  targetLabel: string | null
  agentName: string | null
  agentModel: string | null
  fullAccess: boolean
  inheritUserScope: boolean
  uptime: number
  idleTime: number
  timeToInactivityTimeout: number
  timeToLifetimeTimeout: number
  totalInputTokens?: number
  compactionCount?: number
  nearContextLimit?: boolean
  lastSummaryPreview?: string
}

export type ResponseStatus = 'ok' | 'error' | 'timeout'

export interface ResponseTimeEntry {
  ts: number
  key: string
  channel?: string
  agent?: string
  routeIndex?: number
  wallMs: number
  apiMs: number
  model: string
  status?: ResponseStatus
}

export interface ResponseTimesData {
  recent: ResponseTimeEntry[]
  avgWallMs: number
  avgApiMs: number
  count1h: number
  sparkline: string
}

export interface ResponseTime {
  label: string
  ms: number
}

export interface LogEntry {
  ts: number
  level: string
  module: string
  msg: string
  extra?: Record<string, unknown>
}

export interface DashboardState {
  stats: Stats
  processes: ProcessSession[]
  responseTimes: ResponseTimesData
  logs: LogEntry[]
  routes: Route[]
  agents: Agent[]
  cliSessions?: CliSession[]
  [key: string]: unknown
}

export interface CliSession {
  id: string
  workspace: string
  startedAt: number
  lastSeen: number
  alive: boolean
}

export type LocalSessionStatus = 'working' | 'idle' | 'waiting' | 'finished' | 'errored' | 'unknown'

export interface LocalSession {
  pid: number
  cwd: string
  repoName: string
  branch: string | null
  status: LocalSessionStatus
  hookEvent: string | null
  sessionId: string | null
  transcriptPath: string | null
  lastActivity: number
  tty: string | null
  parentCommand: string | null
  preview: { lastUserMessage: string | null; lastAssistantText: string | null }
  isRouterSpawned: boolean
  // Context Inspector enrichment — populated by /api/local-sessions handler.
  liveTokens?: number
  liveTokensSource?: 'sdk-task-progress' | 'sdk-result' | 'jsonl-tail' | 'unknown'
  liveTokensAt?: number
  contextWindow?: number
  lastTurnCostUsd?: number
  model?: string
  compactionCount?: number
  sessionKey?: string
  agent?: string
  fullAccess?: boolean
  inheritUserScope?: boolean
}

export type OpenTargetId = 'iterm' | 'terminal' | 'topics' | 'finder' | 'editor' | 'pr'

export interface TargetAvailability {
  id: OpenTargetId
  available: boolean
  label: string
  reason?: string
}

// ─── Context Inspector (Phase 1 — Plan 01-06) ────────────────────────────────

/** Alias kept for backward import compat — fields are now on LocalSession directly. */
export type ContextLiveSession = LocalSession

export interface ContextAggregate {
  totalSessions: number
  totalLiveTokens: number
  avgCostPerTurnUsd: number
}

export interface ContextDisk {
  totalMb: number
  totalJsonl: number
  filesOlderThan30d: number
}

export interface ContextRecentSession {
  slug: string
  sessionId: string
  transcriptPath: string
  cwd: string
  routeHint: string | null
  mtime: number
  sizeBytes: number
  totalTokens: number
  turnCount: number
  compactionCount: number
}

export interface ContextSessionsResponse {
  sessions: ContextLiveSession[]
  aggregate: ContextAggregate
  disk: ContextDisk
  recent: ContextRecentSession[]
}

export interface BreakdownCategory {
  category:
    | 'system_preset'
    | 'builtin_tools'
    | 'mcp_servers'
    | 'skills_index'
    | 'claudemd_chain'
    | 'subagents'
    | 'hooks_memory'
    | 'history'
  tokens: number
  details: unknown
}

export interface SessionBreakdown {
  sessionId: string
  sessionKey: string | null
  agent: string
  liveTotal: number
  categories: BreakdownCategory[]
  totalEstimated: number
}

export interface CruftFinding {
  kind: 'mcp_unused' | 'skill_unused'
  name: string
  loadedTokens: number
  recentTurns: number
  callCount: number
}

export interface ConfigSuggestion {
  id: string
  when: string
  action: string
  rationale: string
}

export interface AgentCruft {
  agent: string
  findings: CruftFinding[]
  suggestions: ConfigSuggestion[]
}

export interface CruftResponse {
  agents: AgentCruft[]
}

// ─── Agent Baselines (static config inspector) ───────────────────────────────

export interface AgentCruftHint {
  id: string
  severity: 'info' | 'warn' | 'crit'
  message: string
  potentialSavingsTokens?: number
}

export interface AgentBaseline {
  agent: string
  model: string
  fallbacks: string[]
  fullAccess: boolean
  inheritUserScope: boolean
  tools: string[]
  effort: string | null
  workspace: string
  /** Same shape as SessionBreakdown.breakdown — categories + totalEstimated. */
  breakdown: {
    categories: BreakdownCategory[]
    totalEstimated: number
    liveTotal: number
  }
  cruftHints: AgentCruftHint[]
}

export interface AgentBaselineResponse {
  agents: AgentBaseline[]
}

export interface Exchange {
  user: string
  assistant: string
  timestamp: number
}

export interface SessionThread {
  key: string
  exchanges: Exchange[]
  truncated: boolean
  total: number
}

export interface Tool {
  id: string
  name: string
  type: string
  label: string
  icon?: string
  category?: string
  description?: string
  command?: string
  mcpConfig?: { url?: string; command?: string; args?: string[]; type?: string }
  [key: string]: unknown
}

export interface ToolsResponse {
  tools: Tool[]
  byRoute: Record<string, number[]>
  routeMap: Record<string, number[]>
}

export interface CronJob {
  name: string
  schedule?: string
  lastRun?: string
  nextRun?: string
  [key: string]: unknown
}

export interface CronRun {
  ts: number
  jobName: string
  trigger: 'schedule' | 'manual'
  status: 'ok' | 'error' | 'timeout'
  runAtMs: number
  durationMs: number
  nextRunAtMs?: number
  model?: string
  sessionId?: string
  result?: string
  error?: string
  delivery?: { channel: string; target: string; ok: boolean; error?: string }
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
  costUsd?: number
}

export interface CostEntry {
  date: string
  cost: number
  tokens?: number
  [key: string]: unknown
}

export interface MemoryStats {
  docs: Record<string, unknown>
  memories: Record<string, unknown>
}

export interface MemorySearchResult {
  id: string
  content: string
  score?: number
  metadata?: Record<string, unknown>
}

export interface FileEntry {
  path: string
  name: string
  size: number
  category?: string
  modified?: string
}

export interface Channel {
  name: string
  type: string
  status?: string
  enabled?: boolean
  config?: Record<string, unknown>
  routeCount?: number
  messageCount?: number
  [key: string]: unknown
}

export interface MemoryGraphData {
  nodes: Array<{ id: string; label: string; category: string; size: number }>
  edges: Array<{ source: string; target: string }>
}

export interface SkillsResponse {
  plugins: Array<{
    name: string
    scope: string
    project: string | null
    enabled: boolean
    installedAt: string | null
  }>
  customSkills: Array<{
    name: string
    dirName: string
    path: string
    description: string
    content: string
  }>
  pluginSkills: Array<{
    name: string
    plugin: string
    pluginName: string
    description: string
    content: string
    path: string
  }>
}

export interface SettingsResponse {
  hooks: Record<string, unknown>
  mcpServers: Record<string, unknown>
  plugins: Record<string, unknown>
}

export interface EmailAccount {
  email: string
  account: string
}

// API client

const BASE = ''

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

function requestConfirm<T>(path: string, options?: RequestInit): Promise<T> {
  return request<T>(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Confirm': 'true',
      ...(options?.headers || {}),
    },
  })
}

export const api = {
  // Dashboard state (polled)
  stats: () => request<Stats>('/api/stats'),
  dashboardState: () => request<DashboardState>('/api/dashboard-state'),
  services: () => request<ServiceStatus[]>('/api/services'),
  routes: () => request<Route[]>('/api/routes'),
  agents: () => request<Agent[]>('/api/agents'),
  sessions: () => request<CliSession[]>('/api/cli-sessions'),
  processes: () => request<ProcessSession[]>('/api/processes'),
  config: () => request<Record<string, unknown>>('/api/config'),
  tools: () => request<ToolsResponse>('/api/tools'),
  crons: () => request<CronJob[]>('/api/crons'),
  costs: (days = 7) => request<CostEntry[]>(`/api/costs?days=${days}`),
  channels: () => request<Channel[]>('/api/channels'),
  settings: () => request<SettingsResponse>('/api/settings'),

  // Session lifecycle
  sessionStart: (id: string, workspace?: string) =>
    request<{ ok: boolean; id: string }>('/api/session-start', {
      method: 'POST',
      body: JSON.stringify({ id, workspace }),
    }),
  sessionStop: (id: string) =>
    request<{ ok: boolean }>('/api/session-stop', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  sessionHeartbeat: (id: string) =>
    request<{ ok: boolean }>('/api/session-heartbeat', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),

  // Config: Global CLAUDE.md
  getGlobalClaudeMd: () =>
    request<{ content: string }>('/api/config/global-claude-md'),
  putGlobalClaudeMd: (content: string) =>
    requestConfirm<{ ok: boolean }>('/api/config/global-claude-md', {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  // Config: YAML
  getConfigYaml: () => request<Record<string, unknown>>('/api/config'),
  putConfigYaml: (content: string) =>
    requestConfirm<{ ok: boolean }>('/api/config/yaml', {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  // Config: Callers
  addCaller: (phone: string) =>
    request<{ ok: boolean; callers: string[] }>('/api/config/callers', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    }),
  removeCaller: (phone: string) =>
    requestConfirm<{ ok: boolean; callers: string[] }>(
      `/api/config/callers/${encodeURIComponent(phone)}`,
      { method: 'DELETE' },
    ),

  // Config: Always reply groups
  addAlwaysReply: (group: string) =>
    request<{ ok: boolean; groups: string[] }>('/api/config/always-reply', {
      method: 'POST',
      body: JSON.stringify({ group }),
    }),
  removeAlwaysReply: (group: string) =>
    requestConfirm<{ ok: boolean; groups: string[] }>(
      `/api/config/always-reply/${encodeURIComponent(group)}`,
      { method: 'DELETE' },
    ),

  // Config: Email accounts
  getEmailAccounts: () =>
    request<{ accounts: EmailAccount[] }>('/api/config/email-accounts'),
  addEmailAccount: (email: string, account: string) =>
    request<{ ok: boolean }>('/api/config/email-accounts', {
      method: 'POST',
      body: JSON.stringify({ email, account }),
    }),
  removeEmailAccount: (email: string) =>
    requestConfirm<{ ok: boolean }>(
      `/api/config/email-accounts/${encodeURIComponent(email)}`,
      { method: 'DELETE' },
    ),

  // Config: Memory scopes
  addMemoryScope: (scope: string) =>
    request<{ ok: boolean; scopes: string[] }>('/api/config/memory-scopes', {
      method: 'POST',
      body: JSON.stringify({ scope }),
    }),

  // Agents: CLAUDE.md
  getAgentClaudeMd: (name: string) =>
    request<{ content: string }>(`/api/agents/${encodeURIComponent(name)}/claude-md`),
  putAgentClaudeMd: (name: string, content: string) =>
    request<{ ok: boolean }>(`/api/agents/${encodeURIComponent(name)}/claude-md`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  // Agents: arbitrary file
  getAgentFile: (name: string, file: string) =>
    request<{ agent: string; file: string; content: string }>(
      `/api/agents/file?name=${encodeURIComponent(name)}&file=${encodeURIComponent(file)}`,
    ),
  putAgentFile: (name: string, file: string, content: string) =>
    requestConfirm<{ ok: boolean }>('/api/agents/file', {
      method: 'PUT',
      body: JSON.stringify({ name, file, content }),
    }),

  // Agents: config (model, tools, effort, etc.)
  updateAgentConfig: (name: string, config: Record<string, unknown>) =>
    request<void>(`/api/agents/${encodeURIComponent(name)}/config`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  // Shared files (_shared/)
  getSharedFiles: () =>
    request<{ files: Array<{ name: string; size: number }> }>('/api/shared/files'),
  getSharedFile: (file: string) =>
    request<{ file: string; content: string }>(
      `/api/shared/file?file=${encodeURIComponent(file)}`,
    ),
  putSharedFile: (file: string, content: string) =>
    requestConfirm<{ ok: boolean }>('/api/shared/file', {
      method: 'PUT',
      body: JSON.stringify({ file, content }),
    }),

  // Skills
  getSkills: () => request<SkillsResponse>('/api/skills'),
  getSkillContent: (name: string) =>
    request<{ content: string }>(`/api/skills/${encodeURIComponent(name)}/content`),
  putSkillContent: (name: string, content: string) =>
    request<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}/content`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  // Memory
  memoryStats: () => request<MemoryStats>('/api/memory/stats'),
  memorySearch: (q: string, scope = '', limit = 20) =>
    request<MemorySearchResult[]>(
      `/api/memory/search?q=${encodeURIComponent(q)}&scope=${scope}&limit=${limit}`,
    ),
  memoryFiles: () => request<{ root: string; files: FileEntry[] }>('/api/memory/files'),
  memoryFile: (path: string) =>
    request<{ path: string; content: string; size: number }>(
      `/api/memory/file?path=${encodeURIComponent(path)}`,
    ),
  putMemoryFile: (path: string, content: string) =>
    requestConfirm<{ ok: boolean }>('/api/memory/file', {
      method: 'PUT',
      body: JSON.stringify({ path, content }),
    }),
  deleteMemoryFile: (path: string) =>
    requestConfirm<{ ok: boolean }>(
      `/api/memory/file?path=${encodeURIComponent(path)}`,
      { method: 'DELETE' },
    ),
  memoryGraph: () => request<MemoryGraphData>('/api/memory/graph'),
  memoryMemories: (scope?: string) =>
    request<{ memories: Array<Record<string, unknown>> }>(
      `/api/memory/memories${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`,
    ),
  deleteMemory: (id: string) =>
    requestConfirm<{ ok: boolean; id: string }>(
      `/api/memory/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  reindexMemory: () =>
    request<{ indexed: number }>('/api/memory/reindex', { method: 'POST' }),

  // Routes
  routesFull: () => request<FullRoute[]>('/api/routes/full'),
  agentsFull: () => request<FullAgent[]>('/api/agents/full'),
  createRoute: (route: Partial<Route>) =>
    request<Route>('/api/routes', { method: 'POST', body: JSON.stringify(route) }),
  updateRoute: (index: number, route: Partial<Route>) =>
    request<Route>(`/api/routes/${index}`, { method: 'PUT', body: JSON.stringify(route) }),
  deleteRoute: (index: number) =>
    requestConfirm<void>(`/api/routes/${index}`, { method: 'DELETE' }),
  duplicateRoute: (index: number) =>
    request<{ ok: boolean; newIndex: number }>(`/api/routes/${index}/duplicate`, {
      method: 'POST',
    }),

  // Agents CRUD
  createAgent: (agent: Partial<Agent>) =>
    request<Agent>('/api/agents', { method: 'POST', body: JSON.stringify(agent) }),
  deleteAgent: (name: string) =>
    requestConfirm<void>(`/api/agents/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // Permissions / channel scope / audit / matrix
  patchAgentChannelScope: (
    name: string,
    body: { discord?: ChannelScope | null; whatsapp?: ChannelScope | null; telegram?: ChannelScope | null },
  ) =>
    request<{ ok: boolean; scope: { discord: ChannelScope | null; whatsapp: ChannelScope | null; telegram: ChannelScope | null }; killedSessions: number }>(
      `/api/agents/${encodeURIComponent(name)}/channel-scope`,
      { method: 'PATCH', body: JSON.stringify(body) },
    ),
  permissionMatrix: () => request<PermissionMatrix>('/api/permission-matrix'),
  audit: (opts?: { limit?: number; agent?: string; event?: string }) => {
    const q = new URLSearchParams()
    if (opts?.limit) q.set('limit', String(opts.limit))
    if (opts?.agent) q.set('agent', opts.agent)
    if (opts?.event) q.set('event', opts.event)
    const qs = q.toString()
    return request<{ entries: AuditEntry[]; path: string }>(`/api/audit${qs ? `?${qs}` : ''}`)
  },

  // Crons
  createCron: (cron: Record<string, unknown>) =>
    request<{ ok: boolean; name: string }>('/api/crons', {
      method: 'POST',
      body: JSON.stringify(cron),
    }),
  updateCron: (name: string, data: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/crons/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteCron: (name: string) =>
    requestConfirm<{ ok: boolean }>(`/api/crons/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),
  runCron: (name: string) =>
    request<void>(`/api/crons/${encodeURIComponent(name)}/run`, { method: 'POST' }),
  cronRuns: (name: string, limit = 50) =>
    request<{ runs: CronRun[] }>(`/api/crons/${encodeURIComponent(name)}/runs?limit=${limit}`),

  // Channels
  updateChannel: (name: string, data: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/channels/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  // Session kill
  killSession: (key: string) =>
    request<void>(`/api/kill/${encodeURIComponent(key)}`, { method: 'POST' }),

  // Session thread (conversation drill-down)
  sessionThread: (key: string, limit = 50) =>
    request<SessionThread>(
      `/api/sessions/${encodeURIComponent(key)}/thread?limit=${limit}`,
    ),

  // CLI session pruning (persistent CLI registrations)
  pruneCliSessions: () =>
    request<{ ok: boolean; removed: number }>('/api/cli-sessions', { method: 'DELETE' }),
  removeCliSession: (id: string) =>
    request<{ ok: boolean }>(`/api/cli-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Local Claude Code sessions (auto-discovered from the process table).
  // Returns the LocalSession[] shape — projection of `.sessions` from the
  // unified /api/local-sessions response (no backward-compat branch on server).
  localSessions: async (): Promise<LocalSession[]> => {
    const r = await request<ContextSessionsResponse>('/api/local-sessions')
    return r.sessions as LocalSession[]
  },
  localSessionTargets: (pid: number) =>
    request<TargetAvailability[]>(`/api/local-sessions/${pid}/targets`),
  openLocalSession: (pid: number, target: OpenTargetId) =>
    request<{ ok: boolean }>(`/api/local-sessions/${pid}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    }),

  // Context Inspector (Phase 1 — Plan 01-06)
  contextSessions: () => request<ContextSessionsResponse>('/api/local-sessions'),
  sessionBreakdown: (sessionId: string) =>
    request<SessionBreakdown>(`/api/sessions/${encodeURIComponent(sessionId)}/breakdown`),
  sessionsCruft: () => request<CruftResponse>('/api/sessions/cruft'),
  agentsBaseline: () => request<AgentBaselineResponse>('/api/agents/baseline'),

  // ── MCP Auth Manager (Phase 3) ────────────────────────────────────────────
  // Pairs with the dashboard `MCP Health` tab and the three boot-time
  // services in router/src/services/mcp-{health-monitor,auth-backup,refresh-trigger}.ts.
  mcpStatus: async (): Promise<McpServerStatus[]> => {
    const r = await fetch('/api/mcp-status')
    if (!r.ok) throw new Error(`mcp-status failed: ${r.status}`)
    const body = (await r.json()) as { servers?: McpServerStatus[] }
    return body.servers ?? []
  },
  mcpRefresh: () =>
    request<{ ok: boolean; servers: McpServerStatus[] }>('/api/mcp/refresh', { method: 'POST' }),
  mcpAuthenticate: async (name: string): Promise<McpAuthResult> => {
    const r = await fetch('/api/mcp/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    return r.json() as Promise<McpAuthResult>
  },
  // Pending MCPs — servers parked in ~/.claude/mcp-pending.json that need an
  // explicit user-driven OAuth before being committed back into ~/.claude.json.
  // See router/src/dashboard/api.ts for the two endpoints.
  mcpPending: async (): Promise<McpPendingServer[]> => {
    const r = await fetch('/api/mcp/pending')
    if (!r.ok) throw new Error(`mcp-pending failed: ${r.status}`)
    const body = (await r.json()) as { pending?: McpPendingServer[] }
    return body.pending ?? []
  },
  mcpApprovePending: async (name: string): Promise<McpAuthResult> => {
    const r = await fetch('/api/mcp/approve-pending', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    return r.json() as Promise<McpAuthResult>
  },
  // Per-server tool lists — the router connects to each CONNECTED MCP and
  // enumerates its tools/list. Cached (5min TTL) on the backend.
  mcpTools: async (): Promise<Record<string, McpServerTools>> => {
    const r = await fetch('/api/mcp/tools')
    if (!r.ok) throw new Error(`mcp-tools failed: ${r.status}`)
    const body = (await r.json()) as { tools?: Record<string, McpServerTools> }
    return body.tools ?? {}
  },
  mcpToolsRefresh: () =>
    request<{ ok: boolean; tools: Record<string, McpServerTools>; refreshedAt: number }>(
      '/api/mcp/tools/refresh', { method: 'POST' }),
}

// ── MCP Auth Manager — public types (consumed by MCPHealth tab) ─────────────

export interface McpServerStatus {
  name: string
  target: string
  status: 'connected' | 'auth' | 'failed' | 'unknown'
  statusText: string
}

export interface McpAuthResult {
  ok: boolean
  reason?: string
  name?: string
  url?: string
}

export interface McpPendingServer {
  name: string
  url: string
  transport: 'stdio+mcp-remote' | 'http' | 'sse'
}

export interface McpToolInfo {
  name: string
  description: string
}

export interface McpServerTools {
  tools: McpToolInfo[]
  error: string | null
}
