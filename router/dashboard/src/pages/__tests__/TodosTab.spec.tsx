import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import TodosTab from '../TodosTab'

/**
 * Phase 2 Plan 02-02 — TodosTab component tests (ORC-10).
 *
 * Mocks the typed `api` client so we exercise the component's render +
 * polling + interaction logic without spinning up a real fetch.
 *
 * `vi.useFakeTimers()` lets us advance the 5s setInterval cadence and
 * verify the auto-refresh contract (CTX-13) without sleeping in tests.
 */

vi.mock('../../api/client', () => ({
  api: {
    todos: vi.fn(),
    addTodo: vi.fn(),
    completeTodo: vi.fn(),
  },
}))

import { api } from '../../api/client'

const mkTodo = (over: Partial<{ id: string; title: string; pid: number }> = {}) => ({
  id: over.id ?? 'AAA-1',
  title: over.title ?? 'Plan 02-01',
  list: 'Jarvis/ActiveTasks',
  notes: null,
  due: null,
  priority: 0,
  completed: false,
  metadata: { pid: over.pid ?? 12345, repo: 'jarvis', phase: 'plan' as const },
})

describe('TodosTab', () => {
  beforeEach(() => {
    // Use REAL timers by default — RTL's waitFor uses setTimeout internally,
    // and faking ALL timers wedges it. The auto-refresh test below opts in
    // to fake timers explicitly, faking only setInterval / clearInterval.
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders todos from /api/todos on mount', async () => {
    ;(api.todos as ReturnType<typeof vi.fn>).mockResolvedValue({ todos: [mkTodo()], unauthorized: false })
    render(<TodosTab />)
    await waitFor(() => expect(screen.getByText('Plan 02-01')).toBeTruthy())
    // Metadata columns visible
    expect(screen.getByText('12345')).toBeTruthy()
    expect(screen.getByText('jarvis')).toBeTruthy()
    expect(screen.getByText('plan')).toBeTruthy()
  })

  it('auto-refreshes every 5s (matches Context Inspector CTX-13 cadence)', async () => {
    ;(api.todos as ReturnType<typeof vi.fn>).mockResolvedValue({ todos: [], unauthorized: false })
    // Fake ONLY setInterval/clearInterval so RTL's waitFor (which uses
    // setTimeout / queueMicrotask) keeps working with real timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    render(<TodosTab />)
    await waitFor(() => expect(api.todos).toHaveBeenCalledTimes(1))
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    await waitFor(() => expect(api.todos).toHaveBeenCalledTimes(2))
  })

  it('shows "Authorize Reminders" banner when unauthorized', async () => {
    ;(api.todos as ReturnType<typeof vi.fn>).mockResolvedValue({ todos: [], unauthorized: true })
    render(<TodosTab />)
    await waitFor(() => expect(screen.getByText(/Authorize Reminders/i)).toBeTruthy())
  })

  it('shows "Reminders list missing" banner when listMissing:true (first-run UX)', async () => {
    ;(api.todos as ReturnType<typeof vi.fn>).mockResolvedValue({
      todos: [],
      unauthorized: false,
      listMissing: true,
      message: 'Custom server message about Jarvis/ActiveTasks',
    })
    render(<TodosTab />)
    await waitFor(() => expect(screen.getByText(/Reminders list missing/i)).toBeTruthy())
    expect(screen.getByText(/Custom server message/i)).toBeTruthy()
  })

  it('clicking ✓ calls api.completeTodo with todo id and refreshes', async () => {
    ;(api.todos as ReturnType<typeof vi.fn>).mockResolvedValue({ todos: [mkTodo({ id: 'T-1' })], unauthorized: false })
    ;(api.completeTodo as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
    render(<TodosTab />)
    await waitFor(() => screen.getByText('✓'))
    fireEvent.click(screen.getByText('✓'))
    await waitFor(() => expect(api.completeTodo).toHaveBeenCalledWith('T-1'))
  })

  it('Add input + button calls api.addTodo with trimmed title', async () => {
    ;(api.todos as ReturnType<typeof vi.fn>).mockResolvedValue({ todos: [], unauthorized: false })
    ;(api.addTodo as ReturnType<typeof vi.fn>).mockResolvedValue(mkTodo({ id: 'NEW', title: 'new task' }))
    render(<TodosTab />)
    await waitFor(() => screen.getByPlaceholderText('New todo title'))
    fireEvent.change(screen.getByPlaceholderText('New todo title'), { target: { value: '  new task  ' } })
    fireEvent.click(screen.getByText('Add'))
    await waitFor(() => expect(api.addTodo).toHaveBeenCalledWith({ title: 'new task' }))
  })
})
