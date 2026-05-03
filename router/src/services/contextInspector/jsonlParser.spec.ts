import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  extractToolUseEvents,
  countCompactions,
  sumTokens,
  countTurns,
  readJsonlTailLines,
} from "./jsonlParser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "__fixtures__");
const TOOL_USE_FIXTURE = join(FIXTURES, "sample-tool-use-events.jsonl");
const BARE_FIXTURE = join(FIXTURES, "sample-bare.jsonl");
const MISSING = "/tmp/this-file-does-not-exist-xyz-12345.jsonl";

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
