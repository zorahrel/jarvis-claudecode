import { useState, useEffect, useCallback } from 'react'
import { Sparkles } from 'lucide-react'
import { navIcons, ArrowUp } from '../icons'
import type { ServiceStatus } from '../api/client'

const navItems = [
  { id: 'overview', label: 'Overview' },
  { id: 'channels', label: 'Channels' },
  { id: 'routes', label: 'Routes' },
  { id: 'agents', label: 'Agents' },
  { id: 'tools', label: 'Tools' },
  { id: 'skills', label: 'Skills' },
  { id: 'cron', label: 'Cron' },
  { id: 'memory', label: 'Memory' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'settings', label: 'Settings' },
  { id: 'logs', label: 'Logs' },
]

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
            <div
              key={item.id}
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
          )
        })}
      </div>

      {/* Footer */}
      <div style={{ padding: '14px 16px', borderTop: '1px solid var(--border)' }}>
        {uptime && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-4)',
              fontFamily: 'var(--mono)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
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
