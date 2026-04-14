import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: ReactNode
  count?: ReactNode
  description?: ReactNode
  actions?: ReactNode
}

export function PageHeader({ title, count, description, actions }: PageHeaderProps) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: description ? 'flex-start' : 'center',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
        marginBottom: 4,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <h1 className="page-title" style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span>{title}</span>
          {count !== undefined && count !== null && (
            <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-4)' }}>{count}</span>
          )}
        </h1>
        {description && (
          <p style={{ fontSize: 12, color: 'var(--text-3)', margin: 0, lineHeight: 1.5, maxWidth: 640 }}>
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {actions}
        </div>
      )}
    </header>
  )
}

interface SectionHeaderProps {
  title: ReactNode
  count?: ReactNode
  action?: ReactNode
}

export function SectionHeader({ title, count, action }: SectionHeaderProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 10,
        gap: 8,
      }}
    >
      <h2
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-4)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          margin: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span>{title}</span>
        {count !== undefined && count !== null && (
          <span style={{ fontWeight: 400, letterSpacing: 0, textTransform: 'none' }}>· {count}</span>
        )}
      </h2>
      {action}
    </div>
  )
}
