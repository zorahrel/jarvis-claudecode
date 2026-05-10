/**
 * Orchestrator tab — Phase 2 Plan 02-04 (ORC-18, ORC-19).
 *
 * Read-side: 5s poll on /api/sessions/snapshot (matches CTX-13 cadence).
 * Write-side: Approve / Skip / Custom controls per session, only enabled
 *             for sessions where status === 'awaiting_user_input' AND
 *             tmux mapping is non-null (bare TTYs stay read-only —
 *             CONTEXT.md locked decision).
 *
 * Lock-conflict flow (ORC-19): when /api/sessions/:pid/inject returns 409
 * lock_conflict, surface a force-confirm modal. The user must type 'force'
 * (case-INSENSITIVE per W5 fix — `forceWord.trim().toLowerCase() === 'force'`)
 * before we re-issue the inject with `force:true`.
 */
import { useEffect, useState, useCallback } from 'react'
import { api } from '../api/client'
import type {
  OrchestratorSnapshotDTO,
  SnapshotEntryDTO,
  InjectResponse,
  InjectBody,
} from '../api/client'

/** Tagged success — narrows InjectResponse so TS knows ok:true side. */
function isInjectError(r: InjectResponse): r is { error: string; message?: string; conflictPid?: number } {
  return 'error' in r
}

export default function OrchestratorTab() {
  const [snap, setSnap] = useState<OrchestratorSnapshotDTO | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmFor, setConfirmFor] = useState<{ pid: number; conflictPid: number; text: string } | null>(null)
  const [forceWord, setForceWord] = useState('')
  const [customFor, setCustomFor] = useState<number | null>(null)
  const [customText, setCustomText] = useState('')

  const refresh = useCallback(async () => {
    try {
      const r = await api.snapshot()
      setSnap(r)
      setError(null)
    } catch (e) {
      setError(String((e as Error).message ?? e))
    }
  }, [])

  useEffect(() => {
    refresh()
    // 5s polling — matches Phase 1 CTX-13 cadence and Plan 02-02 TodosTab.
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [refresh])

  const doInject = useCallback(async (pid: number, text: string, force: boolean = false) => {
    const body: InjectBody = { text, source: 'user-approved' }
    if (force) body.force = true
    const r = await api.inject(pid, body)
    if (isInjectError(r) && r.error === 'lock_conflict') {
      setConfirmFor({ pid, conflictPid: r.conflictPid ?? 0, text })
      return
    }
    if (isInjectError(r)) {
      setError(`Inject failed: ${r.error} ${r.message ?? ''}`)
      return
    }
    await refresh()
  }, [refresh])

  const onApprove = useCallback((s: SnapshotEntryDTO) => {
    if (s.action.type !== 'inject' || !s.action.text) return
    void doInject(s.pid, s.action.text)
  }, [doInject])

  const onSkip = useCallback((_s: SnapshotEntryDTO) => {
    // Skip is a UI-only no-op per ORC-18 — just refresh to clear any
    // stale state. Future plan may add an audit-style "skipped" entry.
    void refresh()
  }, [refresh])

  const onCustom = useCallback((s: SnapshotEntryDTO) => {
    setCustomFor(s.pid)
    setCustomText('')
  }, [])

  const submitCustom = useCallback(() => {
    if (customFor && customText.trim()) {
      void doInject(customFor, customText.trim())
    }
    setCustomFor(null)
    setCustomText('')
  }, [customFor, customText, doInject])

  const confirmForce = useCallback(async () => {
    // (W5 FIX) Case-insensitive force matching: trim + lowercase compare.
    // Accepts: "force", "Force", "FORCE", "  force  ", "fOrCe".
    // Rejects: "forced", "fOrce!", "yes", "f0rce", "".
    if (forceWord.trim().toLowerCase() !== 'force') {
      setError("Devi digitare esattamente 'force' per procedere")
      return
    }
    if (confirmFor) {
      await doInject(confirmFor.pid, confirmFor.text, true)
      setConfirmFor(null)
      setForceWord('')
    }
  }, [forceWord, confirmFor, doInject])

  // Approve is enabled ONLY when:
  //  1. status === 'awaiting_user_input' (no point if not waiting),
  //  2. tmux !== null (bare-TTY sessions are read-only — Pitfall 6).
  const isApprovable = (s: SnapshotEntryDTO) =>
    s.status === 'awaiting_user_input' && s.tmux !== null

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 16, color: 'var(--text-1)' }}>
        Orchestrator
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

      {!snap && <div style={{ color: 'var(--text-3)' }}>Loading…</div>}
      {snap && (
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead style={{ background: 'var(--bg-1)' }}>
            <tr>
              <th style={{ textAlign: 'left', padding: 8, color: 'var(--text-3)', fontWeight: 500 }}>PID</th>
              <th style={{ textAlign: 'left', padding: 8, color: 'var(--text-3)', fontWeight: 500 }}>Repo</th>
              <th style={{ textAlign: 'left', padding: 8, color: 'var(--text-3)', fontWeight: 500 }}>Branch</th>
              <th style={{ textAlign: 'left', padding: 8, color: 'var(--text-3)', fontWeight: 500 }}>Status</th>
              <th style={{ textAlign: 'left', padding: 8, color: 'var(--text-3)', fontWeight: 500 }}>Suggestion</th>
              <th style={{ textAlign: 'left', padding: 8, color: 'var(--text-3)', fontWeight: 500 }}>Conflict</th>
              <th style={{ textAlign: 'left', padding: 8, color: 'var(--text-3)', fontWeight: 500 }}>tmux</th>
              <th style={{ textAlign: 'left', padding: 8, color: 'var(--text-3)', fontWeight: 500 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {snap.sessions.map((s) => {
              const approvable = isApprovable(s)
              return (
                <tr key={s.pid} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: 8, fontFamily: 'var(--mono)', color: 'var(--text-1)' }}>{s.pid}</td>
                  <td style={{ padding: 8, color: 'var(--text-2)' }}>{s.repo}</td>
                  <td style={{ padding: 8, color: 'var(--text-2)' }}>{s.branch ?? '—'}</td>
                  <td style={{ padding: 8, color: 'var(--text-2)' }}>{s.status}</td>
                  <td style={{ padding: 8, color: 'var(--text-2)' }}>{s.suggestion}</td>
                  <td style={{ padding: 8, color: 'var(--text-2)' }}>{s.conflict ?? '—'}</td>
                  <td
                    style={{ padding: 8, color: 'var(--text-2)', fontFamily: 'var(--mono)', fontSize: 12 }}
                    title={s.tmux ? '' : 'no tmux pane — start under tmux to enable inject'}
                  >
                    {s.tmux ? `${s.tmux.session}:${s.tmux.pane}` : '—'}
                  </td>
                  <td style={{ padding: 8, display: 'flex', gap: 4 }}>
                    <button
                      onClick={() => onApprove(s)}
                      disabled={!approvable || s.action.type !== 'inject'}
                      title={!s.tmux ? 'no tmux pane — start under tmux to enable inject' : ''}
                      data-testid={`approve-${s.pid}`}
                      style={{
                        background: 'var(--ok, #27ae60)',
                        color: '#fff',
                        padding: '4px 10px',
                        border: 'none',
                        borderRadius: 'var(--radius)',
                        fontSize: 12,
                        cursor: approvable ? 'pointer' : 'not-allowed',
                        opacity: approvable && s.action.type === 'inject' ? 1 : 0.3,
                      }}
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => onSkip(s)}
                      disabled={!approvable}
                      data-testid={`skip-${s.pid}`}
                      style={{
                        background: 'var(--bg-2)',
                        color: 'var(--text-1)',
                        padding: '4px 10px',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius)',
                        fontSize: 12,
                        cursor: approvable ? 'pointer' : 'not-allowed',
                        opacity: approvable ? 1 : 0.3,
                      }}
                    >
                      Skip
                    </button>
                    <button
                      onClick={() => onCustom(s)}
                      disabled={!approvable}
                      data-testid={`custom-${s.pid}`}
                      style={{
                        background: 'var(--accent-bright, #7c88e6)',
                        color: '#fff',
                        padding: '4px 10px',
                        border: 'none',
                        borderRadius: 'var(--radius)',
                        fontSize: 12,
                        cursor: approvable ? 'pointer' : 'not-allowed',
                        opacity: approvable ? 1 : 0.3,
                      }}
                    >
                      Custom
                    </button>
                  </td>
                </tr>
              )
            })}
            {snap.sessions.length === 0 && (
              <tr>
                <td colSpan={8} style={{ padding: 24, textAlign: 'center', color: 'var(--text-4)' }}>
                  No active sessions.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {/* Force-confirm modal (ORC-19) */}
      {confirmFor && (
        <div
          data-testid="force-modal"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            style={{
              background: 'var(--bg-1)',
              padding: 24,
              borderRadius: 'var(--radius)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              maxWidth: 480,
              border: '1px solid var(--border)',
            }}
          >
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, color: 'var(--text-1)' }}>
              Lock conflict
            </h2>
            <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 6 }}>
              PID {confirmFor.pid} condivide cwd con PID {confirmFor.conflictPid}.
            </p>
            <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 8 }}>
              Per procedere, digita la parola{' '}
              <code style={{ background: 'var(--bg-0)', padding: '2px 6px', borderRadius: 3 }}>force</code>:
            </p>
            <input
              data-testid="force-input"
              value={forceWord}
              onChange={(e) => setForceWord(e.target.value)}
              autoFocus
              style={{
                width: '100%',
                background: 'var(--bg-0)',
                border: '1px solid var(--border)',
                color: 'var(--text-1)',
                padding: '8px 12px',
                borderRadius: 'var(--radius)',
                fontSize: 13,
                fontFamily: 'var(--mono)',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setConfirmFor(null); setForceWord('') }}
                style={{
                  background: 'var(--bg-2)',
                  color: 'var(--text-1)',
                  padding: '6px 14px',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                data-testid="force-confirm"
                onClick={confirmForce}
                style={{
                  background: 'var(--err, #e84f4f)',
                  color: '#fff',
                  padding: '6px 14px',
                  border: 'none',
                  borderRadius: 'var(--radius)',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Force inject
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Custom inject textarea */}
      {customFor !== null && (
        <div
          data-testid="custom-modal"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            style={{
              background: 'var(--bg-1)',
              padding: 24,
              borderRadius: 'var(--radius)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              maxWidth: 560,
              width: '90%',
              border: '1px solid var(--border)',
            }}
          >
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, color: 'var(--text-1)' }}>
              Custom inject — PID {customFor}
            </h2>
            <textarea
              data-testid="custom-textarea"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              autoFocus
              style={{
                width: '100%',
                height: 128,
                background: 'var(--bg-0)',
                border: '1px solid var(--border)',
                color: 'var(--text-1)',
                padding: '8px 12px',
                borderRadius: 'var(--radius)',
                fontSize: 13,
                fontFamily: 'var(--mono)',
                resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
              <button
                onClick={() => { setCustomFor(null); setCustomText('') }}
                style={{
                  background: 'var(--bg-2)',
                  color: 'var(--text-1)',
                  padding: '6px 14px',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                data-testid="custom-submit"
                onClick={submitCustom}
                style={{
                  background: 'var(--accent-bright, #7c88e6)',
                  color: '#fff',
                  padding: '6px 14px',
                  border: 'none',
                  borderRadius: 'var(--radius)',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Inject
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
