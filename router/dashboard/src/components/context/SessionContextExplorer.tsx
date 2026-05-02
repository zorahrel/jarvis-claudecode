import { useEffect, useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import { api } from '../../api/client'
import type { SessionBreakdown } from '../../api/client'
import { BreakdownStackedBar } from './BreakdownStackedBar'
import { formatTokens } from './thresholds'

/**
 * Modal/drawer that fetches /api/sessions/:id/breakdown and renders the
 * 8-category stacked bar. Reusable wherever a session is shown in the dashboard
 * (LocalSessionsSection, ContextTab, future Sessions page enrichments).
 *
 * Provides the "Explore" experience for any session: click → see what's
 * inside the context window broken down by category, with MCP and CLAUDE.md
 * drill-downs.
 */

interface Props {
  sessionId: string
  /** Optional headline to display above the breakdown (e.g. agent name + cwd). */
  title?: string
  onClose: () => void
}

export function SessionContextExplorer({ sessionId, title, onClose }: Props) {
  const [data, setData] = useState<SessionBreakdown | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .sessionBreakdown(sessionId)
      .then((b) => {
        if (!cancelled) setData(b)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'errore')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 60,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-1)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 20,
          width: 'min(720px, 92vw)',
          maxHeight: '85vh',
          overflow: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text-1)' }}>
            Context explorer
          </h3>
          {title && (
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 12,
                color: 'var(--text-3)',
                marginLeft: 4,
              }}
            >
              {title}
            </span>
          )}
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-3)',
              padding: 4,
            }}
          >
            <X size={18} />
          </button>
        </div>

        {loading && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: 24,
              color: 'var(--text-3)',
              fontSize: 13,
            }}
          >
            <Loader2 size={14} className="animate-spin" />
            Loading breakdown...
          </div>
        )}

        {error && (
          <div style={{ padding: 16, color: '#ef4444', fontSize: 13 }}>Error: {error}</div>
        )}

        {data && (
          <>
            <div
              style={{
                display: 'flex',
                gap: 24,
                marginBottom: 16,
                padding: 12,
                background: 'var(--bg-0)',
                borderRadius: 6,
                fontFamily: 'var(--mono)',
                fontSize: 12,
              }}
            >
              <div>
                <div style={{ color: 'var(--text-3)', fontSize: 10, textTransform: 'uppercase' }}>
                  Live total
                </div>
                <div style={{ color: 'var(--text-1)', fontWeight: 600 }}>
                  {formatTokens(data.liveTotal)}
                </div>
              </div>
              <div>
                <div style={{ color: 'var(--text-3)', fontSize: 10, textTransform: 'uppercase' }}>
                  Estimated breakdown
                </div>
                <div style={{ color: 'var(--text-1)', fontWeight: 600 }}>
                  {formatTokens(data.totalEstimated)}
                </div>
              </div>
              {data.agent && (
                <div>
                  <div
                    style={{
                      color: 'var(--text-3)',
                      fontSize: 10,
                      textTransform: 'uppercase',
                    }}
                  >
                    Agent
                  </div>
                  <div style={{ color: 'var(--text-1)', fontWeight: 600 }}>{data.agent}</div>
                </div>
              )}
            </div>

            <BreakdownStackedBar breakdown={data} />
          </>
        )}
      </div>
    </div>
  )
}
