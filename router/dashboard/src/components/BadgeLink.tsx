import type { CSSProperties, MouseEvent, ReactNode } from 'react'

type Tone = 'neutral' | 'ok' | 'warn' | 'err' | 'accent' | 'jarvis' | 'muted'

interface BadgeLinkProps {
  href: string
  tone?: Tone
  label: ReactNode
  count?: number | string
  title?: string
  size?: 'xs' | 'sm'
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void
  style?: CSSProperties
  stopPropagation?: boolean
}

const toneStyle: Record<Tone, CSSProperties> = {
  neutral: { background: 'var(--surface-hover)', color: 'var(--text-3)', border: '1px solid var(--border)' },
  muted: { background: 'var(--surface-subtle)', color: 'var(--text-4)', border: '1px solid var(--border)' },
  ok: { background: 'var(--ok-tint)', color: 'var(--ok)', border: '1px solid var(--ok-border)' },
  warn: { background: 'var(--warn-tint)', color: 'var(--warn)', border: '1px solid var(--warn-border)' },
  err: { background: 'var(--err-tint)', color: 'var(--err)', border: '1px solid var(--err-border)' },
  accent: { background: 'var(--accent-tint)', color: 'var(--accent-bright)', border: '1px solid var(--accent-border)' },
  jarvis: { background: 'var(--jarvis-tint-strong)', color: 'var(--accent-bright)', border: '1px solid var(--jarvis-border)' },
}

const sizeStyle: Record<'xs' | 'sm', CSSProperties> = {
  xs: { fontSize: 9, padding: '1px 6px', borderRadius: 'var(--radius-xs)', letterSpacing: 0.2 },
  sm: { fontSize: 10, padding: '2px 7px', borderRadius: 'var(--radius-sm)', letterSpacing: 0.2 },
}

/**
 * Clickable badge that navigates via hash. Looks like `<Badge>` but is an
 * anchor so middle-click / cmd-click open in a new tab too.
 */
export function BadgeLink({
  href,
  tone = 'neutral',
  label,
  count,
  title,
  size = 'sm',
  onClick,
  style,
  stopPropagation,
}: BadgeLinkProps) {
  return (
    <a
      href={href}
      title={title}
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation()
        onClick?.(e)
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        lineHeight: 1.2,
        fontFamily: 'var(--sans)',
        fontWeight: 500,
        textDecoration: 'none',
        cursor: 'pointer',
        ...toneStyle[tone],
        ...sizeStyle[size],
        ...style,
      }}
    >
      {count !== undefined && count !== null && (
        <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{count}</span>
      )}
      <span>{label}</span>
    </a>
  )
}
