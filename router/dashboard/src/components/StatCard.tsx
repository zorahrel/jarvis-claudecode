import type { ReactNode } from 'react'

interface StatCardProps {
  label: string
  value: string | number
  sub?: string
  tone?: 'default' | 'ok' | 'warn' | 'err'
  icon?: ReactNode
}

const toneColor = {
  default: 'var(--text-1)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  err: 'var(--err)',
}

export function StatCard({ label, value, sub, tone = 'default', icon }: StatCardProps) {
  return (
    <div
      style={{
        background: 'var(--bg-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--text-4)',
            textTransform: 'uppercase',
            letterSpacing: 0.6,
          }}
        >
          {label}
        </span>
        {icon && <span style={{ color: 'var(--text-4)', display: 'inline-flex' }}>{icon}</span>}
      </div>
      <span
        style={{
          fontSize: 26,
          fontWeight: 600,
          fontFamily: 'var(--mono)',
          color: toneColor[tone],
          letterSpacing: -1,
          lineHeight: 1.05,
        }}
      >
        {value}
      </span>
      {sub && (
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{sub}</span>
      )}
    </div>
  )
}
