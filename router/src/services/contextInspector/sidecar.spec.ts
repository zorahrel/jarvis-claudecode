import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import {
  writeSessionSidecar,
  readSessionSidecar,
  removeSessionSidecar,
  listSessionSidecars,
  ACTIVE_SESSIONS_DIR,
} from "./sidecar.js";

// Use a high PID range to avoid collision with real router-spawned processes
// during dev runs.
const TEST_PID_BASE = 999000;
const TEST_PID_RANGE = 20;

beforeEach(async () => {
  for (let i = 0; i < TEST_PID_RANGE; i++) {
    await removeSessionSidecar(TEST_PID_BASE + i);
  }
});

after(async () => {
  for (let i = 0; i < TEST_PID_RANGE; i++) {
    await removeSessionSidecar(TEST_PID_BASE + i);
  }
});

test("writeSessionSidecar creates parent dir and persists JSON", async () => {
  const pid = TEST_PID_BASE + 1;
  await writeSessionSidecar({
    pid,
    sessionKey: "telegram:42:jarvis",
    agent: "jarvis",
    workspace: "/tmp/x",
    model: "opus",
    resolvedModel: "claude-opus-4-7",
    fullAccess: true,
    inheritUserScope: true,
    spawnedAt: Date.now(),
  });
  const stat = await fs.stat(ACTIVE_SESSIONS_DIR);
  assert.ok(stat.isDirectory(), "ACTIVE_SESSIONS_DIR exists after write");
});

test("readSessionSidecar returns the persisted object", async () => {
  const pid = TEST_PID_BASE + 2;
  const original = {
    pid,
    sessionKey: "whatsapp:393:business",
    agent: "business",
    workspace: "/tmp/y",
    model: "sonnet",
    fullAccess: false,
    inheritUserScope: true,
    spawnedAt: 1700000000000,
  };
  await writeSessionSidecar(original);
  const read = await readSessionSidecar(pid);
  assert.ok(read);
  assert.equal(read!.sessionKey, "whatsapp:393:business");
  assert.equal(read!.agent, "business");
  assert.equal(read!.workspace, "/tmp/y");
  assert.equal(read!.fullAccess, false);
  assert.equal(read!.inheritUserScope, true);
});

test("removeSessionSidecar deletes the file", async () => {
  const pid = TEST_PID_BASE + 3;
  await writeSessionSidecar({
    pid,
    sessionKey: "k",
    agent: "a",
    workspace: "/w",
    model: "sonnet",
    fullAccess: false,
    inheritUserScope: false,
    spawnedAt: 0,
  });
  await removeSessionSidecar(pid);
  const after = await readSessionSidecar(pid);
  assert.equal(after, null);
});

test("readSessionSidecar returns null on missing file (no throw)", async () => {
  const r = await readSessionSidecar(99999998);
  assert.equal(r, null);
});

test("writeSessionSidecar overwrites idempotently", async () => {
  const pid = TEST_PID_BASE + 4;
  await writeSessionSidecar({
    pid,
    sessionKey: "v1",
    agent: "a",
    workspace: "/w",
    model: "sonnet",
    fullAccess: false,
    inheritUserScope: false,
    spawnedAt: 0,
  });
  await writeSessionSidecar({
    pid,
    sessionKey: "v2",
    agent: "a",
    workspace: "/w",
    model: "sonnet",
    fullAccess: false,
    inheritUserScope: false,
    spawnedAt: 1,
  });
  const read = await readSessionSidecar(pid);
  assert.equal(read!.sessionKey, "v2");
  assert.equal(read!.spawnedAt, 1);
});

test("removeSessionSidecar on missing file does not throw", async () => {
  await removeSessionSidecar(99999997);
  // If we got here without throwing, test passes
  assert.ok(true);
});

test("listSessionSidecars returns all live sidecars", async () => {
  const pid1 = TEST_PID_BASE + 5;
  const pid2 = TEST_PID_BASE + 6;
  await writeSessionSidecar({
    pid: pid1,
    sessionKey: "k1",
    agent: "a1",
    workspace: "/w",
    model: "sonnet",
    fullAccess: false,
    inheritUserScope: false,
    spawnedAt: 0,
  });
  await writeSessionSidecar({
    pid: pid2,
    sessionKey: "k2",
    agent: "a2",
    workspace: "/w",
    model: "sonnet",
    fullAccess: false,
    inheritUserScope: false,
    spawnedAt: 0,
  });
  const all = await listSessionSidecars();
  const found1 = all.find((e) => e.pid === pid1);
  const found2 = all.find((e) => e.pid === pid2);
  assert.ok(found1, "expected sidecar for pid1");
  assert.ok(found2, "expected sidecar for pid2");
});
