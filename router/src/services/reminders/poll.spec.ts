import { test } from "node:test";
import assert from "node:assert/strict";
import { diffTodos } from "./poll.js";
import type { ReminderTodo } from "./types.js";

/**
 * Phase 2 Plan 02-02 — diffTodos (ORC-07).
 *
 * Pure function: given previous + next snapshots, returns the list of
 * TodoEvents to emit. Deletions are intentionally NOT emitted — only
 * added / completed / updated per CONTEXT.md decision and ORC-07 spec.
 */

function mkTodo(over: Partial<ReminderTodo> = {}): ReminderTodo {
  return {
    id: "AAA",
    title: "todo",
    list: "Jarvis/ActiveTasks",
    notes: null,
    due: null,
    priority: 0,
    completed: false,
    metadata: {},
    ...over,
  };
}

test("diffTodos: emits todo:added when a new id appears", () => {
  const events = diffTodos([], [mkTodo({ id: "a" })]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "todo:added");
  assert.equal(events[0].todo.id, "a");
});

test("diffTodos: emits todo:completed when completed flips false→true", () => {
  const prev = [mkTodo({ id: "a", completed: false })];
  const next = [mkTodo({ id: "a", completed: true })];
  const events = diffTodos(prev, next);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "todo:completed");
  assert.equal(events[0].todo.id, "a");
});

test("diffTodos: emits todo:updated on title/notes/due change", () => {
  const prev = [mkTodo({ id: "a", title: "x" })];
  const next = [mkTodo({ id: "a", title: "y" })];
  const events = diffTodos(prev, next);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "todo:updated");
  if (events[0].type !== "todo:updated") throw new Error("unexpected event type");
  assert.equal(events[0].previous.title, "x");
  assert.equal(events[0].todo.title, "y");
});

test("diffTodos: ignores deletions (id present in prev, missing in next)", () => {
  const prev = [mkTodo({ id: "a" }), mkTodo({ id: "b" })];
  const next = [mkTodo({ id: "a" })];
  const events = diffTodos(prev, next);
  assert.deepEqual(events, []);
});
