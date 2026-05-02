import type { ToolUseRecord } from "./jsonlParser.js";

/**
 * Cruft detection: compares "MCP servers loaded by an agent's spawn config"
 * against "MCP servers actually called in the last N turns" and emits findings.
 * Same pattern for skills (CTX-09 v1 caveat — see CTX-09 NOTE below).
 *
 * The hardcoded SUGGESTIONS list is tied directly to the 6 open questions in
 * the anatomy report (RESEARCH.md "Where the cruft is likely hiding"). Each
 * suggestion has a `when` condition expressed as a string for documentation
 * (the actual matching is done in code in getSuggestionsForCruft).
 *
 * --- CTX-09 NOTE (v1 caveat) ---
 * Skill cruft detection logic is fully implemented and unit-tested here, but
 * production-active only when Plan 05 enriches the `skillsLoaded` argument with
 * the live skills marketplace index reader. For v1, Plan 05 passes
 * `skillsLoaded: []`, so the live API will always return zero skill cruft
 * findings. Plan 08 UAT checklist documents this as expected behavior.
 *
 * Used by Plan 05 GET /api/sessions/cruft endpoint and Plan 06 CruftPanel UI.
 */

export interface CruftFinding {
  kind: "mcp_unused" | "skill_unused";
  /** e.g. "exa" or "gsd:plan-phase" */
  name: string;
  /** Estimated cost of having this loaded but not called. */
  loadedTokens: number;
  /** Window we checked (e.g. last 5 turns). */
  recentTurns: number;
  /** Always 0 for cruft (the whole point). */
  callCount: number;
}

export interface ConfigSuggestion {
  id: string;
  /** Condition trigger as documentation string. */
  when: string;
  /** Human-readable action. */
  action: string;
  /** Why this matters. */
  rationale: string;
}

/**
 * Hardcoded suggestions tied to the 6 open questions in RESEARCH.md anatomy.
 * Adding a new suggestion requires:
 * 1. New entry here with id/when/action/rationale.
 * 2. Matching condition logic in getSuggestionsForCruft below.
 */
export const SUGGESTIONS: ConfigSuggestion[] = [
  {
    id: "split-jarvis-chat",
    when: "mcp_unused.length >= 5 AND agent === 'jarvis'",
    action:
      "Split jarvis route in two: jarvis-chat (no MCP, no fullAccess) for chat/voice on TG/WA, and jarvis-code (full MCP) for coding sessions only.",
    rationale:
      "fullAccess on jarvis loads all 13 MCP servers (~10-15k tokens) on every turn — cruft for chat-only interactions per RESEARCH.md per-route table.",
  },
  {
    id: "notch-collapse-userscope",
    when: "agent === 'notch' AND inheritUserScope === true AND mcp_unused.length >= 8",
    action:
      "Set inheritUserScope: false on notch agent.yaml — notch is the ambient cruscotto, doesn't need 18 GSD subagents + 13 MCP.",
    rationale:
      "notch agent.yaml comment 'cruscotto ambient' contradicts the ~/.claude/ inheritance per CONTEXT.md decisions section.",
  },
  {
    id: "gsd-namespace-gating",
    when: "skill_unused contains gsd:* entries AND agent !== 'jarvis-code'",
    action: "Gate the gsd:* plugin per-agent — only enable in coding workspaces.",
    rationale:
      "gsd:* alone costs ~2.5k tokens index per session; useful only when coding.",
  },
  {
    id: "scope-mcp-explicit",
    when: "fullAccess === true AND mcp_unused.length >= 7",
    action:
      "Replace fullAccess: true with explicit tools: ['mcp:zenda', 'mcp:exa', ...] listing only servers actually used.",
    rationale: "Explicit list eliminates loading unused MCP catalogs.",
  },
];

/**
 * Extract MCP server name from a tool_use call name.
 *   "mcp__zenda__list_topics"     → "zenda"
 *   "mcp__brave-search__search"   → "brave-search"
 *   "Read"                        → null (not an MCP call)
 */
export function extractMcpServerName(toolUseName: string): string | null {
  const m = toolUseName.match(/^mcp__([^_]+(?:-[^_]+)*)__/);
  return m ? m[1] : null;
}

interface DetectCruftOpts {
  mcpsLoaded: string[];
  skillsLoaded: string[];
  toolUseEvents: ToolUseRecord[];
  recentTurns: number;
  /** Default 1000 (per breakdown.ts MCP_AVG_TOKENS_PER_SERVER). */
  mcpAvgTokens?: number;
  /** Default 50 (per skills index per-entry estimate). */
  skillAvgTokens?: number;
}

/**
 * Compare loaded vs called and emit cruft findings.
 * Skills: for v1 we treat any skill in `skillsLoaded` not invoked via the Skill
 * tool (detected via `inputKeys` containing skill_id-like patterns) as unused.
 */
export function detectCruft(opts: DetectCruftOpts): CruftFinding[] {
  const mcpAvgTokens = opts.mcpAvgTokens ?? 1000;
  const skillAvgTokens = opts.skillAvgTokens ?? 50;

  const calledMcps = new Set<string>();
  const calledSkills = new Set<string>();
  for (const ev of opts.toolUseEvents) {
    const mcpName = extractMcpServerName(ev.name);
    if (mcpName) calledMcps.add(mcpName);
    // Skill detection (v1 best-effort): the Skill tool input typically has a
    // "skill" or "skill_id" key. Skills don't show as direct tool_use names.
    if (ev.name === "Skill" || ev.inputKeys.some((k) => k === "skill" || k === "skill_id")) {
      // We don't know the exact id without parsing the input, but this gives us
      // a rough "any skill was used" signal. In v2 we'll wire skill-name capture.
      calledSkills.add("__any__");
    }
  }

  const findings: CruftFinding[] = [];

  for (const name of opts.mcpsLoaded) {
    if (!calledMcps.has(name)) {
      findings.push({
        kind: "mcp_unused",
        name,
        loadedTokens: mcpAvgTokens,
        recentTurns: opts.recentTurns,
        callCount: 0,
      });
    }
  }

  for (const name of opts.skillsLoaded) {
    // v1: if no skills called at all, all listed are cruft
    if (calledSkills.size === 0) {
      findings.push({
        kind: "skill_unused",
        name,
        loadedTokens: skillAvgTokens,
        recentTurns: opts.recentTurns,
        callCount: 0,
      });
    }
  }

  return findings;
}

/**
 * Match findings against SUGGESTIONS conditions.
 * Optional `ctx` enriches matching with agent name + inheritUserScope flag
 * (needed for the notch-collapse-userscope rule).
 */
export function getSuggestionsForCruft(
  findings: CruftFinding[],
  ctx?: { agentName?: string; inheritUserScope?: boolean; fullAccess?: boolean },
): ConfigSuggestion[] {
  const mcpUnused = findings.filter((f) => f.kind === "mcp_unused");
  const skillUnused = findings.filter((f) => f.kind === "skill_unused");
  const matched: ConfigSuggestion[] = [];

  // split-jarvis-chat
  if (mcpUnused.length >= 5 && ctx?.agentName === "jarvis") {
    matched.push(SUGGESTIONS.find((s) => s.id === "split-jarvis-chat")!);
  }

  // notch-collapse-userscope
  if (
    ctx?.agentName === "notch" &&
    ctx?.inheritUserScope === true &&
    mcpUnused.length >= 8
  ) {
    matched.push(SUGGESTIONS.find((s) => s.id === "notch-collapse-userscope")!);
  }

  // gsd-namespace-gating
  if (
    skillUnused.some((f) => f.name.startsWith("gsd:")) &&
    ctx?.agentName !== "jarvis-code"
  ) {
    matched.push(SUGGESTIONS.find((s) => s.id === "gsd-namespace-gating")!);
  }

  // scope-mcp-explicit
  if (ctx?.fullAccess === true && mcpUnused.length >= 7) {
    matched.push(SUGGESTIONS.find((s) => s.id === "scope-mcp-explicit")!);
  }

  return matched;
}
