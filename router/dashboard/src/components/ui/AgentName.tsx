import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { Tooltip } from './Tooltip'

interface AgentNameProps {
  name: string | undefined | null
  size?: 'xs' | 'sm' | 'md'
  showIcon?: boolean
  onClick?: (e: MouseEvent<HTMLSpanElement>) => void
  style?: CSSProperties
  suffix?: ReactNode
}

const sizePx: Record<NonNullable<AgentNameProps['size']>, { font: number; icon: number; gap: number }> = {
  xs: { font: 10, icon: 11, gap: 3 },
  sm: { font: 12, icon: 12, gap: 4 },
  md: { font: 13, icon: 14, gap: 5 },
}

export function AgentName({
  name,
  size = 'sm',
  showIcon = true,
  onClick,
  style,
  suffix,
}: AgentNameProps) {
  const display = name || '(unrouted)'
  const isJarvis = name === 'jarvis'
  const dims = sizePx[size]

  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: dims.gap,
    fontFamily: 'var(--mono)',
    fontSize: dims.font,
    fontWeight: 600,
    cursor: onClick ? 'pointer' : undefined,
    lineHeight: 1.2,
    ...style,
  }

  if (isJarvis) {
    return (
      <Tooltip content="jarvis — orchestrator" placement="top">
        <span onClick={onClick} style={base}>
          {showIcon && (
            <Sparkles
              size={dims.icon}
              strokeWidth={2.2}
              style={{ color: 'var(--accent-bright)', filter: 'drop-shadow(0 0 4px rgba(113,112,255,0.6))' }}
            />
          )}
          <span className="jarvis-text">{display}</span>
          {suffix}
        </span>
      </Tooltip>
    )
  }

  const color = name ? 'var(--text-1)' : 'var(--text-4)'
  return (
    <span
      onClick={onClick}
      style={{
        ...base,
        color,
        textDecoration: onClick ? 'underline' : 'none',
        textDecorationColor: 'var(--text-4)',
        textUnderlineOffset: 2,
      }}
    >
      {display}
      {suffix}
    </span>
  )
}
