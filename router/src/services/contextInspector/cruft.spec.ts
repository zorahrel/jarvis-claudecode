import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectCruft,
  getSuggestionsForCruft,
  extractMcpServerName,
  SUGGESTIONS,
} from "./cruft.js";
import type { ToolUseRecord } from "./jsonlParser.js";

test("detectCruft: 4 MCPs loaded, only zenda called → 3 unused", () => {
  const events: ToolUseRecord[] = [
    { name: "mcp__zenda__list_topics", inputKeys: [], turnIndex: 0 },
    { name: "Read", inputKeys: ["file_path"], turnIndex: 0 },
  ];
  const findings = detectCruft({
    mcpsLoaded: ["zenda", "exa", "figma", "supabase"],
    skillsLoaded: [],
    toolUseEvents: events,
    recentTurns: 5,
  });
  assert.equal(findings.length, 3);
  const names = findings.map((f) => f.name).sort();
  assert.deepEqual(names, ["exa", "figma", "supabase"]);
  assert.ok(findings.every((f) => f.kind === "mcp_unused" && f.callCount === 0));
});

test("detectCruft: 3 skills loaded, zero invocations → 3 unused", () => {
  const findings = detectCruft({
    mcpsLoaded: [],
    skillsLoaded: ["gsd:plan-phase", "claude-mem", "firecrawl"],
    toolUseEvents: [],
    recentTurns: 5,
  });
  const skillFindings = findings.filter((f) => f.kind === "skill_unused");
  assert.equal(skillFindings.length, 3);
});

test("SUGGESTIONS list: at least 4 entries with required structure", () => {
  assert.ok(SUGGESTIONS.length >= 4);
  for (const s of SUGGESTIONS) {
    assert.ok(typeof s.id === "string" && s.id.length > 0);
    assert.ok(typeof s.when === "string" && s.when.length > 0);
    assert.ok(typeof s.action === "string" && s.action.length > 0);
    assert.ok(typeof s.rationale === "string" && s.rationale.length > 0);
  }
  const ids = SUGGESTIONS.map((s) => s.id);
  assert.ok(ids.includes("split-jarvis-chat"));
  assert.ok(ids.includes("notch-collapse-userscope"));
  assert.ok(ids.includes("gsd-namespace-gating"));
  assert.ok(ids.includes("scope-mcp-explicit"));
});

test("getSuggestionsForCruft: returns split-jarvis-chat for jarvis with 5+ unused MCP", () => {
  const findings = detectCruft({
    mcpsLoaded: ["a", "b", "c", "d", "e"],
    skillsLoaded: [],
    toolUseEvents: [],
    recentTurns: 5,
  });
  const out = getSuggestionsForCruft(findings, { agentName: "jarvis", fullAccess: true });
  const ids = out.map((s) => s.id);
  assert.ok(ids.includes("split-jarvis-chat"));
});

test("detectCruft: empty toolUseEvents returns ALL loaded MCPs as unused", () => {
  const findings = detectCruft({
    mcpsLoaded: ["zenda", "exa", "vercel"],
    skillsLoaded: [],
    toolUseEvents: [],
    recentTurns: 5,
  });
  assert.equal(findings.filter((f) => f.kind === "mcp_unused").length, 3);
});

test("extractMcpServerName: 'mcp__zenda__list_topics' → 'zenda'; 'Read' → null", () => {
  assert.equal(extractMcpServerName("mcp__zenda__list_topics"), "zenda");
  assert.equal(extractMcpServerName("mcp__brave-search__search"), "brave-search");
  assert.equal(extractMcpServerName("Read"), null);
  assert.equal(extractMcpServerName("Bash"), null);
});
