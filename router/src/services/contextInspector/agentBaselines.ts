import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { calculateBreakdown, type BreakdownResult, type SpawnConfig } from "./breakdown.js";

/**
 * Static baseline analyzer for agent templates.
 *
 * For each agent defined under `~/.claude/jarvis/agents/<name>/agent.yaml`,
 * synthesises a SpawnConfig and runs `calculateBreakdown(spawn, 0)` — the
 * resulting BreakdownResult is the *baseline* token cost the agent pays on
 * spawn, before any user turn (history=0, clamped).
 *
 * This is the static inspector that powers the Context tab — answers
 * "quanto pesa ogni agent template prima di parlare?".
 */

const AGENTS_ROOT = join(homedir(), ".claude", "jarvis", "agents");

export interface AgentBaseline {
  agent: string;
  model: string;
  fallbacks: string[];
  fullAccess: boolean;
  inheritUserScope: boolean;
  tools: string[];
  effort: string | null;
  /** Baseline breakdown (history=0). Use `breakdown.totalEstimated` as the headline. */
  breakdown: BreakdownResult;
  /** Workspace path the SpawnConfig used. */
  workspace: string;
  /** Static cruft hints derived from the config (no live data needed). */
  cruftHints: AgentCruftHint[];
}

export interface AgentCruftHint {
  id: string;
  severity: "info" | "warn" | "crit";
  /** Italian, displayed verbatim in UI. */
  message: string;
  /** Optional savings in tokens if the user applies the suggested fix. */
  potentialSavingsTokens?: number;
}

interface AgentYaml {
  model?: string;
  fallbacks?: string[];
  effort?: string;
  fullAccess?: boolean;
  inheritUserScope?: boolean;
  tools?: string[];
}

/** List agent directory names, excluding `_archive`, `_shared`, etc. */
async function listAgents(): Promise<string[]> {
  let entries: Array<{ name: string; isDir: boolean }> = [];
  try {
    const dirents = await fs.readdir(AGENTS_ROOT, { withFileTypes: true });
    entries = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDir && !e.name.startsWith("_") && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

async function readAgentYaml(name: string): Promise<AgentYaml> {
  try {
    const raw = await fs.readFile(join(AGENTS_ROOT, name, "agent.yaml"), "utf-8");
    return (parseYaml(raw) as AgentYaml) ?? {};
  } catch {
    return {};
  }
}

function buildSpawnFromYaml(name: string, cfg: AgentYaml): SpawnConfig {
  return {
    agent: name,
    fullAccess: cfg.fullAccess === true,
    // Default Claude Code behavior: inheritUserScope is true unless explicitly disabled.
    inheritUserScope: cfg.inheritUserScope !== false,
    tools: cfg.tools ?? [],
    workspace: join(AGENTS_ROOT, name),
    mcpConfigPath: join(homedir(), ".claude.json"),
  };
}

/**
 * Static cruft detection on the agent config alone (no live data).
 * Encodes the 6 open questions from the anatomy report as actionable hints.
 */
function deriveCruftHints(name: string, spawn: SpawnConfig, breakdown: BreakdownResult): AgentCruftHint[] {
  const hints: AgentCruftHint[] = [];
  const mcpCat = breakdown.categories.find((c) => c.category === "mcp_servers");
  const skillsCat = breakdown.categories.find((c) => c.category === "skills_index");
  const subagentsCat = breakdown.categories.find((c) => c.category === "subagents");

  // Hint 1: notch eredita user scope ma è documentato come ambient/non-coding
  if (name === "notch" && spawn.inheritUserScope === true) {
    const savings = (skillsCat?.tokens ?? 0) + (subagentsCat?.tokens ?? 0);
    hints.push({
      id: "notch-user-scope",
      severity: "warn",
      message:
        "notch è ambient/chat ma eredita user-scope (skills + subagents). Setta inheritUserScope: false per togliere il GSD index e altri.",
      potentialSavingsTokens: savings > 0 ? savings : undefined,
    });
  }

  // Hint 2: jarvis fullAccess — propone split chat/code
  if (name === "jarvis" && spawn.fullAccess === true && (mcpCat?.tokens ?? 0) >= 10000) {
    hints.push({
      id: "split-jarvis-chat",
      severity: "warn",
      message:
        "jarvis con fullAccess carica tutti i 13 MCP server (~13k token). Considera di splittare in jarvis-chat (no MCP) per voce/TG/WA e jarvis-code per coding.",
      potentialSavingsTokens: mcpCat?.tokens,
    });
  }

  // Hint 3: fullAccess + lots of MCPs but minimal tools list — cosmetic check
  if (spawn.fullAccess === true && (mcpCat?.tokens ?? 0) >= 7000) {
    hints.push({
      id: "fullaccess-explicit-mcps",
      severity: "info",
      message:
        "fullAccess: true carica TUTTI gli MCP. Se ne usi solo alcuni, sostituiscilo con tools: ['mcp:exa', 'mcp:zenda', ...] per risparmiare.",
    });
  }

  // Hint 4: inherit + no narrow tools = pesante implicito
  if (spawn.inheritUserScope === true && (skillsCat?.tokens ?? 0) >= 2000 && name !== "jarvis") {
    hints.push({
      id: "userscope-skills-heavy",
      severity: "info",
      message: `Skills index pesa ${skillsCat!.tokens} token (gsd:* da solo ~2.5k). Se '${name}' non usa GSD, valuta inheritUserScope: false.`,
      potentialSavingsTokens: skillsCat?.tokens,
    });
  }

  return hints;
}

/** Analyse all agent templates and return baseline + cruft hints per agent. */
export async function analyzeAgentBaselines(): Promise<AgentBaseline[]> {
  const names = await listAgents();
  const results = await Promise.all(
    names.map(async (name): Promise<AgentBaseline> => {
      const cfg = await readAgentYaml(name);
      const spawn = buildSpawnFromYaml(name, cfg);
      const breakdown = await calculateBreakdown(spawn, 0);
      const cruftHints = deriveCruftHints(name, spawn, breakdown);
      return {
        agent: name,
        model: cfg.model ?? "(unspecified)",
        fallbacks: cfg.fallbacks ?? [],
        fullAccess: spawn.fullAccess,
        inheritUserScope: spawn.inheritUserScope,
        tools: spawn.tools,
        effort: cfg.effort ?? null,
        breakdown,
        workspace: spawn.workspace,
        cruftHints,
      };
    }),
  );
  // Sort by total tokens desc — heaviest agents first
  results.sort((a, b) => b.breakdown.totalEstimated - a.breakdown.totalEstimated);
  return results;
}
