import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, composeSnapshot } from "../services/orchestrator/snapshot.js";

/**
 * Phase 2 Plan 02-01 — /api/sessions/snapshot contract test (ORC-03).
 *
 * The HTTP handler in dashboard/api.ts simply calls buildSnapshot() and
 * serializes the result. We test buildSnapshot directly here (calls
 * discoverLocalSessions which works on any host — empty array on CI
 * with no live Claude sessions) because importing handleApi would pull
 * in connectors that hang the test runner.
 */

test("buildSnapshot returns OrchestratorSnapshot envelope", async () => {
  const snap = await buildSnapshot();
  assert.equal(typeof snap.generated_at, "string");
  assert.match(snap.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Array.isArray(snap.sessions), "sessions must be an array");
  // On CI (no live Claude sessions) snap.sessions === []. On a developer
  // machine with running Claude Code, each entry MUST have the locked shape:
  for (const e of snap.sessions) {
    assert.equal(typeof e.pid, "number");
    assert.equal(typeof e.cwd, "string");
    assert.ok(
      ["awaiting_user_input", "tool_pending", "crashed", "working", "idle"].includes(e.status),
      `unexpected status: ${e.status}`,
    );
    assert.ok(["low", "medium", "high"].includes(e.confidence));
    assert.ok(e.action && typeof e.action.type === "string");
  }
});

test("composeSnapshot is the pure backbone of buildSnapshot — exposed for unit tests", () => {
  const snap = composeSnapshot([], new Map(), new Map(), new Map());
  assert.deepEqual(snap.sessions, []);
});
