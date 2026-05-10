import { test } from "node:test";
import assert from "node:assert/strict";
import { handleListTodos, handleAddTodo, handleCompleteTodo, handlePatchTodo, type TodosDeps } from "./api.todos.js";
import type { ReminderTodo } from "../services/reminders/types.js";

/**
 * Phase 2 Plan 02-02 — /api/todos handler contract (ORC-09).
 *
 * Tests the pure handler helpers directly with stubbed dependencies.
 * The api.ts route wrappers are 6-line wiring — covered by the live smoke
 * step in the plan's <verification> block (curl localhost:3340/api/todos).
 */

function mkTodo(over: Partial<ReminderTodo> = {}): ReminderTodo {
  return {
    id: "AAA-1",
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

function makeDeps(over: Partial<TodosDeps>): TodosDeps {
  return {
    listTodos: async () => [],
    addTodo: async () => mkTodo({ id: "NEW-1" }),
    completeTodo: async () => ({ ok: true }),
    probeAuth: async () => ({ active: "remindctl", authorized: true }),
    editNotes: async () => undefined,
    ...over,
  };
}

test("GET /api/todos returns {todos:[], unauthorized:true} when probeAuth says unauthorized", async () => {
  const deps = makeDeps({
    probeAuth: async () => ({ active: "remindctl", authorized: false }),
  });
  const r = await handleListTodos(deps);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { todos: [], unauthorized: true });
});

test("GET /api/todos gracefully reports listMissing:true when Reminders list does not exist (Rule 1+2 deviation)", async () => {
  // Plan constraint #2: Jarvis/ActiveTasks list does not exist on first run.
  // remindctl rejects with 'List not found'. The endpoint MUST return 200
  // with a banner-friendly payload, never 500 (that would crash the polling
  // loop and the dashboard).
  const deps = makeDeps({
    listTodos: async () => {
      throw new Error('Command failed: remindctl show all --list Jarvis/ActiveTasks --json\nList not found: "Jarvis/ActiveTasks".');
    },
  });
  const r = await handleListTodos(deps);
  assert.equal(r.status, 200);
  const body = r.body as { todos: unknown[]; listMissing: boolean; message: string; unauthorized: boolean };
  assert.deepEqual(body.todos, []);
  assert.equal(body.listMissing, true);
  assert.equal(body.unauthorized, false);
  assert.match(body.message, /Jarvis\/ActiveTasks/);
});

test("GET /api/todos returns sorted open todos (max 100) with metadata parsed", async () => {
  const todos = [
    mkTodo({ id: "a", due: "2026-06-01T00:00:00Z", metadata: { pid: 1, repo: "j", phase: "plan" } }),
    mkTodo({ id: "b", due: null, metadata: { pid: 2, repo: "j", phase: "exec" } }),
    mkTodo({ id: "c", due: "2026-05-01T00:00:00Z", metadata: { pid: 3, repo: "j", phase: "plan" } }),
    mkTodo({ id: "d", completed: true }),
  ];
  const deps = makeDeps({ listTodos: async () => todos });
  const r = await handleListTodos(deps);
  assert.equal(r.status, 200);
  const body = r.body as { todos: ReminderTodo[]; unauthorized: boolean };
  // Completed filtered out
  assert.equal(body.todos.length, 3);
  // Sorted by due ascending — null last
  assert.equal(body.todos[0].id, "c"); // 2026-05-01
  assert.equal(body.todos[1].id, "a"); // 2026-06-01
  assert.equal(body.todos[2].id, "b"); // null
  assert.equal(body.unauthorized, false);
});

test("POST /api/todos with missing title returns 400 title_required", async () => {
  const deps = makeDeps({});
  const r = await handleAddTodo(deps, {});
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: "title_required" });
});

test("POST /api/todos with valid title returns 201 with created todo", async () => {
  let captured: { title: string; notes?: string; due?: string } | null = null;
  const deps = makeDeps({
    addTodo: async (input) => {
      captured = input as typeof captured;
      return mkTodo({ id: "CREATED-1", title: input.title });
    },
  });
  const r = await handleAddTodo(deps, { title: "X" });
  assert.equal(r.status, 201);
  const body = r.body as ReminderTodo;
  assert.equal(body.id, "CREATED-1");
  assert.equal(body.title, "X");
  assert.equal(captured!.title, "X");
});

test("POST /api/todos/:uuid/complete returns 200 {ok:true}", async () => {
  let calledWith: string | null = null;
  const deps = makeDeps({
    completeTodo: async (id) => {
      calledWith = id;
      return { ok: true };
    },
  });
  const r = await handleCompleteTodo(deps, "AAA-1");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(calledWith, "AAA-1");
});

test("PATCH /api/todos/:uuid with missing metadata.pid returns 400 metadata_pid_required", async () => {
  const deps = makeDeps({});
  const r = await handlePatchTodo(deps, "AAA-1", {});
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: "metadata_pid_required" });
});

test("PATCH /api/todos/:uuid with full metadata calls editNotes with canonical line and returns 200", async () => {
  let editCall: { uuid: string; notes: string } | null = null;
  const deps = makeDeps({
    editNotes: async (uuid, notes) => {
      editCall = { uuid, notes };
    },
  });
  const r = await handlePatchTodo(deps, "AAA-1", { metadata: { pid: 99999, repo: "x", phase: "exec" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(editCall!.uuid, "AAA-1");
  assert.equal(editCall!.notes, "pid:99999 repo:x phase:exec");
});

test("PATCH /api/todos/:uuid surfaces 500 todos_patch_failed when editNotes rejects", async () => {
  const deps = makeDeps({
    editNotes: async () => {
      throw new Error("remindctl edit failed");
    },
  });
  const r = await handlePatchTodo(deps, "AAA-1", { metadata: { pid: 1, repo: "x", phase: "plan" } });
  assert.equal(r.status, 500);
  const body = r.body as { error: string; message: string };
  assert.equal(body.error, "todos_patch_failed");
  assert.match(body.message, /remindctl edit failed/);
});
