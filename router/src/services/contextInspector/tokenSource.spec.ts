import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  getLiveTokensFromSdk,
  getLiveTokensFromJsonl,
  recordTaskProgress,
  recordTurnResult,
  _resetForTests,
  normalizeModel,
} from "./tokenSource.js";
import type { SdkSessionLike } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "__fixtures__");

beforeEach(() => _resetForTests());

test("getLiveTokensFromSdk returns task_progress signal when available", () => {
  const session: SdkSessionLike = { sessionKey: "test:1", resolvedModel: "claude-sonnet-4-6", totalInputTokens: 0, compactionCount: 0, alive: true };
  recordTaskProgress("test:1", 87432);
  const snap = getLiveTokensFromSdk(session);
  assert.equal(snap.totalTokens, 87432);
  assert.equal(snap.source, "sdk-task-progress");
  assert.equal(snap.contextWindow, 200000);
});

test("getLiveTokensFromSdk falls back to lastTurnUsage sum when no task_progress", () => {
  const session: SdkSessionLike = { sessionKey: "test:2", resolvedModel: "claude-opus-4-7", totalInputTokens: 0, compactionCount: 0, alive: true };
  const snap = getLiveTokensFromSdk(session, {
    input_tokens: 100,
    output_tokens: 200,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 2000,
  });
  assert.equal(snap.totalTokens, 3300);
  assert.equal(snap.source, "sdk-result");
});

test("recordTurnResult preserves prior totalTokens and attaches lastTurnUsage (BLOCKER 1 fix)", () => {
  const session: SdkSessionLike = { sessionKey: "test:turn", resolvedModel: "claude-sonnet-4-6", totalInputTokens: 0, compactionCount: 0, alive: true };
  // First, task_progress arrives with totalTokens=50000.
  recordTaskProgress("test:turn", 50000);
  // Then, the result event arrives with per-field usage.
  recordTurnResult("test:turn", {
    input_tokens: 1500,
    output_tokens: 800,
    cache_creation_input_tokens: 30000,
    cache_read_input_tokens: 50000,
  });
  // The snapshot should preserve totalTokens=50000 AND have lastTurnUsage attached for cost calc.
  const snap = getLiveTokensFromSdk(session);
  assert.equal(snap.totalTokens, 50000, "totalTokens from task_progress should be preserved");
  assert.ok(snap.lastTurnUsage, "lastTurnUsage should be attached");
  assert.equal(snap.lastTurnUsage!.cache_read_input_tokens, 50000);
  assert.equal(snap.lastTurnUsage!.output_tokens, 800);
});

test("recordTurnResult without prior task_progress synthesizes totalTokens from usage sum", () => {
  const session: SdkSessionLike = { sessionKey: "test:noprog", resolvedModel: "claude-sonnet-4-6", totalInputTokens: 0, compactionCount: 0, alive: true };
  recordTurnResult("test:noprog", {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 300,
  });
  const snap = getLiveTokensFromSdk(session);
  assert.equal(snap.totalTokens, 650);
  assert.ok(snap.lastTurnUsage);
});

test("getLiveTokensFromJsonl reads last assistant.usage from JSONL tail", async () => {
  const path = join(FIXTURES, "sample-bare.jsonl");
  const snap = await getLiveTokensFromJsonl(path);
  assert.ok(snap, "expected non-null snapshot");
  assert.equal(snap!.totalTokens, 1 + 10687 + 83626 + 435);
  assert.equal(snap!.source, "jsonl-tail");
});

test("getLiveTokensFromJsonl returns null for missing file", async () => {
  const snap = await getLiveTokensFromJsonl("/tmp/nonexistent-xyz-123.jsonl");
  assert.equal(snap, null);
});

test("normalizeModel maps versioned ids", () => {
  assert.equal(normalizeModel("claude-sonnet-4-6"), "sonnet");
  assert.equal(normalizeModel("claude-opus-4-7"), "opus");
  assert.equal(normalizeModel("claude-haiku-4-5"), "haiku");
  assert.equal(normalizeModel(null), "sonnet");
  assert.equal(normalizeModel("unknown-model"), "sonnet");
});
