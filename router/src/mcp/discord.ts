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
import { Routes } from "discord.js";
import type { TextChannel, NewsChannel, ThreadChannel, Message } from "discord.js";
import type { AgentConfig } from "../types";
import { discordClient } from "../services/connectors";
import { getSessionContext } from "../services/session-context";
import {
  ok, okJson, fail, discordChannelAllowed, crossChatWriteAllowed, selfChatGuard, auditTool,
} from "./_helpers";

interface CreateOpts {
  agent: AgentConfig;
  sessionKey: string;
  canWrite: boolean;
  canAdmin: boolean;
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
  const { agent, sessionKey, canWrite, canAdmin } = opts;
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
    "Send a message to a DIFFERENT Discord channel. Requires `channel_id` and `allowCrossChatWrite: true` in agent.yaml. To reply to the user in the current channel, just emit your plain text answer — do not call this tool.",
    {
      channel_id: z.string().describe("Target channel ID. Must differ from the current channel."),
      content: z.string().min(1).max(2000).describe("Message content (max 2000 chars per Discord)."),
      reply_to: z.string().optional().describe("Message ID to reply to."),
    },
    async (args) => {
      const start = Date.now();
      if (!canWrite) return fail("write requires `discord:write` tool in agent.yaml");
      const client = discordClient();
      if (!client) return fail("Discord client unavailable");
      const current = getCurrent();
      const channelId = args.channel_id;
      const selfGate = selfChatGuard(current?.channelId ?? null, channelId);
      if (!selfGate.allowed) {
        auditTool({ server: SERVER, tool: "discord_send_message", sessionKey, args: { channelId }, ok: false, durationMs: Date.now() - start, isWrite: true, errorReason: selfGate.reason });
        return fail(selfGate.reason);
      }

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

  // ---------- ADMIN TOOLS (guild administration) ----------
  // Gated by `discord:admin` (owner-tier only — see TIER_TOOL_WHITELIST). Uses
  // the connector's bot token via client.rest — the same raw Discord v10 REST
  // endpoints as the `discord` CLI. Destructive ops require `confirm: true`.
  // Every op is restricted to the agent's guild scope and audit-logged.

  function guildScopeOrThrow(targetGuildId: string | null): string {
    const g = targetGuildId || getCurrent()?.guildId || null;
    if (!g) throw new Error("guild_id required (no current guild in this session)");
    if (scope?.allowedGuilds && scope.allowedGuilds.length > 0) {
      if (!scope.allowedGuilds.includes(g)) throw new Error(`guild ${g} is not in allowedGuilds`);
    } else {
      const cur = getCurrent()?.guildId ?? null;
      if (cur && g !== cur) throw new Error("cross-guild admin requires allowedGuilds in agent.yaml");
    }
    return g;
  }
  const toColor = (c?: string): number | undefined => {
    if (!c) return undefined;
    const n = parseInt(String(c).replace(/^#/, ""), 16);
    return Number.isNaN(n) ? undefined : n;
  };
  const CH_TYPE: Record<string, number> = { text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15 };

  function adminTool(
    name: string,
    description: string,
    schema: z.ZodRawShape,
    run: (client: any, args: any) => Promise<unknown>,
    o: { destructive?: boolean } = {},
  ): SdkMcpToolDefinition<any> {
    return tool(name, description, schema, async (args: any) => {
      const start = Date.now();
      const auditFail = (reason: string) => {
        auditTool({ server: SERVER, tool: name, sessionKey, args, ok: false, durationMs: Date.now() - start, isWrite: true, errorReason: reason });
        return fail(reason);
      };
      if (!canAdmin) return auditFail("requires `discord:admin` in agent.yaml (owner-tier only)");
      const client = discordClient();
      if (!client) return auditFail("Discord client unavailable");
      if (o.destructive && args.confirm !== true) return fail(`${name} is destructive — pass confirm:true to proceed`);
      try {
        const result = await run(client, args);
        auditTool({ server: SERVER, tool: name, sessionKey, args, ok: true, durationMs: Date.now() - start, isWrite: true, resultSummary: typeof result === "string" ? result : JSON.stringify(result).slice(0, 200) });
        return okJson(result);
      } catch (err) {
        return auditFail(err instanceof Error ? err.message : String(err));
      }
    });
  }

  const listRoles = adminTool("discord_list_roles",
    "List all roles in a guild (id, name, color, position). Use to get role IDs for assign/edit/delete.",
    { guild_id: z.string().optional().describe("Guild ID; defaults to the current guild.") },
    async (client, args) => {
      const g = guildScopeOrThrow(args.guild_id ?? null);
      const roles = (await client.rest.get(Routes.guildRoles(g))) as any[];
      return roles.map((r) => ({ id: r.id, name: r.name, color: r.color, position: r.position, managed: r.managed }));
    });

  const createChannel = adminTool("discord_create_channel",
    "Create a channel in a guild. type: text|voice|forum|announcement|stage (default text).",
    {
      name: z.string().min(1).max(100),
      type: z.enum(["text", "voice", "forum", "announcement", "stage"]).optional(),
      guild_id: z.string().optional(),
      category_id: z.string().optional().describe("Parent category ID."),
      topic: z.string().max(1024).optional(),
    },
    async (client, args) => {
      const g = guildScopeOrThrow(args.guild_id ?? null);
      const body: Record<string, unknown> = { name: args.name, type: CH_TYPE[args.type ?? "text"] ?? 0 };
      if (args.category_id) body.parent_id = args.category_id;
      if (args.topic) body.topic = args.topic;
      const ch = (await client.rest.post(Routes.guildChannels(g), { body })) as any;
      return { created: ch.id, name: ch.name, type: ch.type };
    });

  const createCategory = adminTool("discord_create_category",
    "Create a category (channel group) in a guild.",
    { name: z.string().min(1).max(100), guild_id: z.string().optional() },
    async (client, args) => {
      const g = guildScopeOrThrow(args.guild_id ?? null);
      const ch = (await client.rest.post(Routes.guildChannels(g), { body: { name: args.name, type: 4 } })) as any;
      return { created: ch.id, name: ch.name, category: true };
    });

  const editChannel = adminTool("discord_edit_channel",
    'Edit a channel: rename, change topic, move into a category (category_id, or "none" to detach), or reorder (position). Covers the CLI\'s move.',
    {
      channel_id: z.string(),
      name: z.string().max(100).optional(),
      topic: z.string().max(1024).optional(),
      category_id: z.string().optional().describe('Parent category ID, or "none" to remove from category.'),
      position: z.number().int().optional(),
    },
    async (client, args) => {
      const ch0 = (await client.channels.fetch(args.channel_id)) as any;
      if (!ch0) throw new Error(`channel ${args.channel_id} not found`);
      guildScopeOrThrow(ch0.guildId ?? null);
      const body: Record<string, unknown> = {};
      if (args.name != null) body.name = args.name;
      if (args.topic != null) body.topic = args.topic;
      if (args.category_id != null) body.parent_id = args.category_id === "none" ? null : args.category_id;
      if (args.position != null) body.position = args.position;
      const ch = (await client.rest.patch(Routes.channel(args.channel_id), { body })) as any;
      return { edited: ch.id, name: ch.name, parent_id: ch.parent_id ?? null };
    });

  const deleteChannel = adminTool("discord_delete_channel",
    "Delete a channel. DESTRUCTIVE — requires confirm:true.",
    { channel_id: z.string(), confirm: z.boolean().optional().describe("Must be true to actually delete.") },
    async (client, args) => {
      const ch0 = (await client.channels.fetch(args.channel_id)) as any;
      if (!ch0) throw new Error(`channel ${args.channel_id} not found`);
      guildScopeOrThrow(ch0.guildId ?? null);
      const ch = (await client.rest.delete(Routes.channel(args.channel_id))) as any;
      return { deleted: ch?.id ?? args.channel_id, name: ch?.name };
    }, { destructive: true });

  const createRole = adminTool("discord_create_role",
    'Create a role. color = hex (e.g. "#5865F2"). permissions = a Discord permission bitfield string (e.g. "8" for Administrator).',
    {
      name: z.string().min(1).max(100),
      guild_id: z.string().optional(),
      color: z.string().optional(),
      permissions: z.string().optional(),
      hoist: z.boolean().optional(),
      mentionable: z.boolean().optional(),
    },
    async (client, args) => {
      const g = guildScopeOrThrow(args.guild_id ?? null);
      const body: Record<string, unknown> = { name: args.name };
      const col = toColor(args.color); if (col != null) body.color = col;
      if (args.permissions != null) body.permissions = args.permissions;
      if (args.hoist != null) body.hoist = args.hoist;
      if (args.mentionable != null) body.mentionable = args.mentionable;
      const r = (await client.rest.post(Routes.guildRoles(g), { body })) as any;
      return { created: r.id, name: r.name };
    });

  const editRole = adminTool("discord_edit_role",
    "Edit a role (name/color/permissions/hoist/mentionable).",
    {
      role_id: z.string(),
      guild_id: z.string().optional(),
      name: z.string().max(100).optional(),
      color: z.string().optional(),
      permissions: z.string().optional(),
      hoist: z.boolean().optional(),
      mentionable: z.boolean().optional(),
    },
    async (client, args) => {
      const g = guildScopeOrThrow(args.guild_id ?? null);
      const body: Record<string, unknown> = {};
      if (args.name != null) body.name = args.name;
      const col = toColor(args.color); if (col != null) body.color = col;
      if (args.permissions != null) body.permissions = args.permissions;
      if (args.hoist != null) body.hoist = args.hoist;
      if (args.mentionable != null) body.mentionable = args.mentionable;
      const r = (await client.rest.patch(Routes.guildRole(g, args.role_id), { body })) as any;
      return { edited: r.id, name: r.name };
    });

  const deleteRole = adminTool("discord_delete_role",
    "Delete a role. DESTRUCTIVE — requires confirm:true.",
    { role_id: z.string(), guild_id: z.string().optional(), confirm: z.boolean().optional() },
    async (client, args) => {
      const g = guildScopeOrThrow(args.guild_id ?? null);
      await client.rest.delete(Routes.guildRole(g, args.role_id));
      return { deleted: args.role_id };
    }, { destructive: true });

  const assignRole = adminTool("discord_assign_role",
    "Add or remove a role on a member. Set remove:true to unassign.",
    {
      user_id: z.string(),
      role_id: z.string(),
      guild_id: z.string().optional(),
      remove: z.boolean().optional().describe("true = unassign instead of assign."),
    },
    async (client, args) => {
      const g = guildScopeOrThrow(args.guild_id ?? null);
      const route = Routes.guildMemberRole(g, args.user_id, args.role_id);
      if (args.remove) { await client.rest.delete(route); return { unassigned: args.role_id, from: args.user_id }; }
      await client.rest.put(route);
      return { assigned: args.role_id, to: args.user_id };
    });

  const setPermission = adminTool("discord_set_permission",
    'Set a permission overwrite on a channel for a role or member. allow/deny = Discord permission bitfield strings (e.g. "1024" = VIEW_CHANNEL).',
    {
      channel_id: z.string(),
      target_id: z.string().describe("Role ID or member (user) ID."),
      target_type: z.enum(["role", "member"]),
      allow: z.string().optional(),
      deny: z.string().optional(),
    },
    async (client, args) => {
      const ch0 = (await client.channels.fetch(args.channel_id)) as any;
      if (!ch0) throw new Error(`channel ${args.channel_id} not found`);
      guildScopeOrThrow(ch0.guildId ?? null);
      const body: Record<string, unknown> = { type: args.target_type === "member" ? 1 : 0 };
      if (args.allow != null) body.allow = args.allow;
      if (args.deny != null) body.deny = args.deny;
      await client.rest.put(Routes.channelPermission(args.channel_id, args.target_id), { body });
      return { channel: args.channel_id, target: args.target_id, type: args.target_type, allow: args.allow ?? null, deny: args.deny ?? null };
    });

  const adminTools = [listRoles, createChannel, createCategory, editChannel, deleteChannel, createRole, editRole, deleteRole, assignRole, setPermission];

  const tools: Array<SdkMcpToolDefinition<any>> = [readChannel, searchChannel, getMessage, listChannels, listMembers];
  if (canWrite) tools.push(sendMessage, react, editOwn, deleteOwn);
  if (canAdmin) tools.push(...adminTools);

  return createSdkMcpServer({
    name: SERVER,
    version: "0.1.0",
    tools,
  });
}
