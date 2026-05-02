import { AlertTriangle } from 'lucide-react'
import type { CruftResponse, AgentCruft } from '../../api/client'
import { formatTokens } from './thresholds'

interface Props {
  data: CruftResponse | null
}

export function CruftPanel({ data }: Props) {
  if (!data || data.agents.length === 0) {
    return (
      <div style={{ padding: 12, color: 'var(--text-3)', fontSize: 13 }}>
        Nessun cruft rilevato — tutto pulito.
      </div>
    )
  }
  return (
    <div>
      {data.agents.map((a) => (
        <AgentCruftCard key={a.agent} agent={a} />
      ))}
    </div>
  )
}

function AgentCruftCard({ agent }: { agent: AgentCruft }) {
  const mcpUnused = agent.findings.filter((f) => f.kind === 'mcp_unused')
  const skillUnused = agent.findings.filter((f) => f.kind === 'skill_unused')
  if (agent.findings.length === 0) return null

  return (
    <div
      className="rounded-lg p-3 mb-2"
      style={{ background: 'var(--bg-1)', border: '1px solid var(--border)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <AlertTriangle size={14} color="#f97316" />
        <span style={{ fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--text-1)' }}>
          {agent.agent}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {agent.findings.length} elementi caricati ma non usati
        </span>
      </div>

      {mcpUnused.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 6 }}>
          <strong>MCP non chiamati ({mcpUnused.length}):</strong>{' '}
          <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-3)' }}>
            {mcpUnused.map((f) => f.name).join(', ')}
          </span>{' '}
          · stimati {formatTokens(mcpUnused.reduce((s, f) => s + f.loadedTokens, 0))} tok
        </div>
      )}
      {skillUnused.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 6 }}>
          <strong>Skill mai invocate ({skillUnused.length}):</strong>{' '}
          <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-3)' }}>
            {skillUnused.map((f) => f.name).join(', ')}
          </span>
        </div>
      )}

      {agent.suggestions.length > 0 && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-2)',
              marginBottom: 4,
            }}
          >
            💡 Suggerimenti
          </div>
          {agent.suggestions.map((s) => (
            <div
              key={s.id}
              style={{
                fontSize: 12,
                color: 'var(--text-2)',
                marginBottom: 6,
                paddingLeft: 8,
              }}
            >
              <div style={{ fontWeight: 600 }}>{s.action}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                {s.rationale}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
