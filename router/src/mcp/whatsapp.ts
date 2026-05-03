/**
 * In-process WhatsApp MCP server.
 *
 * Reads from `services/whatsapp-history.ts` — a per-chat store populated by
 * the live Baileys session via `messages.upsert` and `messaging-history.set`.
 * No separate CLI, no second pairing: the dashboard's WhatsApp re-pair flow
 * is the only auth path.
 *
 * Read tools (gated by `whatsapp` or `whatsapp:write`):
 *   whatsapp_read_chat, whatsapp_search, whatsapp_list_chats
 * Write tools (gated by `whatsapp:write` only):
 *   whatsapp_send_message, whatsapp_react, whatsapp_backfill
 *
 * `whatsapp_backfill` calls `sock.fetchMessageHistory(...)`. Results arrive
 * asynchronously via `messages.upsert` (type `notify`, with `requestId`) and
 * land in the store automatically; subsequent `whatsapp_read_chat` will see
 * them.
 */

import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../types";
import { whatsappSocket } from "../services/connectors";
import { getSessionContext } from "../services/session-context";
import * as wa from "../services/whatsapp-history";
import {
  ok, okJson, fail, whatsappJidAllowed, crossChatWriteAllowed, auditTool,
} from "./_helpers";

interface CreateOpts {
  agent: AgentConfig;
  sessionKey: string;
  canWrite: boolean;
}

const SERVER = "whatsapp";

export function createWhatsappMcp(opts: CreateOpts): McpSdkServerConfigWithInstance {
  const { agent, sessionKey, canWrite } = opts;
  const scope = agent.whatsapp;

  function currentJid(): string | null {
    return getSessionContext(sessionKey)?.whatsapp?.jid ?? null;
  }

  // ---------- READ ----------

  const readChat = tool(
    "whatsapp_read_chat",
    "Read recent messages from a WhatsApp chat. Defaults to the current chat. Reads from the local store populated by the live Baileys session — depth depends on how long the router has been running plus initial history sync (~14 days from the pair).",
    {
      jid: z.string().optional().describe("Chat JID (group `…@g.us` or DM `…@s.whatsapp.net`); defaults to current chat."),
      limit: z.number().int().positive().max(200).default(20),
      before: z.string().optional().describe("Message ID to paginate before (older)."),
    },
    async (args) => {
      const start = Date.now();
      const cur = currentJid();
      const jid = args.jid ?? cur;
      if (!jid) return fail("no jid and no current WhatsApp chat in session");
      const gate = whatsappJidAllowed(scope, cur, jid);
      if (!gate.allowed) return fail(gate.reason);

      const msgs = await wa.listMessages(jid, { limit: args.limit, before: args.before });
      auditTool({ server: SERVER, tool: "whatsapp_read_chat", sessionKey, args: { jid, limit: args.limit }, ok: true, durationMs: Date.now() - start, resultSummary: `${msgs.length} msgs` });
      return okJson({ jid, count: msgs.length, messages: msgs });
    },
  );

  const search = tool(
    "whatsapp_search",
    "Substring search across the local WhatsApp message store. Optionally restrict to one chat. For deeper history, call whatsapp_backfill first to pull older messages from the WhatsApp servers.",
    {
      query: z.string().min(1),
      jid: z.string().optional().describe("Chat JID to restrict the search to."),
      limit: z.number().int().positive().max(100).default(20),
    },
    async (args) => {
      const start = Date.now();
      const cur = currentJid();
      if (args.jid) {
        const gate = whatsappJidAllowed(scope, cur, args.jid);
        if (!gate.allowed) return fail(gate.reason);
      }
      const msgs = await wa.searchMessages(args.query, { jid: args.jid, limit: args.limit });
      const allowed = args.jid
        ? msgs
        : msgs.filter(m => whatsappJidAllowed(scope, cur, m.chatJid).allowed);
      auditTool({ server: SERVER, tool: "whatsapp_search", sessionKey, args: { q: args.query, jid: args.jid }, ok: true, durationMs: Date.now() - start, resultSummary: `${allowed.length}/${msgs.length}` });
      return okJson({ query: args.query, count: allowed.length, messages: allowed });
    },
  );

  const listChats = tool(
    "whatsapp_list_chats",
    "List WhatsApp chats with messages in the local store. Filtered to allowedJids when configured.",
    {
      query: z.string().optional().describe("Optional name/JID substring filter."),
      limit: z.number().int().positive().max(200).default(50),
    },
    async (args) => {
      const start = Date.now();
      const all = await wa.listChats({ query: args.query, limit: args.limit });
      const cur = currentJid();
      const allowed = all.filter(c => whatsappJidAllowed(scope, cur, c.jid).allowed);
      auditTool({ server: SERVER, tool: "whatsapp_list_chats", sessionKey, args, ok: true, durationMs: Date.now() - start, resultSummary: `${allowed.length}/${all.length}` });
      return okJson({ count: allowed.length, chats: allowed });
    },
  );

  // ---------- WRITE ----------

  const sendMessage = tool(
    "whatsapp_send_message",
    "Send a WhatsApp message. Defaults to the current chat. Sending elsewhere requires `allowCrossChatWrite: true` in agent.yaml and the JID in `allowedJids` (or no allow-list configured).",
    {
      jid: z.string().optional().describe("Chat JID; defaults to the current chat."),
      content: z.string().min(1).max(4096),
    },
    async (args) => {
      const start = Date.now();
      if (!canWrite) return fail("write requires `whatsapp:write` tool");
      const sock = whatsappSocket();
      if (!sock) return fail("WhatsApp socket unavailable (not paired or disconnected)");
      const cur = currentJid();
      const jid = args.jid ?? cur;
      if (!jid) return fail("no jid and no current WhatsApp chat");
      const scopeGate = whatsappJidAllowed(scope, cur, jid);
      if (!scopeGate.allowed) return fail(scopeGate.reason);
      const xGate = crossChatWriteAllowed(scope, cur, jid);
      if (!xGate.allowed) return fail(xGate.reason);
      try {
        const s = sock as { sendMessage: (jid: string, content: { text: string }) => Promise<{ key?: { id?: string } } | undefined> };
        const sent = await s.sendMessage(jid, { text: args.content });
        const id = sent?.key?.id ?? "";
        auditTool({ server: SERVER, tool: "whatsapp_send_message", sessionKey, args: { jid, length: args.content.length }, ok: true, durationMs: Date.now() - start, isWrite: true, resultSummary: id });
        return ok(`Sent message ${id} to ${jid}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "whatsapp_send_message", sessionKey, ok: false, durationMs: Date.now() - start, isWrite: true, errorReason: reason });
        return fail(reason);
      }
    },
  );

  const react = tool(
    "whatsapp_react",
    "Add a reaction emoji to a WhatsApp message. Send empty string to remove.",
    {
      jid: z.string().describe("Chat JID where the message lives."),
      message_id: z.string().describe("Message ID."),
      emoji: z.string().describe("Unicode emoji or empty string to remove."),
    },
    async (args) => {
      const start = Date.now();
      if (!canWrite) return fail("write requires `whatsapp:write` tool");
      const sock = whatsappSocket();
      if (!sock) return fail("WhatsApp socket unavailable");
      const cur = currentJid();
      const gate = whatsappJidAllowed(scope, cur, args.jid);
      if (!gate.allowed) return fail(gate.reason);
      try {
        const s = sock as { sendMessage: (jid: string, content: { react: { text: string; key: { id: string; fromMe?: boolean; remoteJid?: string } } }) => Promise<unknown> };
        await s.sendMessage(args.jid, { react: { text: args.emoji, key: { id: args.message_id, remoteJid: args.jid, fromMe: false } } });
        auditTool({ server: SERVER, tool: "whatsapp_react", sessionKey, args, ok: true, durationMs: Date.now() - start, isWrite: true });
        return ok(`reacted ${args.emoji || "(none)"} on ${args.message_id}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "whatsapp_react", sessionKey, ok: false, durationMs: Date.now() - start, isWrite: true, errorReason: reason });
        return fail(reason);
      }
    },
  );

  const backfill = tool(
    "whatsapp_backfill",
    "Pull older history for a chat from the WhatsApp servers via the live Baileys socket. Requires the user's phone to be online. Results arrive asynchronously into the store — call whatsapp_read_chat after a short delay to see them.",
    {
      jid: z.string().describe("Chat JID to backfill."),
      count: z.number().int().positive().max(200).default(50),
    },
    async (args) => {
      const start = Date.now();
      if (!canWrite) return fail("backfill requires `whatsapp:write` tool (it talks to WhatsApp servers)");
      const sock = whatsappSocket();
      if (!sock) return fail("WhatsApp socket unavailable");
      const cur = currentJid();
      const gate = whatsappJidAllowed(scope, cur, args.jid);
      if (!gate.allowed) return fail(gate.reason);
      try {
        const oldest = await wa.oldestMessage(args.jid);
        if (!oldest || !oldest.id) {
          return fail("no anchor message — receive or send at least one message in this chat first, then retry backfill");
        }
        const s = sock as {
          fetchMessageHistory: (count: number, oldestKey: { id: string; remoteJid: string; fromMe: boolean }, oldestTs: number) => Promise<string>;
        };
        const requestId = await s.fetchMessageHistory(
          args.count,
          { id: oldest.id, remoteJid: args.jid, fromMe: oldest.fromMe },
          oldest.ts,
        );
        auditTool({ server: SERVER, tool: "whatsapp_backfill", sessionKey, args, ok: true, durationMs: Date.now() - start, isWrite: true, resultSummary: `requestId=${requestId}` });
        return okJson({ requested: true, count: args.count, requestId, note: "Results land asynchronously via messages.upsert; retry whatsapp_read_chat in a few seconds." });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "whatsapp_backfill", sessionKey, ok: false, durationMs: Date.now() - start, isWrite: true, errorReason: reason });
        return fail(reason);
      }
    },
  );

  const tools: Array<SdkMcpToolDefinition<any>> = [readChat, search, listChats];
  if (canWrite) tools.push(sendMessage, react, backfill);

  return createSdkMcpServer({
    name: SERVER,
    version: "0.1.0",
    tools,
  });
}
