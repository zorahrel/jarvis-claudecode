/**
 * Shared helpers for in-process messaging MCPs.
 *
 * - Result builders that match MCP `CallToolResult` shape.
 * - Scope predicates (`channelAllowed`, etc.) that enforce per-route allow/deny lists.
 * - Audit log helper that emits one structured line per tool call.
 */

import type { ChannelScope } from "../types/config";
import { logger } from "../services/logger";

const log = logger.child({ module: "mcp" });

export interface ToolResultText {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export function ok(text: string): ToolResultText {
  return { content: [{ type: "text", text }] };
}

export function okJson(value: unknown): ToolResultText {
  return ok(JSON.stringify(value, null, 2));
}

export function fail(reason: string): ToolResultText {
  return { content: [{ type: "text", text: `Error: ${reason}` }], isError: true };
}

/** Discord channel/guild gate. */
export function discordChannelAllowed(
  scope: ChannelScope | undefined,
  current: { guildId: string | null; channelId: string },
  target: { guildId?: string | null; channelId: string },
): { allowed: true } | { allowed: false; reason: string } {
  // denyChannels always wins
  if (scope?.denyChannels?.includes(target.channelId)) {
    return { allowed: false, reason: `channel ${target.channelId} is in denyChannels` };
  }
  // explicit allowedChannels takes precedence — if set, must contain target
  if (scope?.allowedChannels && scope.allowedChannels.length > 0) {
    return scope.allowedChannels.includes(target.channelId)
      ? { allowed: true }
      : { allowed: false, reason: `channel ${target.channelId} is not in allowedChannels` };
  }
  // allowedGuilds restricts cross-guild reach
  const targetGuild = target.guildId ?? null;
  if (scope?.allowedGuilds && scope.allowedGuilds.length > 0) {
    if (!targetGuild || !scope.allowedGuilds.includes(targetGuild)) {
      return { allowed: false, reason: `guild ${targetGuild ?? "none"} is not in allowedGuilds` };
    }
    return { allowed: true };
  }
  // Default: only the current guild (or current DM channel) is reachable
  if (targetGuild && current.guildId && targetGuild !== current.guildId) {
    return { allowed: false, reason: `cross-guild access requires allowedGuilds in agent.yaml` };
  }
  if (!targetGuild && target.channelId !== current.channelId) {
    // DM — only the same DM channel
    return { allowed: false, reason: `cross-DM access requires allowedChannels in agent.yaml` };
  }
  return { allowed: true };
}

/** WhatsApp JID gate. */
export function whatsappJidAllowed(
  scope: ChannelScope | undefined,
  currentJid: string | null,
  targetJid: string,
): { allowed: true } | { allowed: false; reason: string } {
  if (scope?.denyJids?.includes(targetJid)) {
    return { allowed: false, reason: `JID ${targetJid} is in denyJids` };
  }
  if (scope?.allowedJids && scope.allowedJids.length > 0) {
    return scope.allowedJids.includes(targetJid)
      ? { allowed: true }
      : { allowed: false, reason: `JID ${targetJid} is not in allowedJids` };
  }
  // Default safe: only the current conversation
  if (currentJid && targetJid !== currentJid) {
    return { allowed: false, reason: `cross-chat access requires allowedJids in agent.yaml` };
  }
  return { allowed: true };
}

/** Telegram chat gate. */
export function telegramChatAllowed(
  scope: ChannelScope | undefined,
  currentChatId: string | null,
  targetChatId: string,
): { allowed: true } | { allowed: false; reason: string } {
  if (scope?.denyChats?.includes(targetChatId)) {
    return { allowed: false, reason: `chat ${targetChatId} is in denyChats` };
  }
  if (scope?.allowedChats && scope.allowedChats.length > 0) {
    return scope.allowedChats.includes(targetChatId)
      ? { allowed: true }
      : { allowed: false, reason: `chat ${targetChatId} is not in allowedChats` };
  }
  if (currentChatId && targetChatId !== currentChatId) {
    return { allowed: false, reason: `cross-chat access requires allowedChats in agent.yaml` };
  }
  return { allowed: true };
}

/**
 * Cross-chat write predicate. Even when read scope allows a target chat, write
 * tools default to "current conversation only" — `allowCrossChatWrite: true`
 * is the explicit opt-in.
 */
export function crossChatWriteAllowed(
  scope: ChannelScope | undefined,
  currentTarget: string | null,
  newTarget: string,
): { allowed: true } | { allowed: false; reason: string } {
  if (currentTarget && currentTarget === newTarget) return { allowed: true };
  if (scope?.allowCrossChatWrite) return { allowed: true };
  return {
    allowed: false,
    reason: `write target differs from current conversation; set allowCrossChatWrite: true in agent.yaml to enable cross-chat sends`,
  };
}

/** Audit log a single MCP tool call. Always log writes at info; reads at debug. */
export function auditTool(opts: {
  server: string;
  tool: string;
  sessionKey: string;
  args?: Record<string, unknown>;
  ok: boolean;
  durationMs: number;
  resultSummary?: string;
  isWrite?: boolean;
  errorReason?: string;
}): void {
  const level = opts.isWrite ? "info" : "debug";
  log[level]({
    server: opts.server,
    tool: opts.tool,
    sessionKey: opts.sessionKey,
    ok: opts.ok,
    durationMs: opts.durationMs,
    args: opts.args,
    result: opts.resultSummary,
    error: opts.errorReason,
  }, "MCP tool call");
}
