import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildTranscript } from "../services/orchestrator/snapshot.js";

/**
 * Phase 2 Plan 02-01 — /api/sessions/:pid/transcript contract test (ORC-01).
 *
 * The HTTP handler in dashboard/api.ts is a thin wrapper around
 * buildTranscript() — it discovers the session, validates the pid, then
 * delegates. We test the projection logic directly because importing the
 * full handleApi would pull in connectors/whatsapp + cron + ws and hang.
 * The 404 / 500 envelope shape is enforced by the handler's catch arms
 * (see api.ts) and is exercised manually after router restart.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCH_FIXTURES = join(
  __dirname,
  "..",
  "services",
  "orchestrator",
  "__fixtures__",
);

test("buildTranscript projects assistant + user turns from sample-router.jsonl", async () => {
  const fixture = join(ORCH_FIXTURES, "sample-router.jsonl");
  const result = await buildTranscript(fixture, 12345, 5);
  assert.equal(result.pid, 12345);
  assert.ok(Array.isArray(result.turns), "turns must be an array");
  // Sample has 1 user + 1 assistant + 1 attachment + 1 last-prompt → 2 valid turns
  assert.equal(result.turns.length, 2);
  // Order is preserved from JSONL
  assert.equal(result.turns[0].role, "user");
  assert.equal(result.turns[1].role, "assistant");
  // Assistant turn carries stop_reason + content array
  assert.equal(result.turns[1].stop_reason, "end_turn");
  assert.ok(Array.isArray(result.turns[1].content));
  assert.ok(result.turns[1].content.some((b) => b.type === "text"));
  // User string content normalized to {type:"text"}
  assert.equal(result.turns[0].content.length, 1);
  assert.equal(result.turns[0].content[0].type, "text");
});

test("buildTranscript honors limit parameter", async () => {
  const fixture = join(ORCH_FIXTURES, "sample-router.jsonl");
  const single = await buildTranscript(fixture, 99, 1);
  assert.equal(single.turns.length, 1);
});

test("buildTranscript returns empty turns for missing file", async () => {
  const result = await buildTranscript(
    "/tmp/this-file-does-not-exist-xyz-aabb.jsonl",
    42,
    10,
  );
  assert.equal(result.pid, 42);
  assert.deepEqual(result.turns, []);
});

test("buildTranscript skips attachment + last-prompt rows", async () => {
  const fixture = join(ORCH_FIXTURES, "sample-router.jsonl");
  const result = await buildTranscript(fixture, 1, 50);
  for (const t of result.turns) {
    assert.ok(
      t.role === "assistant" || t.role === "user",
      `unexpected role: ${t.role}`,
    );
  }
});
