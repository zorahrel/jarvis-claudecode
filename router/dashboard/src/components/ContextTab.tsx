import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '../api/client'
import type { ContextSessionsResponse, CruftResponse } from '../api/client'
import { AggregateHeader } from './context/AggregateHeader'
import { SessionRow } from './context/SessionRow'
import { CruftPanel } from './context/CruftPanel'
import { RecentSessionsList } from './context/RecentSessionsList'
import { DiskHygieneFooter } from './context/DiskHygieneFooter'

export default function ContextTab() {
  const [data, setData] = useState<ContextSessionsResponse | null>(null)
  const [cruft, setCruft] = useState<CruftResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchAll = async () => {
    setLoading(true)
    setError(null)
    try {
      const [sessions, cruftData] = await Promise.all([
        api.contextSessions(),
        api.sessionsCruft(),
      ])
      setData(sessions)
      setCruft(cruftData)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'errore caricamento')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAll()
  }, [])

  if (loading && !data) {
    return (
      <div style={{ padding: 24, color: 'var(--text-3)' }}>
        Caricamento context inspector...
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: 24, color: '#ef4444' }}>
        Errore: {error}
        <button onClick={fetchAll} style={{ marginLeft: 12 }}>
          Riprova
        </button>
      </div>
    )
  }

  if (!data) return null

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>🧠 Context Inspector</h2>
        <button
          onClick={fetchAll}
          disabled={loading}
          style={{
            marginLeft: 'auto',
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
