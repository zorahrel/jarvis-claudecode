import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { listTodos, addTodo, completeTodo, probeAuth, getActiveCli } from "./cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "__fixtures__");

/**
 * Phase 2 Plan 02-02 — reminders CLI wrapper (ORC-06).
 *
 * Tests use dependency injection: each function takes an `execFn` argument
 * defaulting to the real promisified execFile. Specs pass a stub that
 * returns canned stdout from the captured fixtures, so no actual CLI
 * binary is required to verify the wrapper logic.
 */

type ExecCall = { cmd: string; args: string[] };
function makeExecStub(behaviors: Array<(call: ExecCall) => { stdout: string; stderr?: string } | Promise<{ stdout: string; stderr?: string }> | { reject: { code?: number; stderr?: string } }>) {
  const calls: ExecCall[] = [];
  let i = 0;
  const fn = async (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    const call = { cmd, args };
    calls.push(call);
    const beh = behaviors[i] ?? behaviors[behaviors.length - 1];
    i++;
    const r = await beh(call);
    if ("reject" in r) {
      const err: Error & { code?: number; stderr?: string } = new Error(r.reject.stderr ?? "exec rejected");
      err.code = r.reject.code;
      err.stderr = r.reject.stderr;
      throw err;
    }
    return { stdout: r.stdout, stderr: r.stderr ?? "" };
  };
  return { fn, calls };
}

test("listTodos: returns parsed array from sample-show-active.json fixture (live remindctl 0.1.1 shape)", async () => {
  const fixture = await readFile(join(FIXTURES, "sample-show-active.json"), "utf8");
  const stub = makeExecStub([() => ({ stdout: fixture })]);
  const todos = await listTodos("Jarvis/ActiveTasks", "remindctl", stub.fn);
  assert.equal(todos.length, 3);
  assert.equal(todos[0].title, "Plan 02-01 — refinedStatus");
  // Normalizer: live remindctl emits `listName` + `isCompleted` + string priority;
  // we must surface them as `list` + `completed` + numeric priority so the
  // documented ReminderTodo contract holds.
  assert.equal(todos[0].list, "Jarvis/ActiveTasks");
  assert.equal(todos[0].completed, false);
  assert.equal(todos[0].priority, 0); // "none" → 0
  // Metadata parsed alongside raw notes
  assert.equal(todos[0].metadata.pid, 12345);
  assert.equal(todos[0].metadata.repo, "jarvis");
  assert.equal(todos[0].metadata.phase, "plan");
  // Second todo has prose + metadata
  assert.equal(todos[1].metadata.pid, 67890);
  assert.equal(todos[1].metadata.phase, "exec");
  // Third todo has no metadata
  assert.deepEqual(todos[2].metadata, {});
  // Verify the call args
  assert.deepEqual(stub.calls[0].args, ["show", "all", "--list", "Jarvis/ActiveTasks", "--json"]);
});

test("listTodos: normalizer maps priority strings (none/low/medium/high) to 0/1/5/9", async () => {
  const raw = JSON.stringify([
    { id: "1", title: "n", listName: "L", notes: null, due: null, priority: "none", isCompleted: false },
    { id: "2", title: "l", listName: "L", notes: null, due: null, priority: "low", isCompleted: false },
    { id: "3", title: "m", listName: "L", notes: null, due: null, priority: "medium", isCompleted: false },
    { id: "4", title: "h", listName: "L", notes: null, due: null, priority: "high", isCompleted: false },
  ]);
  const stub = makeExecStub([() => ({ stdout: raw })]);
  const todos = await listTodos("L", "remindctl", stub.fn);
  assert.equal(todos[0].priority, 0);
  assert.equal(todos[1].priority, 1);
  assert.equal(todos[2].priority, 5);
  assert.equal(todos[3].priority, 9);
});

test("addTodo: builds correct execFile args including metadata appended to notes", async () => {
  const created = { id: "NEW-1", title: "x", list: "Jarvis/ActiveTasks", due: null, notes: "pid:1 repo:r phase:plan", priority: 0, completed: false };
  const stub = makeExecStub([() => ({ stdout: JSON.stringify(created) })]);
  const result = await addTodo(
    { title: "x", metadata: { pid: 1, repo: "r", phase: "plan" } },
    "Jarvis/ActiveTasks",
    "remindctl",
    stub.fn,
  );
  assert.equal(result.id, "NEW-1");
  assert.equal(result.metadata.pid, 1);
  // Verify exec was called with the canonical args including the metadata-appended notes
  const args = stub.calls[0].args;
  assert.equal(args[0], "add");
  assert.equal(args[1], "x");
  assert.equal(args[2], "--list");
  assert.equal(args[3], "Jarvis/ActiveTasks");
  // Notes flag carries the formatted metadata
  const notesIdx = args.indexOf("--notes");
  assert.ok(notesIdx > 0);
  assert.equal(args[notesIdx + 1], "pid:1 repo:r phase:plan");
  assert.ok(args.includes("--json"));
});

test("completeTodo: passes id-prefix to remindctl complete --json", async () => {
  const stub = makeExecStub([() => ({ stdout: '{"ok":true,"completed":[]}' })]);
  const r = await completeTodo("AAAA0001", "remindctl", stub.fn);
  assert.equal(r.ok, true);
  assert.deepEqual(stub.calls[0].args, ["complete", "AAAA0001", "--json"]);
});

test("probeAuth: returns {authorized:false} when execFile rejects with stderr containing 'not authorized'", async () => {
  const stub = makeExecStub([() => ({ reject: { code: 1, stderr: "Reminders access not authorized" } })]);
  const probe = await probeAuth("remindctl", stub.fn);
  assert.equal(probe.authorized, false);
  assert.equal(probe.active, "remindctl");
});

test("getActiveCli: probes remindctl first, falls back to apple-reminders-cli, ekctl, then fallback-file", async () => {
  // Case 1: remindctl present
  const stub1 = makeExecStub([() => ({ stdout: "remindctl 0.1.1" })]);
  assert.equal(await getActiveCli(stub1.fn), "remindctl");
  assert.equal(stub1.calls[0].cmd, "remindctl");

  // Case 2: remindctl missing, reminder (apple-reminders-cli) present
  const stub2 = makeExecStub([
    () => ({ reject: { code: 127, stderr: "command not found: remindctl" } }),
    () => ({ stdout: "reminder 1.0" }),
  ]);
  assert.equal(await getActiveCli(stub2.fn), "apple-reminders-cli");
  assert.equal(stub2.calls[1].cmd, "reminder");

  // Case 3: only ekctl
  const stub3 = makeExecStub([
    () => ({ reject: { code: 127, stderr: "missing" } }),
    () => ({ reject: { code: 127, stderr: "missing" } }),
    () => ({ stdout: "ekctl 0.5" }),
  ]);
  assert.equal(await getActiveCli(stub3.fn), "ekctl");

  // Case 4: nothing installed → fallback-file
  const stub4 = makeExecStub([
    () => ({ reject: { code: 127, stderr: "missing" } }),
    () => ({ reject: { code: 127, stderr: "missing" } }),
    () => ({ reject: { code: 127, stderr: "missing" } }),
  ]);
  assert.equal(await getActiveCli(stub4.fn), "fallback-file");
});
