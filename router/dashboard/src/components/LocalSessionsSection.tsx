import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, FolderOpen, Terminal as TerminalIcon, GitPullRequest, Code2, LayoutDashboard, RefreshCw, Brain } from 'lucide-react'
import { SessionContextExplorer } from './context/SessionContextExplorer'
import { formatTokens, colorForThreshold } from './context/thresholds'
import { api } from '../api/client'
import type { LocalSession, OpenTargetId, TargetAvailability } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { SectionHeader } from './ui/PageHeader'
import { Tooltip } from './ui/Tooltip'
import { EmptyState } from './ui/EmptyState'

const TARGET_ICONS: Record<OpenTargetId, React.ReactNode> = {
  iterm: <TerminalIcon size={12} />,
  terminal: <TerminalIcon size={12} />,
  topics: <LayoutDashboard size={12} />,
  finder: <FolderOpen size={12} />,
  editor: <Code2 size={12} />,
  pr: <GitPullRequest size={12} />,
}

function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function statusTone(status: LocalSession['status']): 'ok' | 'warn' | 'err' | 'muted' | 'accent' {
  switch (status) {
    case 'working': return 'ok'
    case 'waiting': return 'warn'
    case 'errored': return 'err'
    case 'finished': return 'muted'
    case 'idle': return 'muted'
    default: return 'muted'
  }
}

export function LocalSessionsSection({
  onToast,
}: {
  onToast: (msg: string, type: 'success' | 'error' | 'info') => void
}) {
  const fetchLocal = useCallback(() => api.localSessions(), [])
  const { data, loading, refresh } = usePolling<LocalSession[]>(fetchLocal, 3000)
  const sessions = useMemo(() => data || [], [data])

  if (sessions.length === 0 && !loading) {
    return (
      <div>
        <SectionHeader
          title="Local Claude Code sessions"
          count="none"
          action={<IconButton icon={<RefreshCw size={13} />} label="Refresh" onClick={refresh} />}
        />
        <EmptyState
          title="No local claude sessions"
          hint="Start `claude` in any terminal — it will appear here within a few seconds. Status updates require hooks in ~/.claude/settings.json (installed automatically on router start)."
        />
      </div>
    )
  }

  return (
    <div>
      <SectionHeader
        title="Local Claude Code sessions"
        count={`${sessions.length} running`}
        action={<IconButton icon={<RefreshCw size={13} />} label="Refresh" onClick={refresh} disabled={loading} />}
      />
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
        {sessions.map((s) => (
          <LocalSessionCard key={s.pid} session={s} onToast={onToast} />
        ))}
      </div>
    </div>
  )
}

function LocalSessionCard({
  session,
  onToast,
}: {
  session: LocalSession
  onToast: (msg: string, type: 'success' | 'error' | 'info') => void
}) {
  const [targets, setTargets] = useState<TargetAvailability[] | null>(null)
  const [busy, setBusy] = useState<OpenTargetId | null>(null)
  const [explorerOpen, setExplorerOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.localSessionTargets(session.pid)
      .then((t) => { if (!cancelled) setTargets(t) })
      .catch(() => { if (!cancelled) setTargets([]) })
    return () => { cancelled = true }
  }, [session.pid])

  const open = async (target: OpenTargetId) => {
    setBusy(target)
    try {
      await api.openLocalSession(session.pid, target)
      onToast(`Opened in ${target}`, 'success')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed'
      onToast(`Open ${target} failed: ${msg}`, 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="rounded-lg p-3"
      style={{
        background: 'var(--bg-1)',
        border: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Badge tone={statusTone(session.status)} size="sm">
          {session.status}
        </Badge>
        {session.isRouterSpawned && <Badge tone="accent" size="xs">router</Badge>}
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 13,
            color: 'var(--text-1)',
            fontWeight: 600,
            marginRight: 'auto',
          }}
        >
          {session.repoName}
        </span>
        {typeof session.liveTokens === 'number' && session.liveTokens > 0 && (
          <span
            title={`${session.liveTokens.toLocaleString()} token su ${(session.contextWindow ?? 200000).toLocaleString()} window`}
            style={{
              fontSize: 10,
              fontFamily: 'var(--mono)',
              padding: '2px 6px',
              borderRadius: 999,
              background: colorForThreshold((session.liveTokens ?? 0) / (session.contextWindow ?? 200000)),
              color: '#fff',
              fontWeight: 600,
            }}
          >
            {formatTokens(session.liveTokens)}
          </span>
        )}
        <span style={{ fontSize: 10, color: 'var(--text-4)', fontFamily: 'var(--mono)' }}>pid {session.pid}</span>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
        {session.cwd}
        {session.branch && (
          <>
            {' · '}
            <span style={{ color: 'var(--accent-bright)' }}>{session.branch}</span>
          </>
        )}
      </div>

      {session.preview.lastUserMessage && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-3)',
            background: 'var(--bg-0)',
            padding: '6px 8px',
            borderRadius: 'var(--radius-sm)',
            lineHeight: 1.4,
          }}
        >
          <span style={{ color: 'var(--text-4)' }}>→ </span>
          {session.preview.lastUserMessage}
        </div>
      )}
      {session.preview.lastAssistantText && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-2)',
            background: 'var(--bg-0)',
            padding: '6px 8px',
            borderRadius: 'var(--radius-sm)',
            lineHeight: 1.4,
          }}
        >
          <span style={{ color: 'var(--text-4)' }}>← </span>
          {session.preview.lastAssistantText}
        </div>
      )}

      <div style={{ fontSize: 10, color: 'var(--text-4)', fontFamily: 'var(--mono)' }}>
        {fmtAgo(session.lastActivity)}
        {session.hookEvent && ` · ${session.hookEvent}`}
      </div>

      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {session.sessionId && (
          <Tooltip content="Explore context: 8-category breakdown, MCP, CLAUDE.md chain" placement="top">
            <span>
              <Button size="xs" variant="ghost" onClick={() => setExplorerOpen(true)}>
                <Brain size={12} />
                <span style={{ marginLeft: 4 }}>Explore</span>
              </Button>
            </span>
          </Tooltip>
        )}
        {(targets ?? []).map((t) => (
          <Tooltip key={t.id} content={t.available ? `Open in ${t.label}` : t.reason || 'unavailable'} placement="top">
            <span>
              <Button
                size="xs"
                variant="ghost"
                disabled={!t.available || busy === t.id}
                onClick={() => open(t.id)}
                title={t.reason}
              >
                {TARGET_ICONS[t.id]}
                <span style={{ marginLeft: 4 }}>{t.label}</span>
                {t.id === 'pr' && <ExternalLink size={10} style={{ marginLeft: 2 }} />}
              </Button>
            </span>
          </Tooltip>
        ))}
      </div>

      {explorerOpen && session.sessionId && (
        <SessionContextExplorer
          sessionId={session.sessionId}
          title={`${session.repoName}${session.agent ? ` · ${session.agent}` : ''}`}
          onClose={() => setExplorerOpen(false)}
        />
      )}
    </div>
  )
}
