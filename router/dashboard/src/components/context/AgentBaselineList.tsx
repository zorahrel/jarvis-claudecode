import { useEffect, useState } from 'react'
import { ChevronRight, ChevronDown, AlertTriangle, Info, AlertCircle } from 'lucide-react'
import { api } from '../../api/client'
import type { AgentBaseline } from '../../api/client'
import { formatTokens, colorForThreshold } from './thresholds'
import { BreakdownStackedBar } from './BreakdownStackedBar'

/**
 * Static baseline list of agent templates. NO live data, NO polling.
 *
 * For each agent.yaml under ~/.claude/jarvis/agents/, shows:
 *   - baseline token cost (the spawn-time floor before any user turn)
 *   - model, fullAccess, inheritUserScope, tools count
 *   - drill-down: 8-category stacked bar with MCP + CLAUDE.md detail
 *   - cruft hints derived from config (no live tool_use needed)
 *
 * This is the headline view of the Context tab — answers
 * "quanto pesa ogni agent template prima di parlare e dove c'è cruft?".
 */

const SEVERITY_COLOR: Record<string, string> = {
  info: '#3b82f6',
  warn: '#eab308',
  crit: '#ef4444',
}

const SEVERITY_ICON: Record<string, typeof Info> = {
  info: Info,
  warn: AlertTriangle,
  crit: AlertCircle,
}

export function AgentBaselineList() {
  const [agents, setAgents] = useState<AgentBaseline[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetch = async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await api.agentsBaseline()
      setAgents(r.agents)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'errore')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetch()
  }, [])

  if (loading && !agents) {
    return (
      <div style={{ padding: 24, color: 'var(--text-3)', fontSize: 13 }}>
        Analisi baseline agenti...
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: 24, color: '#ef4444', fontSize: 13 }}>
        Errore: {error}
        <button onClick={fetch} style={{ marginLeft: 12 }}>
          Riprova
        </button>
      </div>
    )
  }

  if (!agents || agents.length === 0) {
    return (
      <div style={{ padding: 24, color: 'var(--text-3)', fontSize: 13 }}>
        Nessun agente trovato in ~/.claude/jarvis/agents/.
      </div>
    )
  }

  // Aggregate stats
  const total = agents.reduce((s, a) => s + a.breakdown.totalEstimated, 0)
  const heaviest = agents[0]
  const lightest = agents[agents.length - 1]

  return (
    <div>
      {/* Summary header */}
      <div
        style={{
          padding: 16,
          marginBottom: 16,
          background: 'var(--bg-1)',
          border: '1px solid var(--border)',
          borderRadius: 8,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-3)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            marginBottom: 4,
          }}
        >
          Baseline statico — token alla nascita di ogni agente
        </div>
        <div style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 600, fontFamily: 'var(--mono)' }}>
              {agents.length} agenti
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: 10,
                color: 'var(--text-3)',
                textTransform: 'uppercase',
              }}
            >
              Più pesante
            </div>
            <div style={{ fontSize: 13, fontFamily: 'var(--mono)' }}>
              {heaviest.agent} ·{' '}
              <strong>{formatTokens(heaviest.breakdown.totalEstimated)}</strong>
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: 10,
                color: 'var(--text-3)',
                textTransform: 'uppercase',
              }}
            >
              Più leggero
            </div>
            <div style={{ fontSize: 13, fontFamily: 'var(--mono)' }}>
              {lightest.agent} ·{' '}
              <strong>{formatTokens(lightest.breakdown.totalEstimated)}</strong>
            </div>
          </div>
          <div>
            <div
              style={{
                fontSize: 10,
                color: 'var(--text-3)',
                textTransform: 'uppercase',
              }}
            >
              Totale
            </div>
            <div style={{ fontSize: 13, fontFamily: 'var(--mono)' }}>{formatTokens(total)}</div>
          </div>
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-4)',
            marginTop: 8,
            fontStyle: 'italic',
          }}
        >
          Stima conservativa (chars/4 + costanti per system/tools/MCP/skills). Click su un
          agente per vedere il breakdown 8-categorie e i suggerimenti cruft.
        </div>
      </div>

      {/* Agent rows */}
      {agents.map((a) => (
        <AgentRow key={a.agent} agent={a} />
      ))}
    </div>
  )
}

function AgentRow({ agent }: { agent: AgentBaseline }) {
  const [expanded, setExpanded] = useState(false)
  const total = agent.breakdown.totalEstimated
  // Use a synthetic ratio against a 200k window for color (purely informational).
  const ratio = Math.min(1, total / 200000)
  const color = colorForThreshold(ratio)
  const mcpCat = agent.breakdown.categories.find((c) => c.category === 'mcp_servers')
  const mcpCount = Array.isArray(mcpCat?.details) ? (mcpCat!.details as unknown[]).length : 0

  return (
    <div
      className="rounded-lg p-3 mb-2"
      style={{ background: 'var(--bg-1)', border: '1px solid var(--border)' }}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          cursor: 'pointer',
          flexWrap: 'wrap',
        }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span
          style={{
            fontFamily: 'var(--mono)',
            fontWeight: 600,
            color: 'var(--text-1)',
            minWidth: 90,
          }}
        >
          {agent.agent}
        </span>

        {/* Pill: model */}
        <span
          style={{
            padding: '2px 8px',
            borderRadius: 999,
            background: 'var(--bg-0)',
            fontSize: 10,
            fontFamily: 'var(--mono)',
            color: 'var(--text-2)',
          }}
        >
          {agent.model}
        </span>

        {/* Flags */}
        {agent.fullAccess && (
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              background: 'rgba(239,68,68,0.15)',
              fontSize: 10,
              fontFamily: 'var(--mono)',
              color: '#ef4444',
            }}
          >
            fullAccess
          </span>
        )}
        {agent.inheritUserScope && (
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              background: 'rgba(234,179,8,0.15)',
              fontSize: 10,
              fontFamily: 'var(--mono)',
              color: '#eab308',
            }}
          >
            inheritUserScope
          </span>
        )}

        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--text-3)',
          }}
        >
          {mcpCount} MCP · {agent.tools.length} tools
        </span>

        {/* Mini bar */}
        <div
          title={`${formatTokens(total)} su 200k window`}
          style={{
            flex: 1,
            minWidth: 100,
            height: 6,
            background: 'var(--bg-0)',
            borderRadius: 3,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${Math.max(2, ratio * 100)}%`,
              height: '100%',
              background: color,
            }}
          />
        </div>

        <span
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--text-1)',
            minWidth: 70,
            textAlign: 'right',
          }}
        >
          {formatTokens(total)}
        </span>

        {agent.cruftHints.length > 0 && (
          <span
            title={`${agent.cruftHints.length} cruft hints`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              color: '#eab308',
              fontFamily: 'var(--mono)',
            }}
          >
            <AlertTriangle size={12} />
            {agent.cruftHints.length}
          </span>
        )}
      </div>

      {expanded && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: '1px solid var(--border)',
          }}
        >
          {/* Cruft hints */}
          {agent.cruftHints.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--text-2)',
                  marginBottom: 6,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}
              >
                💡 Cruft hints
              </div>
              {agent.cruftHints.map((h) => {
                const Icon = SEVERITY_ICON[h.severity]
                return (
                  <div
                    key={h.id}
                    style={{
                      display: 'flex',
                      gap: 8,
                      padding: 8,
                      marginBottom: 4,
                      background: 'var(--bg-0)',
                      borderRadius: 6,
                      fontSize: 12,
                      color: 'var(--text-2)',
                    }}
                  >
                    <Icon size={14} color={SEVERITY_COLOR[h.severity]} style={{ flexShrink: 0, marginTop: 2 }} />
                    <div style={{ flex: 1 }}>
                      <div>{h.message}</div>
                      {h.potentialSavingsTokens && (
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--text-3)',
                            fontFamily: 'var(--mono)',
                            marginTop: 2,
                          }}
                        >
                          Risparmio potenziale: ~{formatTokens(h.potentialSavingsTokens)} tok
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Breakdown */}
          <BreakdownStackedBar
            breakdown={{
              sessionId: `baseline:${agent.agent}`,
              sessionKey: null,
              agent: agent.agent,
              liveTotal: total,
              categories: agent.breakdown.categories,
              totalEstimated: agent.breakdown.totalEstimated,
            }}
          />

          {/* Tools list */}
          {agent.tools.length > 0 && (
            <div
              style={{
                marginTop: 12,
                padding: 8,
                background: 'var(--bg-0)',
                borderRadius: 6,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--text-2)',
                  marginBottom: 4,
                }}
              >
                Tools dichiarati ({agent.tools.length})
              </div>
              <div
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  color: 'var(--text-3)',
                }}
              >
                {agent.tools.join(' · ')}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
