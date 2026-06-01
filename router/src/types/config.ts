/** Channel types */
export type Channel = "whatsapp" | "telegram" | "discord";

/** Route match criteria */
export interface RouteMatch {
  channel: Channel | "*";
  from?: string | number | "self";
  group?: string;
  guild?: string;
  jid?: string;  // Direct JID match (for WhatsApp LID format, self-chat, etc.)
}

/** Tool registry entry describing an available tool in the system */
export interface ToolDef {
  id: string;           // e.g. "vision", "email:myaccount", "mcp:github"
  type: "builtin" | "cli" | "mcp";
  label: string;        // Human-readable: "Vision", "user@example.com", "GitHub"
  /** Optional emoji for legacy surfaces. Dashboard renders via lucide (see dashboard/src/icons.tsx). */
  icon?: string;
  description: string;
  /** For mcp tools: server config from ~/.claude.json mcpServers */
  mcpConfig?: { command?: string; args?: string[]; url?: string; type?: string; env?: Record<string, string> };
  /** For cli tools: the shell command */
  command?: string;
}

/**
 * Per-channel scoping policy. Applied to in-process messaging MCPs (discord/whatsapp/telegram).
 * Default safe: when no policy is set the agent can only read/write the *current* conversation
 * (the one that triggered the session). Allow/deny lists let the agent reach further.
 */
export interface ChannelScope {
  /** Discord guild IDs the agent may touch. Empty/missing → only current guild. */
  allowedGuilds?: string[];
  /** Discord channel IDs explicitly allowed (overrides guild filter when set). */
  allowedChannels?: string[];
  /** Discord channel IDs explicitly blocked (private/finance/etc). Always respected. */
  denyChannels?: string[];
  /** WhatsApp JIDs (group `@g.us` or DM `@s.whatsapp.net`) the agent may read/write. */
  allowedJids?: string[];
  /** WhatsApp JIDs to deny even if matched by allowedJids prefixes. */
  denyJids?: string[];
  /** Telegram chat IDs (string form) the agent may touch. */
  allowedChats?: string[];
  /** Telegram chat IDs to deny. */
  denyChats?: string[];
  /** When true, the agent may send to chats outside the current session conversation. Default false. */
  allowCrossChatWrite?: boolean;
}

/** Token/context budget controls per agent */
export interface ContextLimits {
  /** Max chars of session history injected on session resume. Default 8000. */
  sessionCacheMaxChars?: number;
  /** Max exchanges injected on session resume. Default 10. */
  sessionCacheMaxExchanges?: number;
}

/** Agent configuration (from agents/<name>/agent.yaml + workspace auto-resolved). */
export interface AgentConfig {
  /** Agent name (from folder). Injected at load time, not present in agent.yaml. */
  name?: string;
  /** Absolute workspace path. Injected at load time. */
  workspace: string;
  model?: string;
  /** Granular tool list: ["vision", "email:myaccount", "mcp:github", "memory:business",
   *  "discord", "discord:write", "whatsapp", "whatsapp:write", "telegram", "telegram:write",
   *  "channels"]
   */
  tools?: string[];
  fallbacks?: string[];
  env?: Record<string, string>;
  alwaysReply?: boolean;
  effort?: "low" | "medium" | "high" | "max";
  /** When true, the spawned CLI gets all MCP servers, no tool restrictions, and bypassPermissions. Ignores `tools`. */
  fullAccess?: boolean;
  /** Inherit ~/.claude/ user-scope settings (CLAUDE.md, hooks, skills). Default true. Set false for external/client agents that must not see the user's global config. */
  inheritUserScope?: boolean;
  /** Context/token budget controls. Tune per-agent to reduce token usage. */
  contextLimits?: ContextLimits;
  /** Inactivity timeout in minutes before the session is killed. Default 15. */
  inactivityTimeoutMin?: number;
  /** When true, spawn the session at router startup so the first message has zero cold-start latency. */
  keepWarm?: boolean;
  /** Per-channel scoping for messaging MCPs. */
  discord?: ChannelScope;
  whatsapp?: ChannelScope;
  telegram?: ChannelScope;
  /**
   * Trust tier — gates which tools the dashboard will let you assign to
   * this agent. `fullAccess: true` overrides this (owner-equivalent).
   * Defaults to "personal" (least-privileged sane default) when neither
   * tier nor fullAccess are set. See TIER_TOOL_WHITELIST below.
   */
  tier?: User["type"];
  /** Per-agent rate limits — override the global rateLimits for this agent. */
  rateLimit?: {
    /** Max inbound messages this agent will accept in `windowSeconds`. */
    maxMessages?: number;
    /** Time window in seconds for the rate-limit bucket. */
    windowSeconds?: number;
  };
}

/**
 * Tier → tool-id allowlist. Each entry is an array of regexes; a tool is
 * allowed if ANY regex matches. Used by the dashboard PATCH endpoints to
 * reject privilege escalation (e.g. assigning `fileAccess:full` to a client
 * agent). `owner` is unrestricted; `fullAccess: true` on an agent.yaml
 * also bypasses these checks.
 *
 * Conservative by design — anything not explicitly allowed is denied.
 * Add patterns here when introducing new tool categories.
 */
export const TIER_TOOL_WHITELIST: Record<User["type"], RegExp[]> = {
  owner: [/.*/],
  team: [
    // Everything except the most sensitive privileges.
    /^(?!fileAccess:full$|subagents$|memory:business$|launchAgents$|config$).*/,
  ],
  family: [
    /^(vision|voice|documents)$/,
    /^(discord|whatsapp|telegram|channels)(:write)?$/,
    /^email:[^:]+$/,
    /^memory:(personal|family)$/,
    /^fileAccess:readonly$/,
  ],
  personal: [
    /^(vision|voice|documents)$/,
    /^(discord|whatsapp|telegram|channels)(:write)?$/,
    /^(email|calendar):[^:]+$/,
    /^memory:(personal|family)$/,
    /^fileAccess:readonly$/,
  ],
  client: [
    // Messaging only — no email, no MCP, no memory, no file access.
    /^(discord|whatsapp|telegram|channels)(:write)?$/,
  ],
};

/**
 * Resolve the effective tier of an agent: explicit `tier` field if present,
 * otherwise "personal" (sane default). `fullAccess: true` callers should
 * skip the check entirely.
 */
export function resolveAgentTier(agent: Pick<AgentConfig, "tier" | "fullAccess">): User["type"] {
  return agent.tier ?? "personal";
}

/**
 * Returns true if `toolId` is allowed for the given tier under
 * TIER_TOOL_WHITELIST. Owner tier (and fullAccess agents) skip this check.
 */
export function isToolAllowedForTier(toolId: string, tier: User["type"]): boolean {
  const patterns = TIER_TOOL_WHITELIST[tier];
  return patterns.some((rx) => rx.test(toolId));
}

/** A single route definition — thin matcher that references an agent by name. */
export interface Route {
  match: RouteMatch;
  /** Name of the agent to use, matching a folder in ~/.claude/jarvis/agents/. */
  use?: string;
  /** Set to "ignore" to swallow messages matching this route. */
  action?: "ignore";
  /** Populated at resolution time by findRoute(). Not persisted in YAML. */
  agent?: AgentConfig;
}

/** Channel-specific configuration */
export interface ChannelConfig {
  whatsapp?: {
    enabled: boolean;
    authDir?: string;
  };
  telegram?: {
    enabled: boolean;
    botToken?: string;
  };
  discord?: {
    enabled: boolean;
    botToken?: string;
  };
}

/** User definition */
export interface User {
  type: "owner" | "team" | "family" | "personal" | "client";
  ids: Partial<Record<Channel, string | number>>;
  access?: string[] | "full";
}

/** Cron job delivery target */
export interface CronDelivery {
  channel: Channel;
  target: string;
}

/** Cron job definition */
export interface CronJob {
  name: string;
  schedule: string;
  timezone?: string;
  workspace: string;
  model?: string;
  prompt: string;
  timeout?: number;
  delivery?: CronDelivery;
  /**
   * When true (default if `delivery` is set), prepend the cached chat history
   * for the delivery target to the prompt so the cron is aware of the recent
   * exchange before composing its message. Set false to keep cron context-free.
   */
  includeContext?: boolean;
}

/** Rate limit config */
export interface RateLimitConfig {
  maxMessages: number;
  windowSeconds: number;
}

/** Rate limits section */
export interface RateLimits {
  incoming?: RateLimitConfig;
  outgoing?: RateLimitConfig;
}

/** Jarvis-specific config */
export interface JarvisConfig {
  allowedCallers?: string[];
  alwaysReplyGroups?: string[];
  /**
   * Telegram numeric user IDs allowed to one-shot the full agent via `@jarvis`
   * mention from any chat (including groups not routed to jarvis). Mirrors the
   * WhatsApp `allowedCallers[0]` owner pattern. Find your ID via @userinfobot.
   */
  telegramOwners?: string[];
}

/** Launchd configuration for a user-defined service (optional — tray can manage it) */
export interface ServiceLaunchd {
  /** launchd label, e.g. "com.example.myservice". Must match ^[a-z][a-z0-9._-]{0,63}$ */
  label: string;
  /** Argv array for the service process. First element is the executable. */
  args: string[];
  /** Working directory. Supports ~/ expansion. */
  cwd: string;
  /** Filename for StandardOutPath/StandardErrorPath (under logs/). Defaults to label. */
  logName?: string;
}

/** User-defined service shown in the dashboard service ribbon and optionally managed by the tray */
export interface ServiceDef {
  name: string;
  port: number;
  /** Health endpoint used for up/down check. HTTPS endpoints are accepted with self-signed certs. */
  healthUrl: string;
  /** Optional link opened when clicking the service chip in the dashboard. */
  linkUrl?: string;
  /** Optional launchd config. If present, tray app can start/stop/restart the service. */
  launchd?: ServiceLaunchd;
}

/** Router-level MCP behavior overrides */
export interface McpRouterConfig {
  /**
   * MCP server names to NEVER attach to spawned SDK sessions, even when an
   * agent has `fullAccess: true`. Useful for OAuth-heavy remotes (zenda, tally)
   * that aggressively retry refresh and pop browser dialogs in tight loops
   * across multiple parallel sessions. The agent loses access to those tools
   * but the user stops seeing unsolicited OAuth tabs.
   *
   * The CLI and dashboard `claude mcp list` still see these servers — only
   * router-spawned sessions skip them.
   */
  skip?: string[];
}

/** Top-level config */
export interface Config {
  jarvis?: JarvisConfig;
  channels: ChannelConfig;
  routes: Route[];
  users: Record<string, User>;
  crons?: CronJob[];
  rateLimits?: RateLimits;
  services?: ServiceDef[];
  mcp?: McpRouterConfig;
}
