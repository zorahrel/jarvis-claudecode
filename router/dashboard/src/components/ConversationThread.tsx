import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ExternalLink } from 'lucide-react'
import { api, type Exchange, type SessionThread } from '../api/client'
import { Button } from './ui/Button'
import { Badge } from './ui/Badge'

const DEFAULT_VISIBLE = 10
const COLLAPSE_CHARS = 400

function relativeTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s fa`
  if (s < 3600) return `${Math.floor(s / 60)}m fa`
  if (s < 86_400) return `${Math.floor(s / 3600)}h fa`
  return `${Math.floor(s / 86_400)}g fa`
}

export function RelativeTime({ ts, full }: { ts: number; full?: boolean }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])
  return (
    <span
      title={new Date(ts).toLocaleString('en-US')}
      style={{ fontSize: 10, color: 'var(--text-4)', fontFamily: full ? 'var(--mono)' : undefined }}
    >
      {relativeTime(ts)}
    </span>
  )
}

interface MessageBubbleProps {
  role: 'user' | 'assistant'
  text: string
  model?: string | null
}

export function MessageBubble({ role, text, model }: MessageBubbleProps) {
  const [expanded, setExpanded] = useState(false)
  const isUser = role === 'user'
  const canCollapse = text.length > COLLAPSE_CHARS
  const display = expanded || !canCollapse ? text : text.slice(0, COLLAPSE_CHARS) + '…'

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        maxWidth: '100%',
      }}
    >
      <div
        style={{
          fontSize: 9,
          color: 'var(--text-4)',
          marginBottom: 3,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          textTransform: 'uppercase',
          letterSpacing: 0.3,
        }}
      >
        <span>{isUser ? 'user' : 'assistant'}</span>
        {!isUser && model && (
          <span style={{ fontFamily: 'var(--mono)', textTransform: 'none' }}>· {model}</span>
        )}
      </div>
      <div
        style={{
          maxWidth: '85%',
          padding: '8px 12px',
          borderRadius: 'var(--radius-md)',
          background: isUser ? 'var(--accent-tint)' : 'var(--bg-0)',
          border: `1px solid ${isUser ? 'var(--accent-border)' : 'var(--border)'}`,
          color: 'var(--text-1)',
          fontSize: 12,
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {display}
        {canCollapse && (
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{
              display: 'block',
              marginTop: 6,
              background: 'transparent',
              border: 'none',
              color: 'var(--text-3)',
              fontSize: 10,
              cursor: 'pointer',
              padding: 0,
              textDecoration: 'underline',
            }}
          >
            {expanded ? 'collapse' : `expand (+${text.length - COLLAPSE_CHARS} chars)`}
          </button>
        )}
      </div>
    </div>
  )
}

interface ConversationThreadProps {
  sessionKey: string
  model?: string | null
  visible?: number
  onError?: (msg: string) => void
  onOpenLogs?: (key: string) => void
}

export function ConversationThread({
  sessionKey,
  model,
  visible = DEFAULT_VISIBLE,
  onError,
  onOpenLogs,
}: ConversationThreadProps) {
  const [thread, setThread] = useState<SessionThread | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.sessionThread(sessionKey, 50)
      setThread(data)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to load conversation'
      setError(msg)
      onError?.(msg)
    } finally {
      setLoading(false)
    }
  }, [sessionKey, onError])

  useEffect(() => {
    setThread(null)
    setShowAll(false)
    load()
  }, [load])

  const exchanges: Exchange[] = thread?.exchanges ?? []
  const shown = showAll ? exchanges : exchanges.slice(-visible)
  const hiddenCount = exchanges.length - shown.length

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 10,
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {thread && (
            <Badge tone="muted" size="xs">
              {thread.exchanges.length} shown / {thread.total} total
            </Badge>
          )}
          {thread?.truncated && (
            <Badge tone="warn" size="xs" title="File contains more exchanges than loaded">
              truncated
            </Badge>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {onOpenLogs && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onOpenLogs(sessionKey)}
              title="Open Logs filtered by this session"
            >
              <ExternalLink size={11} style={{ marginRight: 4 }} />
              Logs
            </Button>
          )}
          <Button variant="ghost" size="xs" onClick={load} disabled={loading}>
            <RefreshCw size={11} style={{ marginRight: 4 }} />
            Refresh
          </Button>
        </div>
      </div>

      {loading && !thread && (
        <div
          style={{
            padding: '24px 12px',
            textAlign: 'center',
            color: 'var(--text-4)',
            fontSize: 11,
          }}
        >
          Loading conversation…
        </div>
      )}

      {error && !loading && (
        <div
          style={{
            padding: '12px',
            border: '1px solid var(--err-border)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--err-tint)',
            color: 'var(--err)',
            fontSize: 11,
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && thread && exchanges.length === 0 && (
        <div
          style={{
            padding: '24px 12px',
            textAlign: 'center',
            color: 'var(--text-4)',
            fontSize: 11,
          }}
        >
          No exchanges recorded yet.
        </div>
      )}

      {exchanges.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {hiddenCount > 0 && (
            <button
              onClick={() => setShowAll(true)}
              style={{
                alignSelf: 'center',
                background: 'transparent',
                border: '1px dashed var(--border)',
                color: 'var(--text-4)',
                fontSize: 10,
                padding: '4px 10px',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
              }}
            >
              Show {hiddenCount} earlier exchange{hiddenCount === 1 ? '' : 's'}
            </button>
          )}
          {shown.map((ex, i) => (
            <div
              key={`${ex.timestamp}-${i}`}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <MessageBubble role="user" text={ex.user} />
              <MessageBubble role="assistant" text={ex.assistant} model={model} />
              <div style={{ alignSelf: 'center' }}>
                <RelativeTime ts={ex.timestamp} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
