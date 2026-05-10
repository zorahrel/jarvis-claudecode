/**
 * Reminders polling loop — Phase 2 Plan 02-02 (ORC-07).
 *
 * Every 3s by default the loop calls `listTodos()` and computes a diff
 * against the previous snapshot. Three event types fire through the caller-
 * supplied `onEvent` callback:
 *
 *   - todo:added     — id appears in next, was absent in prev
 *   - todo:completed — same id, completed flips false → true
 *   - todo:updated   — same id, title/notes/due changed
 *
 * Deletions are intentionally NOT emitted (CONTEXT.md decision + ORC-07).
 *
 * 3s polling cadence accepts the iCloud Reminders eventual-consistency lag
 * (3-15s) called out in CONTEXT.md and Pitfall 5 of RESEARCH.md.
 */

import type { ReminderTodo, TodoEvent } from "./types.js";
import { listTodos } from "./cli.js";

/**
 * Pure diff function — given two snapshots, return the list of TodoEvents
 * to emit. Used by the polling loop and unit-tested directly so we don't
 * need fake timers.
 *
 * Iteration order: `next` order. The diff is stable across ticks — same
 * inputs always yield the same event sequence.
 */
export function diffTodos(prev: ReminderTodo[], next: ReminderTodo[]): TodoEvent[] {
  const events: TodoEvent[] = [];
  const prevMap = new Map(prev.map((t) => [t.id, t] as const));
  for (const t of next) {
    const before = prevMap.get(t.id);
    if (!before) {
      events.push({ type: "todo:added", todo: t });
      continue;
    }
    if (!before.completed && t.completed) {
      events.push({ type: "todo:completed", todo: t });
      continue;
    }
    if (before.title !== t.title || before.notes !== t.notes || before.due !== t.due) {
      events.push({ type: "todo:updated", todo: t, previous: before });
    }
  }
  // Deletions intentionally ignored — see ORC-07.
  return events;
}

// ── Module-private polling state ────────────────────────────────────────
//
// Single global state because we only ever poll one list at a time
// (Jarvis/ActiveTasks). If we ever need multi-list polling, refactor this
// to a Map<listName, PollState>.
let pollHandle: ReturnType<typeof setInterval> | null = null;
let prevState: ReminderTodo[] = [];

export interface PollOptions {
  intervalMs?: number;
  list?: string;
  onEvent: (e: TodoEvent) => void;
  /** Optional error sink — called with any exec/parse failure during a tick. */
  onError?: (err: unknown) => void;
}

/**
 * Start the polling loop. Idempotent: calling twice without `stop` first is
 * a no-op (we don't restart). Returns immediately; the first tick fires
 * asynchronously.
 */
export function startReminderPolling(opts: PollOptions): void {
  if (pollHandle) return; // already running
  const interval = opts.intervalMs ?? 3000;

  const tick = async (): Promise<void> => {
    try {
      const next = await listTodos(opts.list);
      const events = diffTodos(prevState, next);
      prevState = next;
      for (const e of events) {
        try {
          opts.onEvent(e);
        } catch (err) {
          // One subscriber breaking shouldn't break the bridge.
          opts.onError?.(err);
        }
      }
    } catch (err) {
      // First-run: Jarvis/ActiveTasks list doesn't exist yet. Swallow
      // silently — the user creates it via their iPhone/Mac Reminders app
      // (the dashboard's `listMissing` banner explains the path). Logging
      // a WARN every 3s would spam the router log indefinitely.
      const msg = String((err as Error).message ?? err);
      if (/list not found/i.test(msg) || /no such list/i.test(msg)) return;
      opts.onError?.(err);
    }
  };

  pollHandle = setInterval(tick, interval);
  // Fire once immediately so the dashboard sees the first batch without
  // waiting up to `interval` ms after boot.
  void tick();
}

/** Stop polling and clear cached state. Idempotent. */
export function stopReminderPolling(): void {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  prevState = [];
}
