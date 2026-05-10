/**
 * Phase 2 Plan 02-04 — handleInject contract (ORC-16, ORC-17, ORC-19).
 *
 * Pure-handler tests with stubbed deps. Live tmux end-to-end verified via
 * the curl smoke step in the plan's <verification> block.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleInject, type TmuxDeps } from "./api.tmux.js";
import type { LocalSession } from "../services/localSessions/types.js";
import type { AuditEntry } from "agent-conductor";

function mkSession(over: Partial<LocalSession> = {}): LocalSession {
  return {
    pid: 1234,
    cwd: "/tmp/repo-a",
    repoName: "repo-a",
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
    ...over,
  };
}

function mkDeps(over: Partial<TmuxDeps> = {}): TmuxDeps & { audited: AuditEntry[]; sent: Array<{ pane: string; text: string }> } {
  const audited: AuditEntry[] = [];
  const sent: Array<{ pane: string; text: string }> = [];
  const base: TmuxDeps = {
    discoverSessions: async () => [mkSession()],
    findPane: async () => ({ session: "s", pane: "%2" }),
    sendKeys: async (paneId, text) => { sent.push({ pane: paneId, text }); },
    capturePane: async () => "captured\n",
    detectConflict: async () => false,
    appendAudit: async (entry) => { audited.push(entry); },
    ...over,
  };
  return { ...base, audited, sent };
}

test("POST inject — text required (400 text_required)", async () => {
  const deps = mkDeps();
  const r = await handleInject(deps, 1234, { source: "user-approved" });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: "text_required" });
});

test("POST inject — invalid source (400 invalid_source)", async () => {
  const deps = mkDeps();
  const r = await handleInject(deps, 1234, { text: "y", source: "bogus" });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: "invalid_source" });
});

test("POST inject — session not in discoverLocalSessions (404 session_not_found)", async () => {
  const deps = mkDeps({ discoverSessions: async () => [] });
  const r = await handleInject(deps, 1234, { text: "y", source: "user-approved" });
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { error: "session_not_found" });
});

test("POST inject — cwd lock conflict without force (409 lock_conflict + conflictPid)", async () => {
  const deps = mkDeps({
    discoverSessions: async () => [
      mkSession({ pid: 1234, cwd: "/tmp/shared" }),
      mkSession({ pid: 5678, cwd: "/tmp/shared/sub" }),
    ],
    detectConflict: async (a, b) => a === "/tmp/shared" && b === "/tmp/shared/sub",
  });
  const r = await handleInject(deps, 1234, { text: "y", source: "user-approved" });
  assert.equal(r.status, 409);
  assert.equal((r.body as { error: string }).error, "lock_conflict");
  assert.equal((r.body as { conflictPid: number }).conflictPid, 5678);
});

test("POST inject — no tmux pane (409 no_tmux)", async () => {
  const deps = mkDeps({ findPane: async () => null });
  const r = await handleInject(deps, 1234, { text: "y", source: "user-approved" });
  assert.equal(r.status, 409);
  assert.equal((r.body as { error: string }).error, "no_tmux");
});

test("POST inject — happy path: 200 ok with paneId + auditTs + audit appended", async () => {
  const deps = mkDeps();
  const r = await handleInject(deps, 1234, { text: "hello", source: "user-approved" });
  assert.equal(r.status, 200);
  const body = r.body as { ok: boolean; paneId: string; auditTs: number };
  assert.equal(body.ok, true);
  assert.equal(body.paneId, "%2");
  assert.ok(typeof body.auditTs === "number" && body.auditTs > 0);
  assert.equal(deps.sent.length, 1);
  assert.deepEqual(deps.sent[0], { pane: "%2", text: "hello" });
  assert.equal(deps.audited.length, 1);
  assert.equal(deps.audited[0].pid, 1234);
  assert.equal(deps.audited[0].action, "inject");
  assert.equal(deps.audited[0].text, "hello");
  assert.equal(deps.audited[0].source, "user-approved");
});

test("POST inject — force=true bypasses lock_conflict check", async () => {
  const deps = mkDeps({
    discoverSessions: async () => [
      mkSession({ pid: 1234, cwd: "/tmp/shared" }),
      mkSession({ pid: 5678, cwd: "/tmp/shared/sub" }),
    ],
    detectConflict: async () => true, // would block without force
  });
  const r = await handleInject(deps, 1234, {
    text: "y",
    source: "user-approved",
    force: true,
  });
  assert.equal(r.status, 200);
  assert.equal(deps.sent.length, 1);
  assert.equal(deps.audited.length, 1);
});
