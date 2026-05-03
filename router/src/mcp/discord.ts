/**
 * In-process Discord MCP server. Reuses the live discord.js client from the
 * DiscordConnector — no extra bot token, no extra process. Per-session scope
 * (current channel/guild) is read from `session-context.ts` at call time.
 *
 * Read tools (gated by `discord` or `discord:write`):
 *   discord_read_channel, discord_search_channel, discord_get_message,
 *   discord_list_channels, discord_list_members
 * Write tools (gated by `discord:write` only):
 *   discord_send_message, discord_react, discord_edit_own, discord_delete_own
 */

import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { TextChannel, NewsChannel, ThreadChannel, Message } from "discord.js";
import type { AgentConfig } from "../types";
import { discordClient } from "../services/connectors";
import { getSessionContext } from "../services/session-context";
import {
  ok, okJson, fail, discordChannelAllowed, crossChatWriteAllowed, auditTool,
} from "./_helpers";

interface CreateOpts {
  agent: AgentConfig;
  sessionKey: string;
  canWrite: boolean;
}

const SERVER = "discord";
const READ_CAP_LIMIT = 100;

function fetchableChannel(ch: unknown): TextChannel | NewsChannel | ThreadChannel | null {
  if (!ch || typeof ch !== "object") return null;
  const c = ch as { isTextBased?: () => boolean };
  if (typeof c.isTextBased !== "function" || !c.isTextBased()) return null;
  return ch as TextChannel | NewsChannel | ThreadChannel;
}

function summarizeMessage(m: Message): {
  id: string;
  author: { id: string; name: string; bot: boolean };
  content: string;
  ts: string;
  attachments: Array<{ name: string; url: string; contentType?: string }>;
  reference?: { messageId: string; channelId: string };
} {
  return {
    id: m.id,
    author: { id: m.author.id, name: m.author.username, bot: m.author.bot },
    content: m.content,
    ts: new Date(m.createdTimestamp).toISOString(),
    attachments: [...m.attachments.values()].map(a => ({
      name: a.name ?? "attachment",
      url: a.url,
      contentType: a.contentType ?? undefined,
    })),
    reference: m.reference?.messageId
      ? { messageId: m.reference.messageId, channelId: m.reference.channelId ?? m.channelId }
      : undefined,
  };
}

export function createDiscordMcp(opts: CreateOpts): McpSdkServerConfigWithInstance {
  const { agent, sessionKey, canWrite } = opts;
  const scope = agent.discord;

  function getCurrent(): { guildId: string | null; channelId: string } | null {
    const ctx = getSessionContext(sessionKey)?.discord;
    return ctx ? { guildId: ctx.guildId, channelId: ctx.channelId } : null;
  }

  // ---------- READ TOOLS ----------

  const readChannel = tool(
    "discord_read_channel",
    "Read recent messages from a Discord channel. Defaults to the current channel of this conversation.",
    {
      channel_id: z.string().optional().describe("Channel ID; defaults to the current channel."),
      limit: z.number().int().positive().max(READ_CAP_LIMIT).default(20).describe("Max messages to return (1-100)."),
      before: z.string().optional().describe("Message ID to paginate before (older)."),
      after: z.string().optional().describe("Message ID to paginate after (newer)."),
    },
    async (args) => {
      const start = Date.now();
      const client = discordClient();
      if (!client) return fail("Discord client unavailable");
      const current = getCurrent();
      const channelId = args.channel_id ?? current?.channelId;
      if (!channelId) return fail("no channel_id provided and no current Discord channel in session");

      try {
        const ch = fetchableChannel(await client.channels.fetch(channelId));
        if (!ch) return fail(`channel ${channelId} not found or not text-based`);
        const guildId = "guildId" in ch ? (ch.guildId as string | null) ?? null : null;

        const gate = discordChannelAllowed(scope, current ?? { guildId: null, channelId: "" }, { guildId, channelId });
        if (!gate.allowed) return fail(gate.reason);

        const opts: Parameters<typeof ch.messages.fetch>[0] = { limit: args.limit };
        if (args.before) (opts as Record<string, unknown>).before = args.before;
        if (args.after) (opts as Record<string, unknown>).after = args.after;
        const msgs = await ch.messages.fetch(opts);
        const arr = [...msgs.values()].map(summarizeMessage).sort((a, b) => a.ts.localeCompare(b.ts));
        auditTool({ server: SERVER, tool: "discord_read_channel", sessionKey, args: { channelId, limit: args.limit }, ok: true, durationMs: Date.now() - start, resultSummary: `${arr.length} messages` });
        return okJson({ channelId, count: arr.length, messages: arr });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "discord_read_channel", sessionKey, ok: false, durationMs: Date.now() - start, errorReason: reason });
        return fail(reason);
      }
    },
  );

  const searchChannel = tool(
    "discord_search_channel",
    "Search recent messages in a Discord channel by case-insensitive substring. Linear scan — for deep history, paginate with discord_read_channel and the `before` cursor.",
    {
      channel_id: z.string().optional().describe("Channel ID; defaults to the current channel."),
      query: z.string().min(1).describe("Substring to search for (case-insensitive)."),
      limit: z.number().int().positive().max(READ_CAP_LIMIT).default(10),
      scan: z.number().int().positive().max(500).default(200).describe("How many recent messages to scan."),
    },
    async (args) => {
      const start = Date.now();
      const client = discordClient();
      if (!client) return fail("Discord client unavailable");
      const current = getCurrent();
      const channelId = args.channel_id ?? current?.channelId;
      if (!channelId) return fail("no channel_id and no current Discord channel");

      try {
        const ch = fetchableChannel(await client.channels.fetch(channelId));
        if (!ch) return fail(`channel ${channelId} not found`);
        const guildId = "guildId" in ch ? (ch.guildId as string | null) ?? null : null;
        const gate = discordChannelAllowed(scope, current ?? { guildId: null, channelId: "" }, { guildId, channelId });
        if (!gate.allowed) return fail(gate.reason);

        const needle = args.query.toLowerCase();
        const matches: ReturnType<typeof summarizeMessage>[] = [];
        let cursor: string | undefined;
        let scanned = 0;
        while (scanned < args.scan && matches.length < args.limit) {
          const batchSize = Math.min(100, args.scan - scanned);
          const batchOpts: Record<string, unknown> = { limit: batchSize };
          if (cursor) batchOpts.before = cursor;
          const batch = await ch.messages.fetch(batchOpts as Parameters<typeof ch.messages.fetch>[0]);
          if (batch.size === 0) break;
          const sorted = [...batch.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
          for (const m of sorted) {
            scanned++;
            if (m.content.toLowerCase().includes(needle)) matches.push(summarizeMessage(m));
            if (matches.length >= args.limit) break;
          }
          cursor = sorted[sorted.length - 1]?.id;
          if (!cursor) break;
        }
        auditTool({ server: SERVER, tool: "discord_search_channel", sessionKey, args: { channelId, query: args.query }, ok: true, durationMs: Date.now() - start, resultSummary: `${matches.length}/${scanned}` });
        return okJson({ channelId, scanned, matches });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "discord_search_channel", sessionKey, ok: false, durationMs: Date.now() - start, errorReason: reason });
        return fail(reason);
      }
    },
  );

  const getMessage = tool(
    "discord_get_message",
    "Fetch a single message by ID, including attachments and reactions.",
    {
      channel_id: z.string().describe("Channel ID where the message lives."),
      message_id: z.string().describe("Message ID."),
    },
    async (args) => {
      const start = Date.now();
      const client = discordClient();
      if (!client) return fail("Discord client unavailable");
      const current = getCurrent();
      try {
        const ch = fetchableChannel(await client.channels.fetch(args.channel_id));
        if (!ch) return fail(`channel ${args.channel_id} not found`);
        const guildId = "guildId" in ch ? (ch.guildId as string | null) ?? null : null;
        const gate = discordChannelAllowed(scope, current ?? { guildId: null, channelId: "" }, { guildId, channelId: args.channel_id });
        if (!gate.allowed) return fail(gate.reason);

        const m = await ch.messages.fetch(args.message_id);
        const summary = summarizeMessage(m);
        const reactions = [...m.reactions.cache.values()].map(r => ({
          emoji: r.emoji.name ?? r.emoji.id ?? "?",
          count: r.count,
        }));
        auditTool({ server: SERVER, tool: "discord_get_message", sessionKey, args, ok: true, durationMs: Date.now() - start });
        return okJson({ ...summary, reactions });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "discord_get_message", sessionKey, ok: false, durationMs: Date.now() - start, errorReason: reason });
        return fail(reason);
      }
    },
  );

  const listChannels = tool(
    "discord_list_channels",
    "List text channels in a guild (defaults to current guild). Returns channel IDs, names, and topic.",
    {
      guild_id: z.string().optional().describe("Guild ID; defaults to the current guild."),
    },
    async (args) => {
      const start = Date.now();
      const client = discordClient();
      if (!client) return fail("Discord client unavailable");
      const current = getCurrent();
      const guildId = args.guild_id ?? current?.guildId ?? undefined;
      if (!guildId) return fail("no guild_id and no current Discord guild (DM context?)");

      // guild scope check
      const gate = discordChannelAllowed(scope, current ?? { guildId: null, channelId: "" }, { guildId, channelId: "" });
      if (!gate.allowed) return fail(gate.reason);

      try {
        const guild = await client.guilds.fetch(guildId);
        const channels = await guild.channels.fetch();
        const list: Array<{ id: string; name: string; topic: string | null; type: number }> = [];
        for (const c of channels.values()) {
          if (!c) continue;
          const textCapable = (c as { isTextBased?: () => boolean }).isTextBased?.() === true;
          if (!textCapable) continue;
          list.push({
            id: c.id,
            name: "name" in c && typeof (c as { name: unknown }).name === "string" ? (c as { name: string }).name : "?",
            topic: "topic" in c ? ((c as { topic: string | null }).topic ?? null) : null,
            type: c.type,
          });
        }
        auditTool({ server: SERVER, tool: "discord_list_channels", sessionKey, args: { guildId }, ok: true, durationMs: Date.now() - start, resultSummary: `${list.length}` });
        return okJson({ guildId, channels: list });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "discord_list_channels", sessionKey, ok: false, durationMs: Date.now() - start, errorReason: reason });
        return fail(reason);
      }
    },
  );

  const listMembers = tool(
    "discord_list_members",
    "List members of a guild (defaults to current guild). Returns user IDs, usernames, display names. No PII beyond what the bot can already see.",
    {
      guild_id: z.string().optional(),
      limit: z.number().int().positive().max(200).default(100),
    },
    async (args) => {
      const start = Date.now();
      const client = discordClient();
      if (!client) return fail("Discord client unavailable");
      const current = getCurrent();
      const guildId = args.guild_id ?? current?.guildId ?? undefined;
      if (!guildId) return fail("no guild_id and no current Discord guild");

      const gate = discordChannelAllowed(scope, current ?? { guildId: null, channelId: "" }, { guildId, channelId: "" });
      if (!gate.allowed) return fail(gate.reason);

      try {
        const guild = await client.guilds.fetch(guildId);
        const members = await guild.members.fetch({ limit: args.limit });
        const list = [...members.values()].map(m => ({
          id: m.user.id,
          username: m.user.username,
          displayName: m.displayName,
          bot: m.user.bot,
        }));
        auditTool({ server: SERVER, tool: "discord_list_members", sessionKey, args: { guildId, limit: args.limit }, ok: true, durationMs: Date.now() - start, resultSummary: `${list.length}` });
        return okJson({ guildId, members: list });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "discord_list_members", sessionKey, ok: false, durationMs: Date.now() - start, errorReason: reason });
        return fail(reason);
      }
    },
  );

  // ---------- WRITE TOOLS ----------

  const sendMessage = tool(
    "discord_send_message",
    "Send a message to a Discord channel. Defaults to the current channel; sending elsewhere requires `allowCrossChatWrite: true` in agent.yaml.",
    {
      channel_id: z.string().optional().describe("Channel ID; defaults to the current channel."),
      content: z.string().min(1).max(2000).describe("Message content (max 2000 chars per Discord)."),
      reply_to: z.string().optional().describe("Message ID to reply to."),
    },
    async (args) => {
      const start = Date.now();
      if (!canWrite) return fail("write requires `discord:write` tool in agent.yaml");
      const client = discordClient();
      if (!client) return fail("Discord client unavailable");
      const current = getCurrent();
      const channelId = args.channel_id ?? current?.channelId;
      if (!channelId) return fail("no channel_id and no current Discord channel");

      try {
        const ch = fetchableChannel(await client.channels.fetch(channelId));
        if (!ch) return fail(`channel ${channelId} not found`);
        const guildId = "guildId" in ch ? (ch.guildId as string | null) ?? null : null;
        const scopeGate = discordChannelAllowed(scope, current ?? { guildId: null, channelId: "" }, { guildId, channelId });
        if (!scopeGate.allowed) return fail(scopeGate.reason);
        const xGate = crossChatWriteAllowed(scope, current?.channelId ?? null, channelId);
        if (!xGate.allowed) return fail(xGate.reason);

        const sent = await ch.send({
          content: args.content,
          ...(args.reply_to ? { reply: { messageReference: args.reply_to, failIfNotExists: false } } : {}),
        });
        auditTool({ server: SERVER, tool: "discord_send_message", sessionKey, args: { channelId, length: args.content.length, reply_to: args.reply_to }, ok: true, durationMs: Date.now() - start, isWrite: true, resultSummary: sent.id });
        return ok(`Sent message ${sent.id} to channel ${channelId}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "discord_send_message", sessionKey, ok: false, durationMs: Date.now() - start, isWrite: true, errorReason: reason });
        return fail(reason);
      }
    },
  );

  const react = tool(
    "discord_react",
    "Add a reaction emoji to a message.",
    {
      channel_id: z.string().describe("Channel ID where the message lives."),
      message_id: z.string().describe("Message ID."),
      emoji: z.string().describe("Unicode emoji (e.g. 👍) or custom emoji ID."),
    },
    async (args) => {
      const start = Date.now();
      if (!canWrite) return fail("write requires `discord:write` tool");
      const client = discordClient();
      if (!client) return fail("Discord client unavailable");
      const current = getCurrent();
      try {
        const ch = fetchableChannel(await client.channels.fetch(args.channel_id));
        if (!ch) return fail(`channel ${args.channel_id} not found`);
        const guildId = "guildId" in ch ? (ch.guildId as string | null) ?? null : null;
        const gate = discordChannelAllowed(scope, current ?? { guildId: null, channelId: "" }, { guildId, channelId: args.channel_id });
        if (!gate.allowed) return fail(gate.reason);

        const m = await ch.messages.fetch(args.message_id);
        await m.react(args.emoji);
        auditTool({ server: SERVER, tool: "discord_react", sessionKey, args, ok: true, durationMs: Date.now() - start, isWrite: true });
        return ok(`reacted ${args.emoji} on ${args.message_id}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "discord_react", sessionKey, ok: false, durationMs: Date.now() - start, isWrite: true, errorReason: reason });
        return fail(reason);
      }
    },
  );

  const editOwn = tool(
    "discord_edit_own",
    "Edit a message previously sent by this bot. Refuses to edit messages from other users.",
    {
      channel_id: z.string(),
      message_id: z.string(),
      content: z.string().min(1).max(2000),
    },
    async (args) => {
      const start = Date.now();
      if (!canWrite) return fail("write requires `discord:write` tool");
      const client = discordClient();
      if (!client) return fail("Discord client unavailable");
      const current = getCurrent();
      try {
        const ch = fetchableChannel(await client.channels.fetch(args.channel_id));
        if (!ch) return fail(`channel ${args.channel_id} not found`);
        const guildId = "guildId" in ch ? (ch.guildId as string | null) ?? null : null;
        const gate = discordChannelAllowed(scope, current ?? { guildId: null, channelId: "" }, { guildId, channelId: args.channel_id });
        if (!gate.allowed) return fail(gate.reason);

        const m = await ch.messages.fetch(args.message_id);
        if (m.author.id !== client.user?.id) return fail("can only edit own messages");
        await m.edit(args.content);
        auditTool({ server: SERVER, tool: "discord_edit_own", sessionKey, args: { channel_id: args.channel_id, message_id: args.message_id, length: args.content.length }, ok: true, durationMs: Date.now() - start, isWrite: true });
        return ok(`edited ${args.message_id}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "discord_edit_own", sessionKey, ok: false, durationMs: Date.now() - start, isWrite: true, errorReason: reason });
        return fail(reason);
      }
    },
  );

  const deleteOwn = tool(
    "discord_delete_own",
    "Delete a message previously sent by this bot. Refuses to delete messages from other users.",
    {
      channel_id: z.string(),
      message_id: z.string(),
    },
    async (args) => {
      const start = Date.now();
      if (!canWrite) return fail("write requires `discord:write` tool");
      const client = discordClient();
      if (!client) return fail("Discord client unavailable");
      const current = getCurrent();
      try {
        const ch = fetchableChannel(await client.channels.fetch(args.channel_id));
        if (!ch) return fail(`channel ${args.channel_id} not found`);
        const guildId = "guildId" in ch ? (ch.guildId as string | null) ?? null : null;
        const gate = discordChannelAllowed(scope, current ?? { guildId: null, channelId: "" }, { guildId, channelId: args.channel_id });
        if (!gate.allowed) return fail(gate.reason);

        const m = await ch.messages.fetch(args.message_id);
        if (m.author.id !== client.user?.id) return fail("can only delete own messages");
        await m.delete();
        auditTool({ server: SERVER, tool: "discord_delete_own", sessionKey, args, ok: true, durationMs: Date.now() - start, isWrite: true });
        return ok(`deleted ${args.message_id}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "discord_delete_own", sessionKey, ok: false, durationMs: Date.now() - start, isWrite: true, errorReason: reason });
        return fail(reason);
      }
    },
  );

  const tools: Array<SdkMcpToolDefinition<any>> = [readChannel, searchChannel, getMessage, listChannels, listMembers];
  if (canWrite) tools.push(sendMessage, react, editOwn, deleteOwn);

  return createSdkMcpServer({
    name: SERVER,
    version: "0.1.0",
    tools,
  });
}
