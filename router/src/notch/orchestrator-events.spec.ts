import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emit, subscribe, listenerCount, __resetForTests, type OrchestratorEvent } from "./orchestrator-events.js";

/**
 * Phase 2 Plan 02-02 — orchestrator event bus.
 *
 * Verifies the namespaced bus is wire-compatible with notch/events.ts
 * conventions (subscribe → unsubscribe fn, emit is fire-and-forget,
 * one subscriber throwing does not break siblings).
 */

beforeEach(() => __resetForTests());

test("emit + subscribe round-trips an event", () => {
  const captured: OrchestratorEvent[] = [];
  subscribe((e) => captured.push(e));
  emit({ type: "todos:update", data: { count: 3, ts: 100 } });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].type, "todos:update");
  if (captured[0].type === "todos:update") {
    assert.equal(captured[0].data.count, 3);
  }
});

test("unsubscribe stops delivery", () => {
  let calls = 0;
  const off = subscribe(() => { calls++; });
  emit({ type: "todos:update", data: { count: 1, ts: 1 } });
  assert.equal(calls, 1);
  off();
  emit({ type: "todos:update", data: { count: 2, ts: 2 } });
  assert.equal(calls, 1, "subscriber should not be called after unsubscribe");
  assert.equal(listenerCount(), 0);
});

test("one subscriber throwing does not break delivery to others", () => {
  let okCalls = 0;
  subscribe(() => { throw new Error("boom"); });
  subscribe(() => { okCalls++; });
  emit({ type: "todo:added", todo: { id: "x", title: "y" }, ts: 0 });
  assert.equal(okCalls, 1);
});
