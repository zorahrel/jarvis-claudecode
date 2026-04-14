import { watch, readdirSync, statSync, existsSync } from "fs";
import { readFile } from "fs/promises";
import { readFileSync, writeFileSync } from "fs";
import { parse, stringify } from "yaml";
import { resolve, join } from "path";
import { homedir } from "os";
import type { Config, ToolDef, AgentConfig } from "../types";
import { logger } from "./logger";

const log = logger.child({ module: "config" });

let currentConfig: Config | null = null;
let configPath: string;
let agentRegistry: Record<string, AgentConfig> = {};
const listeners: Array<(config: Config) => void> = [];

const AGENTS_DIR = join(homedir(), ".claude/jarvis/agents");

/**
 * Scan ~/.claude/jarvis/agents/* for `agent.yaml` files and build the registry.
 * Folders starting with `_` or `.` are skipped (reserved for shared/internal).
 */
function loadAgentRegistry(): Record<string, AgentConfig> {
  const registry: Record<string, AgentConfig> = {};
  if (!existsSync(AGENTS_DIR)) return registry;

  for (const name of readdirSync(AGENTS_DIR)) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const workspace = join(AGENTS_DIR, name);
    try { if (!statSync(workspace).isDirectory()) continue; } catch { continue; }

    const yamlPath = join(workspace, "agent.yaml");
    if (!existsSync(yamlPath)) continue;

    try {
      const raw = readFileSync(yamlPath, "utf-8");
      const parsed = parse(interpolateEnvVars(raw)) ?? {};
      const agent: AgentConfig = {
        name,
        workspace,
        model: parsed.model,
        tools: Array.isArray(parsed.tools) ? parsed.tools : [],
        fallbacks: parsed.fallbacks,
        env: parsed.env,
        alwaysReply: parsed.alwaysReply,
        effort: parsed.effort,
        fullAccess: parsed.fullAccess,
        inheritUserScope: parsed.inheritUserScope,
      };
      registry[name] = agent;
    } catch (err) {
      log.error({ err, name }, "Failed to load agent.yaml");
    }
  }
  return registry;
}

/** Get the full agent registry (reloaded whenever config is reloaded). */
export function getAgentRegistry(): Record<string, AgentConfig> {
  return agentRegistry;
}

/** Resolve ~ in paths */
export function expandHome(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

/** Interpolate $ENV_VAR references in a YAML string */
function interpolateEnvVars(raw: string): string {
  return raw.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => process.env[name] ?? `$${name}`);
}

/** Load config from YAML file */
export async function loadConfig(path?: string): Promise<Config> {
  configPath = path ?? resolve(homedir(), ".claude/jarvis/router/config.yaml");
  const raw = await readFile(configPath, "utf-8");
  const parsed = parse(interpolateEnvVars(raw)) as Config;

  // Load agent registry from agents/*/agent.yaml folders
  agentRegistry = loadAgentRegistry();

  // Resolve each route's `use` to an agent config from the registry.
  for (const route of parsed.routes) {
    if (route.action === "ignore") continue;
    if (!route.use) {
      log.warn({ match: route.match }, "Route has no `use` field");
      continue;
    }
    const agent = agentRegistry[route.use];
    if (!agent) {
      log.error({ use: route.use, match: route.match }, "Route references unknown agent");
      continue;
    }
    // Clone so per-route mutation (if any) doesn't leak into the registry.
    route.agent = { ...agent };
  }

  // Expand authDir
  if (parsed.channels.whatsapp?.authDir) {
    parsed.channels.whatsapp.authDir = expandHome(parsed.channels.whatsapp.authDir);
  }
  // Expand cron workspaces
  if (parsed.crons) {
    for (const cron of parsed.crons) {
      if (cron.workspace) cron.workspace = expandHome(cron.workspace);
    }
  }

  currentConfig = parsed;
  log.info(
    "Config loaded from %s (%d routes, %d agents)",
    configPath, parsed.routes.length, Object.keys(agentRegistry).length,
  );
  return parsed;
}

/** Get current config (throws if not loaded) */
export function getConfig(): Config {
  if (!currentConfig) throw new Error("Config not loaded");
  return currentConfig;
}

/** Watch config file for changes and reload */
export function watchConfig(): void {
  let debounce: ReturnType<typeof setTimeout> | null = null;
  watch(configPath, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      try {
        const newConfig = await loadConfig(configPath);
        log.info("Config reloaded");
        for (const fn of listeners) fn(newConfig);
      } catch (err) {
        log.error({ err }, "Failed to reload config");
      }
    }, 500);
  });
  log.info("Watching config for changes");
}

/** Subscribe to config changes */
export function onConfigChange(fn: (config: Config) => void): void {
  listeners.push(fn);
}

/** Get the config file path */
export function getConfigPath(): string {
  return configPath;
}

/** Read raw config YAML as object (without expanding paths) */
export function readRawConfig(): any {
  const raw = readFileSync(configPath, "utf-8");
  return parse(raw);
}

/** Write raw config object back to YAML and reload */
export async function writeRawConfig(obj: any): Promise<Config> {
  const yamlStr = stringify(obj, { lineWidth: 120 });
  writeFileSync(configPath, yamlStr, "utf-8");
  return loadConfig(configPath);
}

/** Reload config from disk */
export async function reloadConfig(): Promise<Config> {
  return loadConfig(configPath);
}

// ============================================================
// TOOL REGISTRY
// ============================================================

/** Get email accounts from config, fallback to defaults */
export function getEmailAccounts(): Record<string, string> {
  const map: Record<string, string> = {};
  try {
    const config = readRawConfig();
    const accounts = config?.jarvis?.emailAccounts;
    if (Array.isArray(accounts)) {
      for (const a of accounts) {
        if (a.email && a.account) map[a.email] = a.account;
      }
    }
  } catch { /* config not loaded yet */ }
  // No fallback — email accounts must be configured in config.yaml jarvis.emailAccounts
  return map;
}

/**
 * Read MCP servers from ~/.claude.json — the user-scope config that
 * `claude mcp add -s user` writes to. Single source of truth for both
 * the interactive CLI and Jarvis router spawns.
 *
 * Reads only top-level `mcpServers` (user scope). Project-scoped servers
 * under `projects[path].mcpServers` are ignored — router agents run in
 * their own workspaces, not in the jarvis project dir.
 */
const CLAUDE_JSON_PATH = join(homedir(), ".claude.json");

export function readMcpServers(): Record<string, any> {
  try {
    const raw = readFileSync(CLAUDE_JSON_PATH, "utf-8");
    return JSON.parse(raw).mcpServers ?? {};
  } catch { return {}; }
}

/** Build the complete tool registry from MCP servers + known CLI tools + builtins */
export function getToolRegistry(): ToolDef[] {
  const tools: ToolDef[] = [];

  // Builtin tools
  tools.push(
    { id: "vision", type: "builtin", label: "Vision", icon: "\ud83d\udc41", description: "Analyze images sent in chat" },
    { id: "voice", type: "builtin", label: "Voice", icon: "\ud83c\udfa4", description: "Transcribe voice/audio messages via Whisper" },
    { id: "documents", type: "builtin", label: "Documents", icon: "\ud83d\udcc4", description: "Search indexed docs via ChromaDB" },
    { id: "subagents", type: "builtin", label: "Sub-agents", icon: "\ud83e\udd16", description: "Spawn background child agents" },
    { id: "fileAccess:full", type: "builtin", label: "Files (full)", icon: "\ud83d\udcc1", description: "Full read/write file system access" },
    { id: "fileAccess:readonly", type: "builtin", label: "Files (read)", icon: "\ud83d\udcc1", description: "Read-only file system access" },
    { id: "config", type: "builtin", label: "Config", icon: "\u2699\ufe0f", description: "Read/modify router configuration" },
    { id: "launchAgents", type: "builtin", label: "LaunchAgents", icon: "\ud83d\ude80", description: "Start macOS automations" },
  );

  // Memory scopes (from config or default to just "business")
  const rawCfg = (() => { try { return readRawConfig(); } catch { return {}; } })();
  const memoryScopes: string[] = rawCfg?.jarvis?.memoryScopes ?? ["business"];
  for (const scope of memoryScopes) {
    tools.push({
      id: `memory:${scope}`, type: "builtin", label: `Memory: ${scope}`, icon: "\ud83e\udde0",
      description: `Persistent conversation memory (${scope} scope)`,
    });
  }

  // Email accounts (CLI tools via gws-mail)
  const emailAccounts = getEmailAccounts();
  for (const [email, account] of Object.entries(emailAccounts)) {
    tools.push({
      id: `email:${email}`, type: "cli", label: email, icon: "\ud83d\udce7",
      description: `Gmail access for ${email}`, command: `gws-mail ${account}`,
    });
  }

  // Calendar accounts (CLI tools via gws-mail)
  for (const [email, account] of Object.entries(emailAccounts)) {
    tools.push({
      id: `calendar:${email}`, type: "cli", label: `Calendar: ${email}`, icon: "\ud83d\udcc5",
      description: `Google Calendar for ${email}`, command: `gws-mail ${account} calendar`,
    });
  }

  // MCP servers from ~/.claude.json (dashboard renders them via lucide <Server /> icon)
  const mcpServers = readMcpServers();
  for (const [name, config] of Object.entries(mcpServers)) {
    tools.push({
      id: `mcp:${name}`, type: "mcp", label: name,
      description: config.type === "http" ? `HTTP MCP: ${config.url}` : `Command MCP: ${(config.args ?? []).join(" ").slice(0, 60)}`,
      mcpConfig: config,
    });
  }

  return tools;
}

/** Get tools used by a specific route index */
export function getRouteTools(routeIdx: number): string[] {
  const config = getConfig();
  const route = config.routes[routeIdx];
  return route?.agent?.tools ?? [];
}

/** Build a map: toolId → routeIndices that use it */
export function getToolRouteMap(): Record<string, number[]> {
  const config = getConfig();
  const map: Record<string, number[]> = {};
  for (let i = 0; i < config.routes.length; i++) {
    const tools = config.routes[i]?.agent?.tools ?? [];
    for (const t of tools) {
      if (!map[t]) map[t] = [];
      map[t].push(i);
    }
  }
  return map;
}
