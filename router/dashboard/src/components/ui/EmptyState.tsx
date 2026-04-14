import type { ReactNode } from 'react'

interface EmptyStateProps {
  title: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  variant?: 'default' | 'dashed'
}

export function EmptyState({ title, hint, icon, action, variant = 'dashed' }: EmptyStateProps) {
  const border = variant === 'dashed' ? '1px dashed var(--border-strong)' : '1px solid var(--border)'
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: 6,
        padding: '40px 16px',
        border,
        borderRadius: 'var(--radius-md)',
        background: variant === 'dashed' ? 'transparent' : 'var(--bg-2)',
      }}
    >
      {icon && <div style={{ color: 'var(--text-4)', marginBottom: 4 }}>{icon}</div>}
      <div style={{ fontSize: 13, color: 'var(--text-2)', fontWeight: 500 }}>{title}</div>
      {hint && (
        <div style={{ fontSize: 12, color: 'var(--text-4)', maxWidth: 420, lineHeight: 1.5 }}>
          {hint}
        </div>
      )}
      {action && <div style={{ marginTop: 10 }}>{action}</div>}
    </div>
  )
}
