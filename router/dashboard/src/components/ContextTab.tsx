import { AgentBaselineList } from './context/AgentBaselineList'

/**
 * Context Inspector — STATIC config view.
 *
 * Shows the spawn-time baseline cost of every agent template under
 * ~/.claude/jarvis/agents/, with cruft hints derived from the config alone.
 *
 * Live session inspection moved to: any session card in the dashboard now has
 * an "Esplora" button → opens <SessionContextExplorer /> with the same
 * per-session breakdown view.
 */
export default function ContextTab() {
  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>🧠 Context Inspector</h2>
        <p style={{ margin: '4px 0 0 0', fontSize: 12, color: 'var(--text-3)' }}>
          Quanto pesa ogni agente prima di parlare. Per le sessioni live → tab Sessions, click "Esplora" su una card.
        </p>
      </div>
      <AgentBaselineList />
    </div>
  )
}
