import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { BreakdownCategory } from "./types.js";
import { expandClaudeMdChain, type ChainEntry } from "./claudeMdChain.js";

/**
 * 8-category breakdown estimator. The diagnostic engine for the drill-down view (CTX-05).
 *
 * Token estimates are conservative midpoints derived from RESEARCH.md section 1
 * (anatomy table) and CONTEXT.md decisions (chars/4 proxy).
 *
 * This module does filesystem I/O — reads CLAUDE.md chains, MCP config — so we
 * isolated it from cost.ts/tokenSource.ts (which stay pure-function).
 *
 * Used by Plan 05 to populate `GET /api/sessions/:id/breakdown`.
 */

// ─── Token weight constants (RESEARCH.md section 1 anatomy table) ────────────
export const SYSTEM_PRESET_TOKENS = 4000; // 3-5k midpoint
export const BUILTIN_TOOLS_TOKENS = 6500; // 5-8k midpoint
export const MCP_AVG_TOKENS_PER_SERVER = 1000; // small=400, medium=1200, large=3000 — avg
export const SKILLS_INDEX_DEFAULT_TOKENS = 3000; // jarvis-marketplace + user + plugin + gsd:* (~2.5k alone)
export const SUBAGENTS_INDEX_TOKENS = 1000; // 18 GSD * ~50 tokens index entry
export const HOOKS_MEMORY_AVG_TOKENS = 800; // OMEGA inject 0.5-2k midpoint

// ─── Public types (signatures EXACT — Plan 05 imports by name) ───────────────

export interface SpawnConfig {
  agent: string;
  fullAccess: boolean;
  inheritUserScope: boolean;
  tools: string[];
  workspace: string;
  mcpConfigPath: string;
  /** Defaults to ~/.claude/CLAUDE.md if omitted. */
  userClaudeMdPath?: string;
}

export interface McpServerDetail {
  name: string;
  transport: "stdio" | "http" | "unknown";
  toolsEstimate: number;
  tokens: number;
}

export interface ChainEntryDetail {
  path: string;
  bytes: number;
  tokens: number;
  isRoot: boolean;
}

export type CategoryDetails =
  | McpServerDetail[]
  | ChainEntryDetail[]
  | { note: string }
  | null;

export interface CategoryResult {
  category: BreakdownCategory;
  tokens: number;
  details: CategoryDetails;
}

export interface BreakdownResult {
  categories: CategoryResult[];
  totalEstimated: number;
  liveTotal: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface McpServerCfg {
  command?: string;
  args?: string[];
  url?: string;
  transport?: string;
}

async function loadMcpConfig(path: string): Promise<Record<string, McpServerCfg>> {
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as
      | { mcpServers?: Record<string, McpServerCfg> }
      | Record<string, McpServerCfg>;
    if (parsed && typeof parsed === "object" && "mcpServers" in parsed && parsed.mcpServers) {
      return parsed.mcpServers as Record<string, McpServerCfg>;
    }
    return parsed as Record<string, McpServerCfg>;
  } catch {
    return {};
  }
}

function inferTransport(cfg: McpServerCfg): "stdio" | "http" | "unknown" {
  if (cfg.transport === "http" || cfg.url) return "http";
  if (cfg.command || cfg.transport === "stdio") return "stdio";
  return "unknown";
}

function chainEntriesToDetails(entries: ChainEntry[]): ChainEntryDetail[] {
  return entries.map((e) => ({
    path: e.path,
    bytes: e.bytes,
    tokens: e.tokens,
    isRoot: e.isRoot,
  }));
}

// ─── Main API ────────────────────────────────────────────────────────────────

export async function calculateBreakdown(
  spawn: SpawnConfig,
  liveTotalTokens: number,
): Promise<BreakdownResult> {
  const userClaudeMdPath = spawn.userClaudeMdPath ?? join(homedir(), ".claude", "CLAUDE.md");

  // 1. system_preset (constant)
  const systemPreset: CategoryResult = {
    category: "system_preset",
    tokens: SYSTEM_PRESET_TOKENS,
    details: { note: "Claude Code preset (excludeDynamicSections=true)" },
  };

  // 2. builtin_tools (constant)
  const builtinTools: CategoryResult = {
    category: "builtin_tools",
    tokens: BUILTIN_TOOLS_TOKENS,
    details: {
      note: "Read/Write/Edit/Bash/Grep/Glob/Task/Agent/WebFetch/WebSearch/TodoWrite schemas",
    },
  };

  // 3. mcp_servers (depends on fullAccess + tools[])
  const mcpServersConfig = await loadMcpConfig(spawn.mcpConfigPath);
  const allServerNames = Object.keys(mcpServersConfig);
  let loadedServerNames: string[];
  if (spawn.fullAccess) {
    loadedServerNames = allServerNames;
  } else {
    const requestedFromTools = spawn.tools
      .filter((t) => t.startsWith("mcp:"))
      .map((t) => t.slice(4));
    loadedServerNames = requestedFromTools.filter((n) => allServerNames.includes(n));
  }
  const mcpDetails: McpServerDetail[] = loadedServerNames.map((name) => ({
    name,
    transport: inferTransport(mcpServersConfig[name]!),
    toolsEstimate: 8,
    tokens: MCP_AVG_TOKENS_PER_SERVER,
  }));
  const mcpServers: CategoryResult = {
    category: "mcp_servers",
    tokens: mcpDetails.length * MCP_AVG_TOKENS_PER_SERVER,
    details: mcpDetails,
  };

  // 4. skills_index (only when inheritUserScope)
  const skillsIndex: CategoryResult = spawn.inheritUserScope
    ? {
        category: "skills_index",
        tokens: SKILLS_INDEX_DEFAULT_TOKENS,
        details: {
          note: "jarvis-marketplace 29 + user 3 + plugin marketplace; gsd:* alone ~2.5k",
        },
      }
    : {
        category: "skills_index",
        tokens: 0,
        details: { note: "inheritUserScope=false — no user-scope skills" },
      };

  // 5. claudemd_chain (always read workspace CLAUDE.md; user CLAUDE.md only when inheritUserScope)
  const chainEntries: ChainEntry[] = [];
  if (spawn.inheritUserScope) {
    const userChain = await expandClaudeMdChain(userClaudeMdPath);
    chainEntries.push(...userChain.entries);
  }
  const workspaceChain = await expandClaudeMdChain(join(spawn.workspace, "CLAUDE.md"));
  chainEntries.push(...workspaceChain.entries);
  const chainTokens = chainEntries.reduce((s, e) => s + e.tokens, 0);
  const claudemdChain: CategoryResult = {
    category: "claudemd_chain",
    tokens: chainTokens,
    details: chainEntriesToDetails(chainEntries),
  };

  // 6. subagents (only when inheritUserScope)
  const subagents: CategoryResult = spawn.inheritUserScope
    ? {
        category: "subagents",
        tokens: SUBAGENTS_INDEX_TOKENS,
        details: { note: "~18 GSD subagents indexed at ~50 tokens each" },
      }
    : {
        category: "subagents",
        tokens: 0,
        details: { note: "inheritUserScope=false — no user-scope subagents" },
      };

  // 7. hooks_memory (only when inheritUserScope)
  const hooksMemory: CategoryResult = spawn.inheritUserScope
    ? {
        category: "hooks_memory",
        tokens: HOOKS_MEMORY_AVG_TOKENS,
        details: {
          note: "OMEGA auto_capture per UserPromptSubmit + surface_memories per tool call (avg)",
        },
      }
    : {
        category: "hooks_memory",
        tokens: 0,
        details: { note: "inheritUserScope=false — hooks not active" },
      };

  // 8. history (live total minus the other 7 categories, clamped at 0)
  const seven =
    systemPreset.tokens +
    builtinTools.tokens +
    mcpServers.tokens +
    skillsIndex.tokens +
    claudemdChain.tokens +
    subagents.tokens +
    hooksMemory.tokens;

  const historyTokens = Math.max(0, liveTotalTokens - seven);
  const history: CategoryResult = {
    category: "history",
    tokens: historyTokens,
    details: {
      note:
        liveTotalTokens > seven
          ? "Conversation accumulator = liveTotal - sum(other 7)"
          : "Live total below baseline — conversation history empty (clamped to 0)",
    },
  };

  // Canonical order
  const categories: CategoryResult[] = [
    systemPreset,
    builtinTools,
    mcpServers,
    skillsIndex,
    claudemdChain,
    subagents,
    hooksMemory,
    history,
  ];

  const totalEstimated = categories.reduce((s, c) => s + c.tokens, 0);

  return {
    categories,
    totalEstimated,
    liveTotal: liveTotalTokens,
  };
}
