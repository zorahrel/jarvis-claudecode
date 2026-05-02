import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { calculateBreakdown, type SpawnConfig } from "./breakdown.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "__fixtures__");
const MCP_CONFIG = join(FIXTURES, "mcp-config.json");

const NONEXISTENT_WORKSPACE = "/tmp/nonexistent-workspace-context-inspector-spec";
const NONEXISTENT_USER_CLAUDEMD = "/tmp/nonexistent-userclaudemd-context-inspector-spec";

test("calculateBreakdown: jarvis fullAccess produces 8 categories with MCP 10k-16k", async () => {
  const spawn: SpawnConfig = {
    agent: "jarvis",
    fullAccess: true,
    inheritUserScope: true,
    tools: [],
    workspace: NONEXISTENT_WORKSPACE,
    mcpConfigPath: MCP_CONFIG,
    userClaudeMdPath: NONEXISTENT_USER_CLAUDEMD,
  };

  const result = await calculateBreakdown(spawn, 50000);

  assert.equal(result.categories.length, 8);
  const mcp = result.categories.find((c) => c.category === "mcp_servers");
  assert.ok(mcp);
  assert.ok(mcp.tokens >= 10000, `MCP tokens ${mcp.tokens} should be >= 10000 for fullAccess`);
  assert.ok(mcp.tokens <= 16000, `MCP tokens ${mcp.tokens} should be <= 16000`);
});

test("calculateBreakdown: cecilia (inheritUserScope=false, no MCP) is light baseline", async () => {
  const spawn: SpawnConfig = {
    agent: "cecilia",
    fullAccess: false,
    inheritUserScope: false,
    tools: [],
    workspace: NONEXISTENT_WORKSPACE,
    mcpConfigPath: MCP_CONFIG,
    userClaudeMdPath: NONEXISTENT_USER_CLAUDEMD,
  };

  const result = await calculateBreakdown(spawn, 5000);
  const map = Object.fromEntries(result.categories.map((c) => [c.category, c.tokens]));

  assert.equal(map.mcp_servers, 0, "no MCP for cecilia");
  assert.equal(map.subagents, 0, "no subagents (inheritUserScope=false)");
  assert.equal(map.hooks_memory, 0, "no hooks (inheritUserScope=false)");
  assert.equal(map.skills_index, 0, "no skills (inheritUserScope=false)");
});

test("calculateBreakdown: history is non-negative (clamped to 0 when liveTotal < baseline)", async () => {
  const spawn: SpawnConfig = {
    agent: "jarvis",
    fullAccess: true,
    inheritUserScope: true,
    tools: [],
    workspace: NONEXISTENT_WORKSPACE,
    mcpConfigPath: MCP_CONFIG,
    userClaudeMdPath: NONEXISTENT_USER_CLAUDEMD,
  };

  // Test 1: liveTotal > sum(other 7) → history = delta
  const r1 = await calculateBreakdown(spawn, 100000);
  const sumOfFirst7_1 = r1.categories.slice(0, 7).reduce((s, c) => s + c.tokens, 0);
  const history1 = r1.categories[7];
  assert.equal(history1.category, "history");
  assert.equal(history1.tokens, 100000 - sumOfFirst7_1);

  // Test 2: liveTotal < sum(other 7) → history = 0 (clamped)
  const r2 = await calculateBreakdown(spawn, 100);
  assert.equal(r2.categories[7].tokens, 0, "history clamped at 0");
});

test("calculateBreakdown: 8 categories in canonical order", async () => {
  const spawn: SpawnConfig = {
    agent: "jarvis",
    fullAccess: true,
    inheritUserScope: true,
    tools: [],
    workspace: NONEXISTENT_WORKSPACE,
    mcpConfigPath: MCP_CONFIG,
    userClaudeMdPath: NONEXISTENT_USER_CLAUDEMD,
  };

  const result = await calculateBreakdown(spawn, 50000);
  const expectedOrder = [
    "system_preset",
    "builtin_tools",
    "mcp_servers",
    "skills_index",
    "claudemd_chain",
    "subagents",
    "hooks_memory",
    "history",
  ];
  assert.deepEqual(
    result.categories.map((c) => c.category),
    expectedOrder,
  );
});

test("calculateBreakdown: jarvis MCP details list 13 entries with transport + tokens", async () => {
  const spawn: SpawnConfig = {
    agent: "jarvis",
    fullAccess: true,
    inheritUserScope: true,
    tools: [],
    workspace: NONEXISTENT_WORKSPACE,
    mcpConfigPath: MCP_CONFIG,
    userClaudeMdPath: NONEXISTENT_USER_CLAUDEMD,
  };

  const result = await calculateBreakdown(spawn, 50000);
  const mcp = result.categories.find((c) => c.category === "mcp_servers")!;
  assert.ok(Array.isArray(mcp.details), "MCP details should be an array of server entries");

  const details = mcp.details as Array<{
    name: string;
    transport: string;
    toolsEstimate: number;
    tokens: number;
  }>;
  assert.equal(details.length, 13, "13 MCP servers loaded with fullAccess");

  for (const d of details) {
    assert.ok(typeof d.name === "string" && d.name.length > 0);
    assert.ok(["stdio", "http", "unknown"].includes(d.transport));
    assert.ok(d.tokens > 0);
    assert.ok(d.toolsEstimate > 0);
  }
});

test("calculateBreakdown: scoped agent with explicit mcp:exa + mcp:brave-search loads 2 servers", async () => {
  const spawn: SpawnConfig = {
    agent: "matteo",
    fullAccess: false,
    inheritUserScope: false,
    tools: ["mcp:exa", "mcp:brave-search", "fileAccess:readonly"],
    workspace: NONEXISTENT_WORKSPACE,
    mcpConfigPath: MCP_CONFIG,
    userClaudeMdPath: NONEXISTENT_USER_CLAUDEMD,
  };

  const result = await calculateBreakdown(spawn, 8000);
  const mcp = result.categories.find((c) => c.category === "mcp_servers")!;
  const details = mcp.details as Array<{ name: string }>;
  assert.equal(details.length, 2);
  assert.ok(details.find((d) => d.name === "exa"));
  assert.ok(details.find((d) => d.name === "brave-search"));
  assert.equal(mcp.tokens, 2000); // 2 servers × 1000 tokens avg
});
