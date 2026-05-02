import type { SessionBreakdown } from '../../api/client'
import { formatTokens } from './thresholds'

const CATEGORY_LABELS: Record<string, string> = {
  system_preset: 'System preset',
  builtin_tools: 'Tool integrati',
  mcp_servers: 'MCP servers',
  skills_index: 'Skills index',
  claudemd_chain: 'CLAUDE.md chain',
  subagents: 'Subagents',
  hooks_memory: 'Hooks/Memory',
  history: 'Conversation history',
}

const CATEGORY_COLORS: Record<string, string> = {
  system_preset: '#64748b',
  builtin_tools: '#0ea5e9',
  mcp_servers: '#f59e0b',
  skills_index: '#a855f7',
  claudemd_chain: '#10b981',
  subagents: '#ec4899',
  hooks_memory: '#6366f1',
  history: '#94a3b8',
}

interface Props {
  breakdown: SessionBreakdown
}

export function BreakdownStackedBar({ breakdown }: Props) {
  const total = Math.max(1, breakdown.totalEstimated)
  return (
    <div>
      <div
        style={{
          display: 'flex',
          height: 12,
          borderRadius: 6,
          overflow: 'hidden',
          marginBottom: 12,
        }}
      >
        {breakdown.categories.map((c) => {
          const pct = (c.tokens / total) * 100
          if (pct < 0.5) return null
          return (
            <div
              key={c.category}
              title={`${CATEGORY_LABELS[c.category]}: ${formatTokens(c.tokens)} (${pct.toFixed(1)}%)`}
              style={{ width: `${pct}%`, background: CATEGORY_COLORS[c.category] }}
            />
          )
        })}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '4px 12px',
          fontFamily: 'var(--mono)',
          fontSize: 11,
        }}
      >
        {breakdown.categories.map((c) => {
          const pct = (c.tokens / total) * 100
          return (
            <div key={c.category} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: CATEGORY_COLORS[c.category],
                  flexShrink: 0,
                }}
              />
              <span style={{ color: 'var(--text-2)', flex: 1 }}>
                {CATEGORY_LABELS[c.category]}
              </span>
              <span style={{ color: 'var(--text-1)', fontWeight: 600 }}>
                {formatTokens(c.tokens)}
              </span>
              <span style={{ color: 'var(--text-3)', minWidth: 36, textAlign: 'right' }}>
                {pct.toFixed(0)}%
              </span>
            </div>
          )
        })}
      </div>

      {breakdown.categories
        .filter((c) => c.category === 'mcp_servers' && Array.isArray(c.details))
        .map((c) => (
          <div
            key="mcp-drill"
            style={{ marginTop: 12, padding: 8, background: 'var(--bg-0)', borderRadius: 6 }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--text-2)',
                marginBottom: 4,
              }}
            >
              MCP servers ({(c.details as unknown[]).length})
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 4,
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: 'var(--text-3)',
              }}
            >
              {(c.details as Array<{ name: string; transport: string; tokens: number }>).map(
                (d) => (
                  <div key={d.name}>
                    {d.name} <span style={{ color: 'var(--text-4)' }}>({d.transport})</span>
                  </div>
                ),
              )}
            </div>
          </div>
        ))}

      {breakdown.categories
        .filter((c) => c.category === 'claudemd_chain' && Array.isArray(c.details))
        .map((c) => (
          <div
            key="claudemd-drill"
            style={{ marginTop: 8, padding: 8, background: 'var(--bg-0)', borderRadius: 6 }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--text-2)',
                marginBottom: 4,
              }}
            >
              CLAUDE.md @-imports
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-3)' }}>
              {(c.details as Array<{ path: string; tokens: number; isRoot: boolean }>).map((d) => (
                <div key={d.path}>
                  {d.isRoot ? '▸' : ' '} {d.path.replace(/^\/Users\/[^/]+/, '~')}{' '}
                  <span style={{ color: 'var(--text-4)' }}>{formatTokens(d.tokens)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
    </div>
  )
}
