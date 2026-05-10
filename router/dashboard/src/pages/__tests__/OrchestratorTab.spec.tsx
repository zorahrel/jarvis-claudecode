/**
 * Phase 2 Plan 02-04 — OrchestratorTab tests (ORC-18, ORC-19).
 *
 * Mocks the typed `api` client so we exercise the component's render +
 * controls + force-confirm modal without spinning up a real fetch.
 *
 * (W5 FIX) Force matching is case-INSENSITIVE per CONTEXT.md / plan
 * acceptance — `forceWord.trim().toLowerCase() === 'force'`. The it.each
 * blocks below assert all five accepted variants and five rejected ones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import OrchestratorTab from '../OrchestratorTab'

vi.mock('../../api/client', () => ({
  api: {
    snapshot: vi.fn(),
    inject: vi.fn(),
  },
}))

import { api } from '../../api/client'

type MkOver = Partial<{
  pid: number
  status: string
  tmux: { session: string; pane: string } | null
  conflict: number | null
  action: { type: string; text?: string }
}>

const mkEntry = (over: MkOver = {}) => ({
  pid: over.pid ?? 1234,
  repo: 'x',
  branch: 'main',
  cwd: '/x',
  status: over.status ?? 'awaiting_user_input',
  last_assistant_summary: 'Approve plan?',
  suggestion: 'Approve',
  action: over.action ?? { type: 'inject', text: 'y' },
  confidence: 'high',
  todo_link: null,
  tmux: over.tmux === undefined ? { session: 's', pane: '%2' } : over.tmux,
  conflict: over.conflict ?? null,
})

describe('OrchestratorTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders sessions from snapshot', async () => {
    ;(api.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      generated_at: 'x',
      sessions: [mkEntry()],
    })
    render(<OrchestratorTab />)
    await waitFor(() => expect(screen.getByTestId('approve-1234')).toBeTruthy())
  })

  it('disables Approve when no tmux', async () => {
    ;(api.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      generated_at: 'x',
      sessions: [mkEntry({ tmux: null })],
    })
    render(<OrchestratorTab />)
    await waitFor(() => {
      const btn = screen.getByTestId('approve-1234') as HTMLButtonElement
      expect(btn.disabled).toBe(true)
    })
  })

  it('disables Approve when status != awaiting_user_input', async () => {
    ;(api.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      generated_at: 'x',
      sessions: [mkEntry({ status: 'working' })],
    })
    render(<OrchestratorTab />)
    await waitFor(() => {
      const btn = screen.getByTestId('approve-1234') as HTMLButtonElement
      expect(btn.disabled).toBe(true)
    })
  })

  it('clicking Approve calls inject and refreshes', async () => {
    ;(api.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      generated_at: 'x',
      sessions: [mkEntry()],
    })
    ;(api.inject as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      paneId: '%2',
      auditTs: 1,
    })
    render(<OrchestratorTab />)
    await waitFor(() => screen.getByTestId('approve-1234'))
    fireEvent.click(screen.getByTestId('approve-1234'))
    await waitFor(() =>
      expect(api.inject).toHaveBeenCalledWith(
        1234,
        expect.objectContaining({ text: 'y', source: 'user-approved' }),
      ),
    )
  })

  it('opens force-confirm modal on lock_conflict and only proceeds when "force" typed', async () => {
    ;(api.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      generated_at: 'x',
      sessions: [mkEntry({ conflict: 5678 })],
    })
    ;(api.inject as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ error: 'lock_conflict', conflictPid: 5678 })
      .mockResolvedValueOnce({ ok: true, paneId: '%2', auditTs: 1 })
    render(<OrchestratorTab />)
    await waitFor(() => screen.getByTestId('approve-1234'))
    fireEvent.click(screen.getByTestId('approve-1234'))
    await waitFor(() => screen.getByTestId('force-modal'))
    fireEvent.change(screen.getByTestId('force-input'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByTestId('force-confirm'))
    // Wrong word: inject NOT called a second time
    expect(api.inject).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByTestId('force-input'), { target: { value: 'force' } })
    fireEvent.click(screen.getByTestId('force-confirm'))
    await waitFor(() =>
      expect(api.inject).toHaveBeenCalledWith(1234, expect.objectContaining({ force: true })),
    )
  })

  // (W5 FIX) Case-INSENSITIVE force matching — accepts trimmed lowercase.
  it.each(['force', 'Force', 'FORCE', '  force  ', 'fOrCe'])(
    'force-confirm accepts case-insensitive variant: %s',
    async (variant) => {
      ;(api.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
        generated_at: 'x',
        sessions: [mkEntry({ conflict: 5678 })],
      })
      ;(api.inject as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ error: 'lock_conflict', conflictPid: 5678 })
        .mockResolvedValueOnce({ ok: true, paneId: '%2', auditTs: 1 })
      render(<OrchestratorTab />)
      await waitFor(() => screen.getByTestId('approve-1234'))
      fireEvent.click(screen.getByTestId('approve-1234'))
      await waitFor(() => screen.getByTestId('force-modal'))
      fireEvent.change(screen.getByTestId('force-input'), { target: { value: variant } })
      fireEvent.click(screen.getByTestId('force-confirm'))
      await waitFor(() =>
        expect(api.inject).toHaveBeenCalledWith(1234, expect.objectContaining({ force: true })),
      )
    },
  )

  it.each(['forced', 'fOrce!', 'yes', 'f0rce', ''])(
    'force-confirm rejects non-matching word: %s',
    async (variant) => {
      ;(api.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
        generated_at: 'x',
        sessions: [mkEntry({ conflict: 5678 })],
      })
      ;(api.inject as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        error: 'lock_conflict',
        conflictPid: 5678,
      })
      render(<OrchestratorTab />)
      await waitFor(() => screen.getByTestId('approve-1234'))
      fireEvent.click(screen.getByTestId('approve-1234'))
      await waitFor(() => screen.getByTestId('force-modal'))
      fireEvent.change(screen.getByTestId('force-input'), { target: { value: variant } })
      fireEvent.click(screen.getByTestId('force-confirm'))
      // Inject must NOT be called a second time with these rejected words.
      expect(api.inject).toHaveBeenCalledTimes(1)
    },
  )
})
