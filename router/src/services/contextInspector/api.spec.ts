import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import {
  recordTaskProgress,
  recordTurnResult,
  _resetForTests,
  getLiveTokensFromSdk,
  costPerTurn,
  aggregateCost,
  calculateBreakdown,
  detectCruft,
  getSuggestionsForCruft,
  diskStats,
  type SpawnConfig,
} from "./index.js";

/**
 * End-to-end module composition test for the Context Inspector backend.
 * Exercises the barrel `index.ts` to prove all 8 internal modules wire
 * together cleanly. Does NOT spin up an HTTP server — that's covered by the
 * manual smoke test in Plan 08 UAT.
 *
 * The BLOCKER 1 e2e test (recordTaskProgress + recordTurnResult sequence
 * producing non-zero cost) is the contract Plan 05 must preserve to make
 * router-spawned cost calculation work.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "__fixtures__");
const MCP_CONFIG = join(FIXTURES, "mcp-config.json");

beforeEach(() => _resetForTests());

test("end-to-end: recordTaskProgress -> getLiveTokensFromSdk", () => {
  recordTaskProgress("test:integration", 12345);
  const snap = getLiveTokensFromSdk({
    sessionKey: "test:integration",
    resolvedModel: "claude-sonnet-4-6",
    totalInputTokens: 0,
    compactionCount: 0,
    alive: true,
  });
  assert.equal(snap.totalTokens, 12345);
  assert.equal(snap.source, "sdk-task-progress");
});

test("BLOCKER 1 e2e: task_progress + result tap produce totalTokens + lastTurnUsage + non-zero cost", () => {
  // Simulate the SDK consumer loop sequence: task_progress events arrive first
  // (running totalTokens), then result event arrives at end-of-turn with
  // per-field usage breakdown.
  recordTaskProgress("test:blocker1", 87432);
  recordTurnResult("test:blocker1", {
    input_tokens: 1500,
    output_tokens: 800,
    cache_creation_input_tokens: 30000,
    cache_read_input_tokens: 50000,
  });
  const snap = getLiveTokensFromSdk({
    sessionKey: "test:blocker1",
    resolvedModel: "claude-sonnet-4-6",
    totalInputTokens: 0,
    compactionCount: 0,
    alive: true,
  });
  assert.equal(snap.totalTokens, 87432, "totalTokens should be from task_progress");
  assert.ok(snap.lastTurnUsage, "lastTurnUsage should be attached from recordTurnResult");

  // The whole point of BLOCKER 1: cost computation must produce a non-zero
  // result for router-spawned sessions. In the broken implementation
  // lastTurnUsage was always null and cost was always undefined.
  const cost = costPerTurn(snap.lastTurnUsage!, "sonnet");
  assert.ok(cost.totalUsd > 0, `expected non-zero cost, got ${cost.totalUsd}`);
});

test("end-to-end: calculateBreakdown + costPerTurn + aggregateCost compose", async () => {
  const spawn: SpawnConfig = {
    agent: "jarvis",
    fullAccess: true,
    inheritUserScope: true,
    tools: [],
    workspace: "/tmp/nonexistent-api-spec",
    mcpConfigPath: MCP_CONFIG,
    userClaudeMdPath: "/tmp/nonexistent-userclaudemd-api-spec",
  };
  const breakdown = await calculateBreakdown(spawn, 87432);
  assert.equal(breakdown.categories.length, 8);

  const c1 = costPerTurn(
    { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    "sonnet",
  );
  const c2 = costPerTurn(
    { input_tokens: 500, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    "sonnet",
  );
  const total = aggregateCost([c1, c2]);
  assert.ok(total > 0);
});

test("end-to-end: detectCruft + getSuggestionsForCruft fires multiple suggestions at high unused-MCP count", () => {
  const findings = detectCruft({
    mcpsLoaded: ["zenda", "exa", "figma", "supabase", "vercel", "github", "context7"],
    skillsLoaded: [],
    toolUseEvents: [], // no calls = all 7 loaded MCPs unused
    recentTurns: 5,
  });
  assert.equal(findings.length, 7);

  const suggestions = getSuggestionsForCruft(findings, {
    agentName: "jarvis",
    inheritUserScope: true,
    fullAccess: true,
  });
  const ids = suggestions.map((s) => s.id);
  assert.ok(ids.includes("split-jarvis-chat"), "should fire split-jarvis-chat at >= 5 unused MCP for jarvis");
  assert.ok(ids.includes("scope-mcp-explicit"), "should fire scope-mcp-explicit at >= 7 unused MCP with fullAccess");
});

test("end-to-end: diskStats handles empty + missing dirs gracefully", async () => {
  const tmp = await fs.mkdtemp(join(tmpdir(), "ci-disk-api-spec-"));
  try {
    const empty = await diskStats(tmp);
    assert.equal(empty.totalJsonl, 0);
    assert.equal(empty.totalMb, 0);

    const missing = await diskStats("/nonexistent/path/xyz123");
    assert.equal(missing.totalJsonl, 0);
    assert.equal(missing.filesOlderThan30d, 0);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
