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
 */

export type OrchestratorEvent =
  | { type: "sessions:update"; data: { pids: number[]; ts: number } }
  | { type: "todos:update"; data: { count: number; ts: number } }
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
}
