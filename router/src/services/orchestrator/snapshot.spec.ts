import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSnapshot } from "./snapshot.js";
import type { LocalSession } from "../localSessions/types.js";
import type { RefinedStatus } from "./types.js";

/**
 * Phase 2 Plan 02-01 — composeSnapshot is pure: it takes pre-fetched
 * inputs (sessions, statusMap, lastByPid, conflictMap) and returns the
 * OrchestratorSnapshot. We unit-test it directly so no tmpdirs / fs / env
 * are required. The async `buildSnapshot` wrapper is exercised end-to-end
 * by the api.snapshot.spec.ts integration test.
 */

function makeSession(overrides: Partial<LocalSession> = {}): LocalSession {
  return {
    pid: 1111,
    cwd: "/tmp/repo",
    repoName: "repo",
    branch: "main",
    status: "working",
    hookEvent: null,
    sessionId: null,
    transcriptPath: null,
    lastActivity: 0,
    tty: null,
    parentCommand: null,
    preview: { lastUserMessage: null, lastAssistantText: null },
    isRouterSpawned: false,
    ...overrides,
  };
}

test("composeSnapshot: returns generated_at + sessions array", () => {
  const snap = composeSnapshot([], new Map(), new Map(), new Map());
  assert.equal(typeof snap.generated_at, "string");
  // Loosely check ISO 8601 — must contain T and Z (UTC).
  assert.match(snap.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(snap.sessions, []);
});

test("composeSnapshot: each entry uses status from statusMap", () => {
  const sessions = [
    makeSession({ pid: 1111 }),
    makeSession({ pid: 2222, repoName: "other" }),
  ];
  const statusMap = new Map<number, RefinedStatus>([
    [1111, "tool_pending"],
    [2222, "awaiting_user_input"],
  ]);
  const lastByPid = new Map<number, string | null>([
    [1111, null],
    [2222, "Approve plan and proceed?"],
  ]);
  const snap = composeSnapshot(sessions, statusMap, lastByPid, new Map());
  assert.equal(snap.sessions[0].status, "tool_pending");
  assert.equal(snap.sessions[1].status, "awaiting_user_input");
});

test("composeSnapshot: suggestion + action + confidence threaded from suggestNext", () => {
  const sessions = [makeSession({ pid: 1111 })];
  const statusMap = new Map<number, RefinedStatus>([[1111, "awaiting_user_input"]]);
  const lastByPid = new Map<number, string | null>([
    [1111, "Approve plan and proceed?"],
  ]);
  const snap = composeSnapshot(sessions, statusMap, lastByPid, new Map());
  const e = snap.sessions[0];
  assert.equal(e.action.type, "inject");
  if (e.action.type !== "inject") throw new Error("type narrowing");
  assert.equal(e.action.text, "y");
  assert.equal(e.confidence, "high");
  assert.equal(e.suggestion, "Approve and proceed");
});

test("composeSnapshot: conflict map is honored", () => {
  const sessions = [
    makeSession({ pid: 1111, cwd: "/repo" }),
    makeSession({ pid: 2222, cwd: "/repo" }),
  ];
  const conflictMap = new Map<number, number | null>([
    [1111, 2222],
    [2222, 1111],
  ]);
  const snap = composeSnapshot(sessions, new Map(), new Map(), conflictMap);
  assert.equal(snap.sessions[0].conflict, 2222);
  assert.equal(snap.sessions[1].conflict, 1111);
});

test("composeSnapshot: independent worktrees produce no conflict", () => {
  const sessions = [
    makeSession({ pid: 1111, cwd: "/worktrees/A" }),
    makeSession({ pid: 2222, cwd: "/worktrees/B" }),
  ];
  // Caller (buildSnapshot) sets nulls when detectConflict returns false.
  const conflictMap = new Map<number, number | null>([
    [1111, null],
    [2222, null],
  ]);
  const snap = composeSnapshot(sessions, new Map(), new Map(), conflictMap);
  assert.equal(snap.sessions[0].conflict, null);
  assert.equal(snap.sessions[1].conflict, null);
});

test("composeSnapshot: todo_link + tmux always null in Plan 02-01", () => {
  const sessions = [makeSession({ pid: 1111 })];
  const snap = composeSnapshot(sessions, new Map(), new Map(), new Map());
  assert.equal(snap.sessions[0].todo_link, null);
  assert.equal(snap.sessions[0].tmux, null);
});

test("composeSnapshot: missing pid in statusMap defaults to idle", () => {
  const sessions = [makeSession({ pid: 9999 })];
  const snap = composeSnapshot(sessions, new Map(), new Map(), new Map());
  assert.equal(snap.sessions[0].status, "idle");
});
