/**
 * Orchestrator event bus — Phase 2 Plan 02-02.
 *
 * Why a separate module from `notch/events.ts`:
 *
 *   `notch/events.ts` is the existing wire protocol between the router and
 *   the JarvisNotch surfaces (TTS streaming, abort, voice transcribed,
 *   message in/out). It's a stable union the WKWebView depends on. Mixing
 *   orchestrator concerns into that union would break the contract and
 *   force a notch rebuild on every orchestrator change.
 *
 *   This file is the namespaced bus for orchestrator-side events:
 *     - sessions:update — emitted whenever the OrchestratorSnapshot changes
 *     - todos:update    — emitted whenever the Reminders polling loop sees a delta
 *     - todo:added / todo:completed / todo:updated — granular per-todo events
 *
 * RESEARCH.md anti-pattern (line 297) explicitly forbids polluting
 * `notch/events.ts` with orchestrator types.
 *
 * Pattern: same module-private `Set<Subscriber>` shape as notch/events.ts
 * so anyone reading either file sees the same conventions (subscribe
 * returns an unsubscribe function, errors in subscribers are swallowed,
 * a private `__resetForTests` clears state for hermetic tests).
 *
 * Plan 02-03 extensions:
 *   - `sessions:update` payload now optionally carries a `sessions` array
 *     with `{pid, repo, status, conflict}` per session — the notch HUD
 *     reads this instead of re-fetching the snapshot.
 *   - `todos:update` payload now optionally carries `topThree` — the notch
 *     todo strip's wire format.
 *   - `startOrchestratorBridge()` aggregates buildSnapshot() ticks into
 *     `sessions:update` emits and debounces todo:* events into a single
 *     `todos:update` with the top-3 open todos.
 */

import { logger } from "../services/logger";

const log = logger.child({ module: "orchestrator-events" });

/** Per-session entry inside a `sessions:update` payload (Plan 02-03). */
export interface SessionStatusEntry {
  pid: number;
  repo: string;
  status: "awaiting_user_input" | "tool_pending" | "crashed" | "working" | "idle" | string;
  conflict: number | null;
}

/** Per-todo summary inside a `todos:update` payload (Plan 02-03). */
export interface TodoSummary {
  id: string;
  title: string;
  pid: number | null;
  phase: string | null;
}

export type OrchestratorEvent =
  | {
      type: "sessions:update";
      data: {
        pids: number[];
        ts: number;
        // Plan 02-03 — rich snapshot delta consumed by the notch sidebar.
        sessions?: SessionStatusEntry[];
      };
    }
  | {
      type: "todos:update";
      data: {
        count: number;
        ts: number;
        // Plan 02-03 — top-3 open todos consumed by the notch strip.
        topThree?: TodoSummary[];
      };
    }
  | { type: "todo:added"; todo: { id: string; title: string }; ts: number }
  | { type: "todo:completed"; todo: { id: string; title: string }; ts: number }
  | { type: "todo:updated"; todo: { id: string; title: string }; ts: number };

type Subscriber = (event: OrchestratorEvent) => void;
const subscribers = new Set<Subscriber>();

/**
 * Add a subscriber. Returns an unsubscribe function. Cheap when nothing
 * is listening (early-out at the caller via `subscribers.size`).
 */
export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Broadcast an event to every live subscriber. Errors swallowed. */
export function emit(event: OrchestratorEvent): void {
  for (const s of subscribers) {
    try {
      s(event);
    } catch {
      /* never let one subscriber break others — mirrors notch/events.ts */
    }
  }
}

/** Current listener count — exposed for tests + telemetry. */
export function listenerCount(): number {
  return subscribers.size;
}

/** Test-only: clear all subscribers. Do NOT call from production code. */
export function __resetForTests(): void {
  subscribers.clear();
  stopOrchestratorBridge();
}

// MARK: - Bridge (Plan 02-03)

let bridgeInterval: ReturnType<typeof setInterval> | null = null;
let todosDebounce: ReturnType<typeof setTimeout> | null = null;
let bridgeUnsub: (() => void) | null = null;

/**
 * Boot the snapshot → `sessions:update` aggregator AND the todo:* →
 * `todos:update` debouncer. Idempotent — calling twice returns without
 * spawning a second interval.
 *
 * Snapshot cadence: default 5s (matches Context Inspector's CTX-13 pattern).
 * Todos debounce: 1s window so a burst of `todo:added` events from the
 * Reminders polling loop coalesces into a single `todos:update` with the
 * fresh top-3.
 */
export function startOrchestratorBridge(opts: { snapshotIntervalMs?: number } = {}): void {
  if (bridgeInterval || bridgeUnsub) {
    log.debug("orchestrator bridge already running — skipping");
    return;
  }
  const interval = opts.snapshotIntervalMs ?? 5000;

  const tick = async (): Promise<void> => {
    try {
      // Lazy-import buildSnapshot so non-bridge code paths (tests, CLI tools)
      // don't pull in the orchestrator service graph until they need it.
      // Jarvis owns the discovery side (ps+lsof in services/localSessions); the
      // library is data-source-agnostic.
      const { buildSnapshot } = await import("agent-conductor");
      const { discoverLocalSessions } = await import("../services/localSessions/discovery.js");
      const sessions = await discoverLocalSessions();
      const snap = await buildSnapshot(sessions);
      emit({
        type: "sessions:update",
        data: {
          pids: snap.sessions.map((s) => s.pid),
          ts: Date.now(),
          sessions: snap.sessions.map((s) => ({
            pid: s.pid,
            repo: s.repo,
            status: s.status,
            conflict: s.conflict,
          })),
        },
      });
    } catch (err) {
      log.warn({ err }, "[orchestrator-bridge] snapshot tick failed");
    }
  };

  bridgeInterval = setInterval(tick, interval);
  // Fire one tick immediately so the notch HUD doesn't wait `interval` ms
  // for its first paint after a router restart.
  void tick();

  // Debounced todos:update aggregator. Subscribes to OUR OWN bus so the
  // existing per-todo events (todo:added/completed/updated already emitted
  // from server.ts via the polling loop) trigger a top-3 refresh.
  bridgeUnsub = subscribe((e) => {
    if (e.type !== "todo:added" && e.type !== "todo:completed" && e.type !== "todo:updated") return;
    if (todosDebounce) clearTimeout(todosDebounce);
    todosDebounce = setTimeout(async () => {
      try {
        const { listTodos } = await import("agent-conductor");
        const all = await listTodos();
        const open = all
          .filter((t) => !t.completed)
          .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))
          .slice(0, 3);
        emit({
          type: "todos:update",
          data: {
            count: all.filter((t) => !t.completed).length,
            ts: Date.now(),
            topThree: open.map((t) => ({
              id: t.id,
              title: t.title,
              pid: t.metadata?.pid ?? null,
              phase: t.metadata?.phase ?? null,
            })),
          },
        });
      } catch (err) {
        // listTodos may reject when remindctl isn't authorized OR the list
        // is missing — both are non-fatal for the bridge; we just skip the
        // refresh and try again on the next todo:* event.
        log.debug({ err }, "[orchestrator-bridge] todos refresh skipped");
      }
    }, 1000);
  });
}

/** Tear down the bridge — used by tests and graceful shutdown. */
export function stopOrchestratorBridge(): void {
  if (bridgeInterval) clearInterval(bridgeInterval);
  if (todosDebounce) clearTimeout(todosDebounce);
  if (bridgeUnsub) bridgeUnsub();
  bridgeInterval = null;
  todosDebounce = null;
  bridgeUnsub = null;
}
