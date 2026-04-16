import type { CSSProperties, ReactNode, MouseEvent } from 'react'
import { Tooltip } from './Tooltip'

type Tone = 'neutral' | 'ok' | 'warn' | 'err' | 'accent' | 'jarvis' | 'muted'
type Size = 'xs' | 'sm'

interface BadgeProps {
  tone?: Tone
  size?: Size
  mono?: boolean
  uppercase?: boolean
  children: ReactNode
  title?: string
  onClick?: (e: MouseEvent<HTMLSpanElement>) => void
  style?: CSSProperties
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

const sizeStyle: Record<Size, CSSProperties> = {
  xs: { fontSize: 9, padding: '1px 6px', borderRadius: 'var(--radius-xs)', letterSpacing: 0.2 },
  sm: { fontSize: 10, padding: '2px 7px', borderRadius: 'var(--radius-sm)', letterSpacing: 0.2 },
}

export function Badge({
  tone = 'neutral',
  size = 'sm',
  mono = false,
  uppercase = false,
  children,
  title,
  onClick,
  style,
}: BadgeProps) {
  const span = (
    <span
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        lineHeight: 1.2,
        fontFamily: mono ? 'var(--mono)' : 'var(--sans)',
        textTransform: uppercase ? 'uppercase' : 'none',
        cursor: onClick ? 'pointer' : 'default',
        fontWeight: 500,
        ...toneStyle[tone],
        ...sizeStyle[size],
        ...style,
      }}
    >
      {children}
    </span>
  )
  if (!title) return span
  return <Tooltip content={title} placement="top">{span}</Tooltip>
}
