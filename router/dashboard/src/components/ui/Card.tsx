import type { CSSProperties, ReactNode, MouseEvent } from 'react'

interface CardProps {
  children: ReactNode
  interactive?: boolean
  active?: boolean
  tone?: 'default' | 'jarvis'
  padding?: number | string
  onClick?: (e: MouseEvent<HTMLDivElement>) => void
  style?: CSSProperties
  className?: string
  as?: 'div' | 'article' | 'section'
}

export function Card({
  children,
  interactive = false,
  active = false,
  tone = 'default',
  padding = 16,
  onClick,
  style,
  className,
  as = 'div',
}: CardProps) {
  const Tag = as
  const base: CSSProperties = {
    background: tone === 'jarvis' ? 'linear-gradient(135deg, var(--jarvis-tint) 0%, transparent 60%), var(--bg-2)' : 'var(--bg-2)',
    border: `1px solid ${active ? 'var(--accent)' : tone === 'jarvis' ? 'var(--jarvis-border)' : 'var(--border)'}`,
    borderRadius: 'var(--radius-md)',
    padding,
    boxShadow: tone === 'jarvis' ? 'var(--jarvis-glow)' : undefined,
    transition: 'border-color 0.15s, box-shadow 0.15s',
    cursor: interactive ? 'pointer' : undefined,
    ...style,
  }
  const onEnter = interactive
    ? (e: MouseEvent<HTMLDivElement>) => {
        if (tone === 'jarvis') return
        e.currentTarget.style.borderColor = 'var(--accent)'
      }
    : undefined
  const onLeave = interactive && !active
    ? (e: MouseEvent<HTMLDivElement>) => {
        if (tone === 'jarvis') return
        e.currentTarget.style.borderColor = 'var(--border)'
      }
    : undefined
  return (
    <Tag
      style={base}
      onClick={onClick}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className={className}
    >
      {children}
    </Tag>
  )
}
