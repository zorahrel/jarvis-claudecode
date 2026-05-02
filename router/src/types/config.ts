/** Channel types */
export type Channel = "whatsapp" | "telegram" | "discord" | "notch";

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
  /** Per-channel scoping for messaging MCPs. */
  discord?: ChannelScope;
  whatsapp?: ChannelScope;
  telegram?: ChannelScope;
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
  notch?: {
    enabled: boolean;
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

/** Top-level config */
export interface Config {
  jarvis?: JarvisConfig;
  channels: ChannelConfig;
  routes: Route[];
  users: Record<string, User>;
  crons?: CronJob[];
  rateLimits?: RateLimits;
  services?: ServiceDef[];
}
