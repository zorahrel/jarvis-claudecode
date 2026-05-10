import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTodoMetadata, formatTodoMetadata } from "./metadata.js";

/**
 * Phase 2 Plan 02-02 — metadata parser/formatter (ORC-08).
 *
 * The body of every Jarvis-managed Reminder ends with the canonical metadata
 * line `pid:NNNN repo:<name> phase:<plan|exec|review>`. The parser extracts
 * those fields, the formatter rebuilds the canonical line. Round-trip parity
 * is required so user-edited prose survives our writebacks.
 */

test("parseTodoMetadata: extracts pid/repo/phase from metadata-only notes", () => {
  const m = parseTodoMetadata("pid:1234 repo:foo phase:plan");
  assert.deepEqual(m, { pid: 1234, repo: "foo", phase: "plan" });
});

test("parseTodoMetadata: extracts metadata when preceded by user prose", () => {
  const m = parseTodoMetadata("user note\n\npid:1234 repo:foo phase:exec");
  assert.deepEqual(m, { pid: 1234, repo: "foo", phase: "exec" });
});

test("parseTodoMetadata: returns empty object on null/undefined/missing-meta", () => {
  assert.deepEqual(parseTodoMetadata(null), {});
  assert.deepEqual(parseTodoMetadata(undefined), {});
  assert.deepEqual(parseTodoMetadata(""), {});
  assert.deepEqual(parseTodoMetadata("just a normal note with no metadata"), {});
});

test("formatTodoMetadata: produces canonical 'pid:N repo:R phase:P' line", () => {
  assert.equal(formatTodoMetadata({ pid: 99, repo: "x", phase: "review" }), "pid:99 repo:x phase:review");
});

test("Round-trip: parseTodoMetadata(formatTodoMetadata(m)) === m", () => {
  const cases = [
    { pid: 1, repo: "jarvis", phase: "plan" as const },
    { pid: 999999, repo: "topics", phase: "exec" as const },
    { pid: 42, repo: "armonia", phase: "review" as const },
  ];
  for (const m of cases) {
    const formatted = formatTodoMetadata(m);
    const parsed = parseTodoMetadata(formatted);
    assert.deepEqual(parsed, m, `round-trip failed for ${JSON.stringify(m)}`);
  }
});
