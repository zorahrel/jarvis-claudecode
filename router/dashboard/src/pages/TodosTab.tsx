/**
 * Todos tab — Phase 2 Plan 02-02 (ORC-10).
 *
 * Mirrors the Phase 1 Sessions/Context tab pattern:
 *   - 5s polling (matches CTX-13 cadence)
 *   - Banner state when Reminders is unauthorized OR Jarvis/ActiveTasks
 *     list is missing (first-run UX)
 *   - Add input + table of open todos with parsed pid/repo/phase metadata
 *   - One-click ✓ to mark complete (optimistic — refresh on success)
 *
 * The dashboard never sees a 500 from /api/todos — the server gracefully
 * degrades to {todos:[], unauthorized:true} or {todos:[], listMissing:true}.
 * We render a banner per state.
 */
import { useEffect, useState, useCallback } from 'react'
import { api } from '../api/client'
import type { ReminderTodoDTO } from '../api/client'

interface TodosResponseExt {
  todos: ReminderTodoDTO[]
  unauthorized: boolean
  listMissing?: boolean
  message?: string
  error?: string
}

export default function TodosTab() {
  const [todos, setTodos] = useState<ReminderTodoDTO[]>([])
  const [unauthorized, setUnauthorized] = useState(false)
  const [listMissing, setListMissing] = useState(false)
  const [bannerMessage, setBannerMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newTitle, setNewTitle] = useState('')

  const refresh = useCallback(async () => {
    try {
      // The server-side /api/todos endpoint returns one of three shapes
      // (authorized, unauthorized, listMissing). We tolerate any of them.
      const r = (await api.todos()) as TodosResponseExt
      setTodos(r.todos)
      setUnauthorized(!!r.unauthorized)
      setListMissing(!!r.listMissing)
      setBannerMessage(r.message ?? null)
      setError(null)
    } catch (e) {
      setError(String((e as Error).message ?? e))
    }
  }, [])

  useEffect(() => {
    refresh()
    // Match the Context Inspector polling cadence (CTX-13). 5s — server-side
    // remindctl polling already runs at 3s, this catches up within one tick.
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [refresh])

  const onAdd = useCallback(async () => {
    if (!newTitle.trim()) return
    setAdding(true)
    try {
      await api.addTodo({ title: newTitle.trim() })
      setNewTitle('')
      await refresh()
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally {
      setAdding(false)
    }
  }, [newTitle, refresh])

  const onComplete = useCallback(async (id: string) => {
    try {
      await api.completeTodo(id)
      await refresh()
    } catch (e) {
      setError(String((e as Error).message ?? e))
    }
  }, [refresh])

  // ── Banner: Reminders not authorized ───────────────────────────────────
  if (unauthorized) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 16, color: 'var(--text-1)' }}>Todos</h1>
        <div
          style={{
            background: 'rgba(241, 196, 15, 0.12)',
            borderLeft: '4px solid var(--warn, #f1c40f)',
            padding: 16,
            borderRadius: 6,
            color: 'var(--text-1)',
          }}
        >
          <p style={{ fontWeight: 600, marginBottom: 6 }}>Authorize Reminders</p>
          <p style={{ color: 'var(--text-3)', fontSize: 13, lineHeight: 1.5 }}>
            Esegui da Terminale: <code style={{ background: 'var(--bg-0)', padding: '2px 6px', borderRadius: 3 }}>remindctl authorize</code> — poi ricarica la pagina.
          </p>
        </div>
      </div>
    )
  }

  // ── Banner: Jarvis/ActiveTasks list does not exist yet ─────────────────
  if (listMissing) {
    return (
      <div style={{ padding: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 16, color: 'var(--text-1)' }}>Todos</h1>
        <div
          style={{
            background: 'rgba(124, 136, 230, 0.12)',
            borderLeft: '4px solid var(--accent-bright, #7c88e6)',
            padding: 16,
            borderRadius: 6,
            color: 'var(--text-1)',
          }}
        >
          <p style={{ fontWeight: 600, marginBottom: 6 }}>Reminders list missing</p>
          <p style={{ color: 'var(--text-3)', fontSize: 13, lineHeight: 1.5 }}>
            {bannerMessage ?? 'Crea la lista "Jarvis/ActiveTasks" su iPhone o Mac Reminders, poi ricarica.'}
          </p>
          <p style={{ color: 'var(--text-4)', fontSize: 12, marginTop: 8, fontFamily: 'var(--mono)' }}>
            remindctl list "Jarvis/ActiveTasks" --create
          </p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 16, color: 'var(--text-1)' }}>
        Todos — Jarvis/ActiveTasks
      </h1>
      {error && (
        <div
          style={{
            background: 'rgba(232, 79, 79, 0.12)',
            borderLeft: '4px solid var(--err, #e84f4f)',
            padding: 12,
            borderRadius: 4,
            marginBottom: 12,
            color: 'var(--text-1)',
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          style={{
            flex: 1,
            background: 'var(--bg-1)',
            border: '1px solid var(--border)',
            color: 'var(--text-1)',
            padding: '8px 12px',
            borderRadius: 'var(--radius)',
            fontSize: 13,
            fontFamily: 'var(--sans)',
          }}
          placeholder="New todo title"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onAdd() }}
          aria-label="New todo title"
        />
        <button
          style={{
            background: 'var(--accent-bright, #7c88e6)',
            color: '#fff',
            padding: '8px 16px',
            borderRadius: 'var(--radius)',
            fontSize: 13,
            fontWeight: 500,
            border: 'none',
            cursor: adding ? 'not-allowed' : 'pointer',
            opacity: adding ? 0.6 : 1,
          }}
          onClick={onAdd}
          disabled={adding}
        >
          {adding ? 'Adding...' : 'Add'}
        </button>
      </div>

      <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
        <thead style={{ background: 'var(--bg-1)' }}>
          <tr>
            <th style={{ textAlign: 'left', padding: 8, color: 'var(--text-3)', fontWeight: 500 }}>Title</th>
            <th style={{ textAlign: 'left', padding: 8, color: 'var(--text-3)', fontWeight: 500 }}>Pid</th>
            <th style={{ textAlign: 'left', padding: 8, color: 'var(--text-3)', fontWeight: 500 }}>Repo</th>
            <th style={{ textAlign: 'left', padding: 8, color: 'var(--text-3)', fontWeight: 500 }}>Phase</th>
            <th style={{ textAlign: 'left', padding: 8, color: 'var(--text-3)', fontWeight: 500 }}>Due</th>
            <th style={{ textAlign: 'center', padding: 8, color: 'var(--text-3)', fontWeight: 500 }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {todos.map((t) => (
            <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: 8, color: 'var(--text-1)' }}>{t.title}</td>
              <td style={{ padding: 8, color: 'var(--text-2)', fontFamily: 'var(--mono)' }}>
                {t.metadata.pid ?? '—'}
              </td>
              <td style={{ padding: 8, color: 'var(--text-2)' }}>{t.metadata.repo ?? '—'}</td>
              <td style={{ padding: 8, color: 'var(--text-2)' }}>{t.metadata.phase ?? '—'}</td>
              <td style={{ padding: 8, color: 'var(--text-2)' }}>{t.due ?? '—'}</td>
              <td style={{ padding: 8, textAlign: 'center' }}>
                <button
                  onClick={() => onComplete(t.id)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--ok, #27ae60)',
                    cursor: 'pointer',
                    fontSize: 16,
                    padding: '4px 8px',
                  }}
                  aria-label={`Complete ${t.title}`}
                >
                  ✓
                </button>
              </td>
            </tr>
          ))}
          {todos.length === 0 && (
            <tr>
              <td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--text-4)' }}>
                No open todos.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
