import { useState, useEffect, useCallback } from 'react'
import { Sparkles } from 'lucide-react'
import { navIcons, ArrowUp } from '../icons'
import type { ServiceStatus } from '../api/client'
import { useRealtimeStatus } from '../hooks/usePolling'
import { Tooltip } from './ui/Tooltip'

const navItems: { id: string; label: string; hint: string }[] = [
  { id: 'overview',  label: 'Overview',  hint: 'Live status of channels, sessions, and performance' },
  { id: 'channels',  label: 'Channels',  hint: 'Telegram, WhatsApp, Discord — connection status and config' },
  { id: 'routes',    label: 'Routes',    hint: 'Channel → agent mappings that dispatch incoming messages' },
  { id: 'agents',    label: 'Agents',    hint: 'Agent definitions, models, capabilities, and workspaces' },
  { id: 'tools',     label: 'Tools',     hint: 'Tools exposed to agents via MCP and built-ins' },
  { id: 'skills',    label: 'Skills',    hint: 'Installed Claude Code skills and plugin marketplaces' },
  { id: 'cron',      label: 'Cron',      hint: 'Scheduled jobs that trigger agents on a recurring timer' },
  { id: 'memory',    label: 'Memory',    hint: 'Memory graph — documents and conversation memory' },
  { id: 'sessions',  label: 'Sessions',  hint: 'Active and historical conversations across channels' },
  { id: 'analytics', label: 'Analytics', hint: 'Message volume, costs, and response-time trends' },
  { id: 'settings',  label: 'Settings',  hint: 'Router, hooks, and MCP server configuration' },
  { id: 'logs',      label: 'Logs',      hint: 'Live router log stream' },
]

const LIVE_KEYFRAMES = `@keyframes jarvisLivePulse {
  0% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(1.4); }
  100% { opacity: 1; transform: scale(1); }
}`

function LiveIndicator() {
  const { connected, lastEventAt } = useRealtimeStatus()
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const sinceSec = lastEventAt ? Math.max(0, Math.floor((Date.now() - lastEventAt) / 1000)) : null
  const title = connected
    ? lastEventAt
      ? `WebSocket connected · last event ${sinceSec}s ago`
      : 'WebSocket connected · waiting for first event'
    : 'WebSocket disconnected — falling back to polling'
  return (
    <>
      <style>{LIVE_KEYFRAMES}</style>
      <Tooltip content={title} placement="right">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 10,
            fontFamily: 'var(--mono)',
            color: connected ? 'var(--ok)' : 'var(--text-4)',
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              flexShrink: 0,
              background: connected ? 'var(--ok)' : 'var(--text-4)',
              boxShadow: connected ? '0 0 6px var(--ok)' : 'none',
              animation: connected ? 'jarvisLivePulse 1.4s ease-in-out infinite' : 'none',
            }}
          />
          <span>{connected ? 'LIVE' : 'polling'}</span>
          {connected && sinceSec !== null && (
            <span style={{ color: 'var(--text-4)', marginLeft: 'auto' }}>{sinceSec}s</span>
          )}
        </div>
      </Tooltip>
    </>
  )
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${s % 60}s`
}

interface SidebarProps {
  active: string
  onChange: (id: string) => void
}

export function Sidebar({ active, onChange }: SidebarProps) {
  const [uptime, setUptime] = useState('')
  const [services, setServices] = useState<ServiceStatus[]>([])

  const fetchFooter = useCallback(async () => {
    try {
      const [statsRes, svcRes] = await Promise.all([
        fetch('/api/stats').then(r => r.json()),
        fetch('/api/services').then(r => r.json()),
      ])
      setUptime(statsRes.uptime || formatUptime(statsRes.uptimeMs || 0))
      setServices(svcRes || [])
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchFooter()
    const t = setInterval(fetchFooter, 30000)
    return () => clearInterval(t)
  }, [fetchFooter])

  return (
    <nav
      data-sidebar-root
      className="sidebar-nav"
      style={{
        width: 220,
        background: 'var(--bg-0)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        height: '100vh',
        position: 'sticky',
        top: 0,
      }}
    >
      {/* Brand */}
      <div style={{ padding: '20px 16px 18px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--jarvis-gradient)',
            boxShadow: '0 0 14px rgba(113,112,255,0.35)',
          }}
        >
          <Sparkles size={14} color="#fff" strokeWidth={2.2} />
        </span>
        <span
          style={{
            fontFamily: 'var(--sans)',
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--text-1)',
            letterSpacing: -0.2,
          }}
        >
          Jarvis
        </span>
        <span style={{ color: 'var(--text-4)', fontSize: 10, marginLeft: 'auto', fontFamily: 'var(--mono)' }}>
          v3.2
        </span>
      </div>

      {/* Nav */}
      <div style={{ flex: 1, padding: '4px 8px', overflowY: 'auto' }}>
        {navItems.map((item) => {
          const isActive = active === item.id
          return (
            <Tooltip key={item.id} content={item.hint} placement="right">
            <div
              onClick={() => onChange(item.id)}
              className="nav-item"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '7px 10px',
                fontSize: 13,
                fontWeight: 500,
                color: isActive ? 'var(--text-1)' : 'var(--text-3)',
                cursor: 'pointer',
                borderRadius: 'var(--radius)',
                marginBottom: 2,
                transition: 'background 0.15s, color 0.15s',
                userSelect: 'none',
                background: isActive ? 'var(--accent-tint-strong)' : 'transparent',
                position: 'relative',
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  e.currentTarget.style.color = 'var(--text-1)'
                  e.currentTarget.style.background = 'var(--surface-hover)'
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  e.currentTarget.style.color = 'var(--text-3)'
                  e.currentTarget.style.background = 'transparent'
                }
              }}
            >
              <span
                className="nav-icon"
                style={{
                  width: 16,
                  height: 16,
                  opacity: isActive ? 1 : 0.7,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  color: isActive ? 'var(--accent-bright)' : 'currentColor',
                }}
              >
                {navIcons[item.id]?.({ size: 16 })}
              </span>
              <span className="nav-label">{item.label}</span>
            </div>
            </Tooltip>
          )
        })}
      </div>

      {/* Footer */}
      <div style={{ padding: '14px 16px', borderTop: '1px solid var(--border)' }}>
        <LiveIndicator />
        {uptime && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-4)',
              fontFamily: 'var(--mono)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              marginTop: 6,
            }}
          >
            <ArrowUp size={11} style={{ display: 'inline-block' }} />
            <span>{uptime}</span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          {services.map((svc) => (
            <div
              key={svc.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 10,
                color: 'var(--text-4)',
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: svc.status === 'ok' ? 'var(--ok)' : 'var(--err)',
                }}
              />
              <span>{svc.name}</span>
            </div>
          ))}
        </div>
      </div>
    </nav>
  )
}
