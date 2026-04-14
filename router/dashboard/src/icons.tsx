import {
  Globe,
  Clock,
  Radio,
  CheckCircle2,
  XCircle,
  Loader2,
  Bot,
  LayoutDashboard,
  Route,
  Wrench,
  Zap,
  Brain,
  SquareTerminal,
  Settings,
  FileText,
  ArrowUp,
  Minus,
  BarChart3,
  Eye,
  Mic,
  FolderOpen,
  FolderClosed,
  Rocket,
  Mail,
  Calendar,
  Search,
  Server,
} from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import type { ReactNode } from 'react'
import { RiTelegramLine, RiWhatsappLine, RiDiscordLine } from 'react-icons/ri'

// ── Channel icons ──

export function ChannelIcon({ channel, size = 20, color = 'currentColor' }: { channel: string; size?: number; color?: string }) {
  switch (channel) {
    case 'telegram': return <RiTelegramLine size={size} color={color} />
    case 'whatsapp': return <RiWhatsappLine size={size} color={color} />
    case 'discord': return <RiDiscordLine size={size} color={color} />
    case 'http': return <Globe size={size} color={color} />
    case 'cron': return <Clock size={size} color={color} />
    default: return <Radio size={size} color={color} />
  }
}

// ── Cron status icons ──
export function CronStatusIcon({ status, size = 16 }: { status?: string; size?: number }) {
  if (status === 'ok') return <CheckCircle2 size={size} color="var(--ok)" />
  if (status === 'error') return <XCircle size={size} color="var(--err)" />
  if (status === 'running') return <Loader2 size={size} color="var(--warn)" className="spinner" />
  return <Minus size={size} color="var(--text-4)" />
}

// ── Agent icon (inline, for route rows etc) ──
export function AgentIcon({ size = 14, ...rest }: LucideProps) {
  return <Bot size={size} style={{ verticalAlign: -2, display: 'inline-block', marginRight: 4 }} {...rest} />
}

// ── Tool icons (shared between Tools page and Agents tools picker) ──

const toolIconMap: Record<string, (size: number) => ReactNode> = {
  vision: (s) => <Eye size={s} />,
  voice: (s) => <Mic size={s} />,
  documents: (s) => <FileText size={s} />,
  subagents: (s) => <Bot size={s} />,
  'fileAccess:full': (s) => <FolderOpen size={s} />,
  'fileAccess:readonly': (s) => <FolderClosed size={s} />,
  config: (s) => <Settings size={s} />,
  launchAgents: (s) => <Rocket size={s} />,
}

export function ToolIcon({ id, type, size = 16 }: { id: string; type?: string; size?: number }) {
  if (toolIconMap[id]) return <>{toolIconMap[id](size)}</>
  if (id.startsWith('memory:')) return <Brain size={size} />
  if (id.startsWith('email:')) return <Mail size={size} />
  if (id.startsWith('calendar:')) return <Calendar size={size} />
  if (type === 'mcp') return <Server size={size} />
  if (type === 'cli') return <Wrench size={size} />
  return <Search size={size} />
}

// ── Sidebar nav icons ──
export const navIcons: Record<string, (props?: LucideProps) => ReactNode> = {
  overview: (p) => <LayoutDashboard {...p} />,
  channels: (p) => <Radio {...p} />,
  routes: (p) => <Route {...p} />,
  agents: (p) => <Bot {...p} />,
  tools: (p) => <Wrench {...p} />,
  skills: (p) => <Zap {...p} />,
  cron: (p) => <Clock {...p} />,
  memory: (p) => <Brain {...p} />,
  sessions: (p) => <SquareTerminal {...p} />,
  analytics: (p) => <BarChart3 {...p} />,
  settings: (p) => <Settings {...p} />,
  logs: (p) => <FileText {...p} />,
}

// ── Re-exports for one-off usage ──
export { ArrowUp }
