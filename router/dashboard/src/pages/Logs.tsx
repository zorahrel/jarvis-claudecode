import { useState, useCallback, useEffect, useRef } from 'react'
import { api } from '../api/client'
import { usePolling } from '../hooks/usePolling'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import type { DashboardState, LogEntry } from '../api/client'

type LogLevel = 'all' | 'error' | 'warn' | 'info'

const levelColor: Record<string, string> = {
  error: 'var(--err)',
  warn: 'var(--warn)',
  info: 'var(--text-2)',
}

function formatTimestamp(ts: number): string {
  try {
    const d = new Date(ts)
    if (isNaN(d.getTime())) return String(ts)
    return d.toLocaleString('en-US', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return String(ts)
  }
}

function formatExtra(extra: Record<string, unknown>): string {
  return Object.entries(extra)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ')
}

export function Logs() {
  const fetchState = useCallback(() => api.dashboardState(), [])
  const { data } = usePolling<DashboardState>(fetchState, 3000)

  const [filter, setFilter] = useState<LogLevel>('all')
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  const logs: LogEntry[] = data?.logs || []
  const filtered = filter === 'all' ? logs : logs.filter((l) => l.level === filter)

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [filtered, autoScroll])

  const handleScroll = () => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50)
  }

  const filters: LogLevel[] = ['all', 'error', 'warn', 'info']

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        title="Logs"
        count={`${filtered.length} entries${filter !== 'all' ? ` (${logs.length} total)` : ''}`}
        actions={
          <>
            {!autoScroll && (
              <Button
                size="xs"
                variant="primary"
                onClick={() => {
                  setAutoScroll(true)
                  if (scrollRef.current) {
                    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
                  }
                }}
              >
                Resume auto-scroll
              </Button>
            )}
            <div style={{ display: 'flex', gap: 4 }}>
              {filters.map((f) => {
                const isOn = filter === f
                return (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    style={{
                      padding: '5px 12px',
                      fontSize: 11,
                      fontWeight: 500,
                      textTransform: 'capitalize',
                      borderRadius: 'var(--radius)',
                      border: `1px solid ${isOn ? 'var(--accent-border)' : 'var(--border)'}`,
                      background: isOn ? 'var(--accent-tint)' : 'transparent',
                      color: isOn ? 'var(--accent-bright)' : 'var(--text-4)',
                      cursor: 'pointer',
                      transition: 'background 0.15s, border-color 0.15s',
                    }}
                  >
                    {f}
                  </button>
                )
              })}
            </div>
          </>
        }
      />

      <div
        ref={scrollRef}
        style={{
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-2)',
          border: '1px solid var(--border)',
          height: 'calc(100vh - 140px)',
          overflowY: 'auto',
          fontFamily: 'var(--mono)',
          fontSize: 11,
        }}
        onScroll={handleScroll}
      >
        {filtered.map((log, i) => (
          <div
            key={`${log.ts}-${i}`}
            style={{
              display: 'flex',
              gap: 12,
              padding: '6px 16px',
              borderBottom: '1px solid var(--border)',
              background:
                log.level === 'error'
                  ? 'var(--err-tint)'
                  : log.level === 'warn'
                    ? 'var(--warn-tint)'
                    : 'transparent',
            }}
          >
            <span style={{ flexShrink: 0, width: 140, color: 'var(--text-4)' }}>
              {formatTimestamp(log.ts)}
            </span>
            <span
              style={{
                flexShrink: 0,
                width: 48,
                textTransform: 'uppercase',
                fontWeight: 600,
                color: levelColor[log.level] || 'var(--text-3)',
              }}
            >
              {log.level}
            </span>
            <span style={{ flexShrink: 0, color: 'var(--accent-bright)', opacity: 0.8 }}>
              [{log.module}]
            </span>
            <span style={{ color: 'var(--text-2)', minWidth: 0, wordBreak: 'break-word' }}>
              {log.msg}
              {log.extra && (
                <span style={{ color: 'var(--text-4)', marginLeft: 8 }}>
                  {formatExtra(log.extra)}
                </span>
              )}
            </span>
          </div>
        ))}
        {filtered.length === 0 && (
          <div style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--text-4)' }}>
            No logs
          </div>
        )}
      </div>
    </div>
  )
}
