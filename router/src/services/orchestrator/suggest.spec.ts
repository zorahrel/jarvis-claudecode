import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestNext } from "./suggest.js";

/**
 * Phase 2 Plan 02-01 — deterministic suggestion engine (ORC-04).
 *
 * Pure table — no network, no LLM. Auto-pilot (Plan 02-05) gates on
 * confidence==="high" + action.type==="inject" so the test cases below
 * lock down exactly which paths are auto-approvable.
 */

test("suggestNext: awaiting_user_input + explicit approve prompt → inject 'y' high", () => {
  const s = suggestNext({
    refinedStatus: "awaiting_user_input",
    lastAssistantSummary: "Approve plan and proceed?",
  });
  assert.equal(s.action.type, "inject");
  if (s.action.type !== "inject") throw new Error("type narrowing");
  assert.equal(s.action.text, "y");
  assert.equal(s.confidence, "high");
});

test("suggestNext: awaiting_user_input + ambiguous prose → inject 'ok' low", () => {
  const s = suggestNext({
    refinedStatus: "awaiting_user_input",
    lastAssistantSummary: "Some prose without question mark",
  });
  assert.equal(s.action.type, "inject");
  if (s.action.type !== "inject") throw new Error("type narrowing");
  assert.equal(s.action.text, "ok");
  assert.equal(s.confidence, "low");
});

test("suggestNext: awaiting_user_input + null summary → inject 'ok' low", () => {
  const s = suggestNext({
    refinedStatus: "awaiting_user_input",
    lastAssistantSummary: null,
  });
  assert.equal(s.action.type, "inject");
  assert.equal(s.confidence, "low");
});

test("suggestNext: tool_pending → none high", () => {
  const s = suggestNext({ refinedStatus: "tool_pending", lastAssistantSummary: null });
  assert.equal(s.action.type, "none");
  assert.equal(s.confidence, "high");
});

test("suggestNext: crashed → restart medium", () => {
  const s = suggestNext({ refinedStatus: "crashed", lastAssistantSummary: null });
  assert.equal(s.action.type, "restart");
  assert.equal(s.confidence, "medium");
});

test("suggestNext: working → none high", () => {
  const s = suggestNext({ refinedStatus: "working", lastAssistantSummary: null });
  assert.equal(s.action.type, "none");
  assert.equal(s.confidence, "high");
});

test("suggestNext: idle → none low", () => {
  const s = suggestNext({ refinedStatus: "idle", lastAssistantSummary: null });
  assert.equal(s.action.type, "none");
  assert.equal(s.confidence, "low");
});

test("suggestNext: bare question mark also triggers high confidence approve", () => {
  const s = suggestNext({
    refinedStatus: "awaiting_user_input",
    lastAssistantSummary: "Should I continue with the plan?",
  });
  assert.equal(s.action.type, "inject");
  assert.equal(s.confidence, "high");
});
