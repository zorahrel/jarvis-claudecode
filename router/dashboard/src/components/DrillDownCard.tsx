import { useState, type ReactNode } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { Tooltip } from './ui/Tooltip'

interface DrillDownCardProps {
  label: string
  value: string | number
  sub?: string
  /** Hash destination (without leading `#`). Clicking the card navigates here. */
  href?: string
  /** Tooltip shown on hover — explains what the card drills into. */
  title?: string
  tone?: 'default' | 'ok' | 'warn' | 'err'
  icon?: ReactNode
}

const toneColor = {
  default: 'var(--text-1)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  err: 'var(--err)',
}

export function DrillDownCard({ label, value, sub, href, title, tone = 'default', icon }: DrillDownCardProps) {
  const [hover, setHover] = useState(false)
  const clickable = !!href

  const body = (
    <>
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
        {icon
          ? <span style={{ color: 'var(--text-4)', display: 'inline-flex' }}>{icon}</span>
          : clickable && (
              <span
                style={{
                  color: hover ? 'var(--accent-bright)' : 'var(--text-4)',
                  display: 'inline-flex',
                  transition: 'color 120ms',
                }}
              >
                <ArrowUpRight size={12} />
              </span>
            )}
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
      {sub && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{sub}</span>}
    </>
  )

  const baseStyle = {
    background: 'var(--bg-2)',
    border: `1px solid ${hover && clickable ? 'var(--accent-border)' : 'var(--border)'}`,
    borderRadius: 'var(--radius-md)',
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
    minWidth: 0,
    transition: 'border-color 120ms, transform 120ms',
    transform: hover && clickable ? 'translateY(-1px)' : 'none',
  }

  const node = clickable ? (
    <a
      href={href.startsWith('/') || href.startsWith('#') ? href : `/${href}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...baseStyle, cursor: 'pointer', textDecoration: 'none', color: 'inherit' }}
    >
      {body}
    </a>
  ) : (
    <div style={baseStyle}>{body}</div>
  )

  if (!title) return node
  return <Tooltip content={title} placement="top">{node}</Tooltip>
}
