import type { ReactNode } from 'react'

export interface RelatedItem {
  key: string
  href?: string
  primary: ReactNode
  secondary?: ReactNode
  trailing?: ReactNode
  onClick?: () => void
}

interface RelatedListProps {
  items: RelatedItem[]
  empty?: ReactNode
}

/**
 * Compact vertical list used inside detail panels to surface cross-entity
 * relations (routes using an agent, sessions on a channel, tools used by a
 * cron job, etc). Each row is either an anchor (when `href` is set) or a
 * plain div.
 */
export function RelatedList({ items, empty }: RelatedListProps) {
  if (!items.length) {
    return <div style={{ fontSize: 12, color: 'var(--text-4)' }}>{empty || 'Nothing here'}</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((it) => {
        const body = (
          <>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.primary}
              </div>
              {it.secondary && (
                <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {it.secondary}
                </div>
              )}
            </div>
            {it.trailing && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>{it.trailing}</div>
            )}
          </>
        )
        const baseStyle = {
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          borderRadius: 'var(--radius)',
          background: 'var(--bg-0)',
          border: '1px solid var(--border)',
          textDecoration: 'none',
          color: 'inherit',
          cursor: it.href || it.onClick ? 'pointer' as const : 'default' as const,
        }
        if (it.href) {
          return (
            <a key={it.key} href={it.href} style={baseStyle}>
              {body}
            </a>
          )
        }
        return (
          <div key={it.key} onClick={it.onClick} style={baseStyle}>
            {body}
          </div>
        )
      })}
    </div>
  )
}
