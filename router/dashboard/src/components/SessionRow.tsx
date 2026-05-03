import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import type { ProcessSession } from '../api/client'
import { ChannelIcon } from '../icons'
import { AgentName } from './ui/AgentName'
import { Badge } from './ui/Badge'
import { BadgeLink } from './BadgeLink'

interface SessionRowProps {
  session: ProcessSession
  onClick?: (s: ProcessSession, e: MouseEvent<HTMLDivElement>) => void
  trailing?: ReactNode
  isLast?: boolean
}

function short(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s
}

function fmtDuration(ms: number): string {
  if (ms == null || ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

const tintedRow: CSSProperties = {
  background: 'linear-gradient(90deg, var(--jarvis-tint) 0%, transparent 35%)',
}

const tintedRowHover: CSSProperties = {
  background: 'linear-gradient(90deg, var(--jarvis-tint-strong) 0%, var(--bg-2) 40%)',
}

/**
 * Compact row that renders a ProcessSession with the same visual grammar as
 * Routes.tsx list rows: channel icon on the left, channel/target label in the
 * middle, agent on the right, metric badges trailing. Used by Overview preview
 * and anywhere else a session needs to be shown as an entity-in-list.
 */
export function SessionRow({ session: p, onClick, trailing, isLast }: SessionRowProps) {
  const isJarvis = p.agentName === 'jarvis'
  const targetLabel = p.targetLabel || p.target || ''

  return (
    <div
      onClick={onClick ? (e) => onClick(p, e) : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        cursor: onClick ? 'pointer' : 'default',
        padding: '10px 14px',
        borderBottom: isLast ? 'none' : '1px solid var(--border)',
        background: isJarvis ? tintedRow.background : 'transparent',
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = isJarvis
          ? (tintedRowHover.background as string)
          : 'var(--bg-2)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = isJarvis
          ? (tintedRow.background as string)
          : 'transparent'
      }}
    >
      <span
        style={{
          width: 22,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: p.alive ? 'var(--ok)' : 'var(--err)',
        }}
        title={p.alive ? (p.pending ? 'Processing' : 'Alive') : 'Dead'}
      >
        {p.channel
          ? <ChannelIcon channel={p.channel} size={18} color="currentColor" />
          : (
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: p.alive ? 'var(--ok)' : 'var(--err)',
                boxShadow: p.alive ? '0 0 6px var(--ok)' : '0 0 6px var(--err)',
              }}
            />
          )}
      </span>

      <div style={{ width: 320, minWidth: 0, overflow: 'hidden' }}>
        <div
          title={targetLabel || p.key}
          style={{
            fontSize: 12,
            color: 'var(--text-2)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {short(targetLabel || p.key, 48)}
        </div>
        <div
          style={{
            fontSize: 10,
            color: 'var(--text-4)',
            fontFamily: 'var(--mono)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {p.channel || 'cli'} · {p.model}
        </div>
      </div>

      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-4)', width: 16, textAlign: 'center' }}>→</span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <AgentName name={p.agentName || undefined} size="xs" />
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {p.pending && <Badge tone="ok" size="xs">processing</Badge>}
        {p.messageCount > 0 && (
          <BadgeLink
            href={`/sessions?filter=key:${encodeURIComponent(p.key)}`}
            tone="muted"
            size="xs"
            count={p.messageCount}
            label="turns"
            title="Open session in Sessions view"
            stopPropagation
          />
        )}
        {p.estimatedTokens > 0 && (
          <Badge tone="muted" size="xs" title={`~${p.estimatedTokens.toLocaleString()} tokens`}>
            ~{(p.estimatedTokens / 1000).toFixed(0)}k tok
          </Badge>
        )}
        {p.costUsd > 0 && (
          <Badge tone="muted" size="xs" title="Cumulative cost">
            ${p.costUsd.toFixed(3)}
          </Badge>
        )}
        <Badge tone="muted" size="xs" title={`Up ${fmtDuration(p.uptime)} · idle ${fmtDuration(p.idleTime)}`}>
          {fmtDuration(p.uptime)}
        </Badge>
        {trailing}
      </div>
    </div>
  )
}
