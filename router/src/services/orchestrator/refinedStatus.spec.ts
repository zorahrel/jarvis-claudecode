import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { deriveRefinedStatus, refinedStatusFor } from "./refinedStatus.js";
import type { LocalSession } from "../localSessions/types.js";

/**
 * Phase 2 Plan 02-01 — refinedStatus 5-state derivation (ORC-02).
 *
 * To exercise mtime-based rules deterministically, we copy each fixture
 * JSONL to a tmpdir and force `mtime` via fs.utimes(). The fixture content
 * itself drives the stop_reason / pending-tool-use signals; the mtime
 * forces the awaiting_user_input vs working vs idle decision.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "__fixtures__");
const NOW_S = () => Math.floor(Date.now() / 1000);

async function fixtureWithMtime(name: string, ageMs: number): Promise<string> {
  const tmp = await fs.mkdtemp(join(tmpdir(), "rs-"));
  const dest = join(tmp, basename(name));
  const src = join(FIXTURES, name);
  await fs.copyFile(src, dest);
  const target = (Date.now() - ageMs) / 1000;
  await fs.utimes(dest, target, target);
  return dest;
}

function makeSession(transcriptPath: string | null, pid = 12345): LocalSession {
  return {
    pid,
    cwd: "/tmp/rs-test",
    repoName: "test",
    branch: "main",
    status: "working",
    hookEvent: null,
    sessionId: null,
    transcriptPath,
    lastActivity: 0,
    tty: null,
    parentCommand: null,
    preview: { lastUserMessage: null, lastAssistantText: null },
    isRouterSpawned: false,
  };
}

test("deriveRefinedStatus: tool_pending fixture (recent mtime) → tool_pending", async () => {
  const path = await fixtureWithMtime("sample-tool-pending.jsonl", 2_000);
  const status = await deriveRefinedStatus(makeSession(path));
  assert.equal(status, "tool_pending");
});

test("deriveRefinedStatus: awaiting-input fixture (mtime 60s ago) → awaiting_user_input", async () => {
  const path = await fixtureWithMtime("sample-awaiting-input.jsonl", 60_000);
  const status = await deriveRefinedStatus(makeSession(path));
  assert.equal(status, "awaiting_user_input");
});

test("deriveRefinedStatus: router fixture (mtime now) → working", async () => {
  const path = await fixtureWithMtime("sample-router.jsonl", 1_000);
  const status = await deriveRefinedStatus(makeSession(path));
  assert.equal(status, "working");
});

test("deriveRefinedStatus: idle fixture (mtime 5 min ago, no question) → idle", async () => {
  // sample-idle ends with stop_reason=end_turn but text "Done. Let me know..."
  // Without a "?" or approval keyword, it's NOT awaiting; the locked rules in
  // refinedStatus only check stop_reason+mtime, so 5min-old end_turn ≥ 30s
  // threshold → awaiting_user_input. To get a clean "idle" signal we need a
  // transcript with no last assistant turn (e.g. a bare-cli before the model
  // has replied) OR a transcript whose last turn lacks stop_reason. The
  // research-locked rule is: stop_reason=="end_turn" AND age >= 30s →
  // awaiting_user_input. Anything else with old mtime → idle.
  // We synthesize an empty transcript path to lock down the 'idle' branch.
  const tmp = await fs.mkdtemp(join(tmpdir(), "rs-empty-"));
  const empty = join(tmp, "empty.jsonl");
  await fs.writeFile(empty, "", "utf8");
  const target = (Date.now() - 5 * 60_000) / 1000;
  await fs.utimes(empty, target, target);
  const status = await deriveRefinedStatus(makeSession(empty));
  // No assistant turn → not tool_pending, not awaiting (last is null), age >= idle threshold → idle
  assert.equal(status, "idle");
});

test("deriveRefinedStatus: crashed fixture + pidAlive=false → crashed", async () => {
  const path = await fixtureWithMtime("sample-crashed.jsonl", 5_000);
  const status = await deriveRefinedStatus(makeSession(path), { pidAlive: false });
  assert.equal(status, "crashed");
});

test("deriveRefinedStatus: no transcript path → idle", async () => {
  const status = await deriveRefinedStatus(makeSession(null));
  assert.equal(status, "idle");
});

test("refinedStatusFor: returns map keyed by pid", async () => {
  const path = await fixtureWithMtime("sample-router.jsonl", 1_000);
  const sessions = [makeSession(path, 1111), makeSession(path, 2222)];
  // Reset the in-module cache by waiting past CACHE_TTL_MS (2s) is too slow.
  // Instead, we exercise the entry path with a fresh map each call: the test
  // only verifies the SHAPE — keys are pids, values are RefinedStatus.
  const map = await refinedStatusFor(sessions);
  assert.ok(map instanceof Map);
  assert.ok(map.has(1111) || map.has(2222), "should have at least one entry");
});

void NOW_S; // keep the helper around in case future tests need wall time
