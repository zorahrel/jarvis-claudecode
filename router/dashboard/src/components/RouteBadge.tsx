import type { CSSProperties, MouseEvent } from 'react'
import { ChannelIcon } from '../icons'
import { AgentName } from './ui/AgentName'
import { Tooltip } from './ui/Tooltip'

interface RouteBadgeProps {
  channel?: string
  agent?: string
  /** Optional href — when set, the whole badge becomes clickable. */
  href?: string
  onClick?: (e: MouseEvent<HTMLElement>) => void
  title?: string
  size?: 'xs' | 'sm'
  style?: CSSProperties
}

const sizePx: Record<NonNullable<RouteBadgeProps['size']>, { icon: number; gap: number; pad: string }> = {
  xs: { icon: 12, gap: 5, pad: '2px 6px' },
  sm: { icon: 14, gap: 6, pad: '3px 8px' },
}

/**
 * Visual entity for a "route" — the combo of a channel and the agent that
 * handles messages on it. Rendered as a single pill so the eye parses it as
 * one thing, not two separate columns.
 */
export function RouteBadge({
  channel,
  agent,
  href,
  onClick,
  title,
  size = 'sm',
  style,
}: RouteBadgeProps) {
  const dims = sizePx[size]
  const hasRoute = Boolean(channel || agent)

  const content = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: dims.gap,
        padding: dims.pad,
        borderRadius: 'var(--radius-sm)',
        background: hasRoute ? 'var(--surface-hover)' : 'transparent',
        border: hasRoute ? '1px solid var(--border)' : '1px dashed var(--border)',
        fontFamily: 'var(--sans)',
        lineHeight: 1.2,
        maxWidth: '100%',
        overflow: 'hidden',
        ...style,
      }}
    >
      {channel && (
        <span style={{ display: 'inline-flex', color: 'var(--text-3)', flexShrink: 0 }}>
          <ChannelIcon channel={channel} size={dims.icon} color="currentColor" />
        </span>
      )}
      <AgentName name={agent || undefined} size={size === 'sm' ? 'xs' : 'xs'} showIcon={agent === 'jarvis'} />
    </span>
  )

  const node = href ? (
    <a
      href={href}
      onClick={onClick}
      style={{ textDecoration: 'none', display: 'inline-flex', minWidth: 0, maxWidth: '100%' }}
    >
      {content}
    </a>
  ) : content

  if (!title) return node
  return <Tooltip content={title} placement="top">{node}</Tooltip>
}
