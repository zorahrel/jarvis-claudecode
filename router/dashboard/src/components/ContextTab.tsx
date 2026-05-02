import { RefreshCw } from 'lucide-react'
import { useContextPolling } from '../hooks/useContextPolling'
import { AggregateHeader } from './context/AggregateHeader'
import { SessionRow } from './context/SessionRow'
import { CruftPanel } from './context/CruftPanel'
import { RecentSessionsList } from './context/RecentSessionsList'
import { DiskHygieneFooter } from './context/DiskHygieneFooter'

export default function ContextTab() {
  const { data, cruft, loading, error, refresh, lastFetchedAt } = useContextPolling(5000)

  if (loading && !data) {
    return (
      <div style={{ padding: 24, color: 'var(--text-3)' }}>
        Caricamento context inspector...
      </div>
    )
  }

  if (error && !data) {
    return (
      <div style={{ padding: 24, color: '#ef4444' }}>
        Errore: {error}
        <button onClick={refresh} style={{ marginLeft: 12 }}>
          Riprova
        </button>
      </div>
    )
  }

  if (!data) return null

  const ageSec = lastFetchedAt
    ? Math.max(0, Math.floor((Date.now() - lastFetchedAt) / 1000))
    : null

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>🧠 Context Inspector</h2>
        {error && (
          <span style={{ marginLeft: 12, fontSize: 11, color: '#ef4444' }}>
            ultimo fetch fallito: {error}
          </span>
        )}
        {ageSec !== null && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 10,
              color: 'var(--text-4)',
              marginRight: 8,
            }}
          >
            aggiornato {ageSec}s fa
          </span>
        )}
        <button
          onClick={refresh}
          disabled={loading}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 10px',
            background: 'var(--bg-1)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            cursor: 'pointer',
          }}
        >
          <RefreshCw size={12} />
          <span style={{ fontSize: 11 }}>Aggiorna</span>
        </button>
      </div>

      <AggregateHeader aggregate={data.aggregate} disk={data.disk} />

      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-2)',
            marginBottom: 8,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          Sessioni live
        </div>
        {data.sessions.length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: 13, padding: 12 }}>
            Nessuna sessione attiva.
          </div>
        ) : (
          data.sessions.map((s) => <SessionRow key={s.pid} session={s} />)
        )}
      </div>

      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-2)',
            marginBottom: 8,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          💡 Cruft / da pulire
        </div>
        <CruftPanel data={cruft} />
      </div>

      <RecentSessionsList sessions={data.recent} />
      <DiskHygieneFooter disk={data.disk} />
    </div>
  )
}
