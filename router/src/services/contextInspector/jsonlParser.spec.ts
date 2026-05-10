import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import {
  extractToolUseEvents,
  countCompactions,
  sumTokens,
  countTurns,
  readJsonlTailLines,
  extractLastAssistantTurn,
  extractPendingToolUses,
  getStopReason,
} from "./jsonlParser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "__fixtures__");
const TOOL_USE_FIXTURE = join(FIXTURES, "sample-tool-use-events.jsonl");
const BARE_FIXTURE = join(FIXTURES, "sample-bare.jsonl");
const MISSING = "/tmp/this-file-does-not-exist-xyz-12345.jsonl";

// Phase 2 (Plan 02-01) fixtures live under services/orchestrator/__fixtures__.
// We resolve them via relative path from this spec so the JSONL parser tests
// stay close to the fixtures that exercise the new helpers.
const ORCH_FIXTURES = join(__dirname, "..", "orchestrator", "__fixtures__");
const ROUTER_FIXTURE = join(ORCH_FIXTURES, "sample-router.jsonl");
const TOOL_PENDING_FIXTURE = join(ORCH_FIXTURES, "sample-tool-pending.jsonl");
const CRASHED_FIXTURE = join(ORCH_FIXTURES, "sample-crashed.jsonl");

test("extractToolUseEvents: returns mcp__zenda + Read/Bash from sample-tool-use-events.jsonl", async () => {
  const events = await extractToolUseEvents(TOOL_USE_FIXTURE);
  assert.ok(events.length >= 1, "should have at least 1 tool_use event");
  const names = events.map((e) => e.name);
  // sample-tool-use-events.jsonl includes mcp__zenda__list_topics + Read + Bash
  assert.ok(
    names.some((n) => n.startsWith("mcp__zenda")),
    `expected mcp__zenda call, got: ${names.join(",")}`,
  );
});

test("extractToolUseEvents: lastN=2 returns ≤ entries than default lastN=5", async () => {
  const all = await extractToolUseEvents(TOOL_USE_FIXTURE, 5);
  const recent = await extractToolUseEvents(TOOL_USE_FIXTURE, 2);
  assert.ok(recent.length <= all.length, "lastN=2 should not exceed lastN=5");
});

test("countCompactions: sample-bare.jsonl has at least 1 isCompactSummary line", async () => {
  const n = await countCompactions(BARE_FIXTURE);
  assert.ok(n >= 1, `expected >= 1 compaction marker, got ${n}`);
});

test("countCompactions: missing file returns 0 (no throw)", async () => {
  const n = await countCompactions(MISSING);
  assert.equal(n, 0);
});

test("sumTokens: sample-bare.jsonl total >= 94000", async () => {
  const s = await sumTokens(BARE_FIXTURE);
  // Last turn alone has 1 + 10687 + 83626 + 435 = 94749, plus any earlier turns
  assert.ok(s.total >= 94000, `expected total >= 94000, got ${s.total}`);
  assert.ok(s.cacheRead >= 80000, `expected cacheRead high, got ${s.cacheRead}`);
});

test("readJsonlTailLines: missing file returns []", async () => {
  const lines = await readJsonlTailLines(MISSING);
  assert.deepEqual(lines, []);
});

test("countTurns: sample-bare.jsonl has at least 1 assistant turn", async () => {
  const n = await countTurns(BARE_FIXTURE);
  assert.ok(n >= 1, `expected >= 1 turn, got ${n}`);
});

// ─── Phase 2 (Plan 02-01) — orchestrator helpers ───────────────────────────

test("extractLastAssistantTurn returns null on empty file", async () => {
  const tmp = await fs.mkdtemp(join(tmpdir(), "jsonl-empty-"));
  try {
    const empty = join(tmp, "empty.jsonl");
    await fs.writeFile(empty, "", "utf8");
    const result = await extractLastAssistantTurn(empty);
    assert.equal(result, null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("extractLastAssistantTurn returns last assistant with stop_reason", async () => {
  const result = await extractLastAssistantTurn(ROUTER_FIXTURE);
  assert.ok(result, "should return last assistant turn");
  assert.equal(result!.stop_reason, "end_turn");
  assert.ok(Array.isArray(result!.content), "content should be an array");
  assert.ok(
    result!.content.some((b) => b.type === "text"),
    "expected at least one text block",
  );
  assert.equal(typeof result!.uuid, "string");
  assert.equal(typeof result!.timestamp, "string");
});

test("extractPendingToolUses returns unmatched tool_use ids", async () => {
  const result = await extractPendingToolUses(TOOL_PENDING_FIXTURE);
  assert.equal(result.length, 1, `expected 1 pending tool_use, got ${result.length}`);
  assert.equal(result[0].id, "toolu_01abc");
  assert.equal(result[0].name, "Read");
});

test("extractPendingToolUses returns empty array when all tool_use have matching tool_result", async () => {
  const tmp = await fs.mkdtemp(join(tmpdir(), "jsonl-tp-matched-"));
  try {
    const path = join(tmp, "matched.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_match_01", name: "Read", input: { file_path: "/x" } }],
          stop_reason: "tool_use",
        },
        timestamp: "2026-05-06T10:00:00.000Z",
        uuid: "match-aaaa",
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_match_01", content: "ok" },
          ],
        },
        timestamp: "2026-05-06T10:00:00.500Z",
        uuid: "match-bbbb",
      }),
    ];
    await fs.writeFile(path, lines.join("\n") + "\n", "utf8");
    const result = await extractPendingToolUses(path);
    assert.deepEqual(result, []);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("getStopReason returns last assistant stop_reason", async () => {
  const ok = await getStopReason(ROUTER_FIXTURE);
  assert.equal(ok, "end_turn");
  const crashed = await getStopReason(CRASHED_FIXTURE);
  assert.equal(crashed, null);
});
