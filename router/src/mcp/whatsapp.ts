/**
 * In-process WhatsApp MCP server.
 *
 * Read tools shell out to `wacli` (deep history + FTS5 search via local SQLite).
 * Write tools (gated by `whatsapp:write`) reuse the live Baileys socket from
 * the WhatsAppConnector (router/src/connectors/whatsapp.ts).
 *
 * Why split: Baileys is a *bot* — bidirectional but no historical message API.
 * wacli pairs as a *client* and maintains a synced local DB. Together they
 * give the agent both deep read and live write.
 *
 * Read tools (gated by `whatsapp` or `whatsapp:write`):
 *   whatsapp_read_chat, whatsapp_search, whatsapp_list_chats, whatsapp_backfill
 * Write tools (gated by `whatsapp:write` only):
 *   whatsapp_send_message, whatsapp_react
 */

import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../types";
import { whatsappSocket } from "../services/connectors";
import { getSessionContext } from "../services/session-context";
import * as wacli from "../services/wacli";
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

  function checkWacli(): { ok: true } | { ok: false; reason: string } {
    if (!wacli.isAvailable()) return { ok: false, reason: wacli.unavailableReason() };
    return { ok: true };
  }

  // ---------- READ ----------

  const readChat = tool(
    "whatsapp_read_chat",
    "Read recent messages from a WhatsApp chat. Defaults to the current chat. Reads from the local wacli store; install/sync wacli for deep history.",
    {
      jid: z.string().optional().describe("Chat JID (group `…@g.us` or DM `…@s.whatsapp.net`); defaults to current chat."),
      limit: z.number().int().positive().max(200).default(20),
      before: z.string().optional().describe("Message ID to paginate before."),
    },
    async (args) => {
      const start = Date.now();
      const probe = checkWacli();
      if (!probe.ok) return fail(probe.reason);
      const cur = currentJid();
      const jid = args.jid ?? cur;
      if (!jid) return fail("no jid and no current WhatsApp chat in session");
      const gate = whatsappJidAllowed(scope, cur, jid);
      if (!gate.allowed) return fail(gate.reason);

      try {
        const msgs = await wacli.listChatMessages({ chat: jid, limit: args.limit, before: args.before });
        auditTool({ server: SERVER, tool: "whatsapp_read_chat", sessionKey, args: { jid, limit: args.limit }, ok: true, durationMs: Date.now() - start, resultSummary: `${msgs.length} msgs` });
        return okJson({ jid, count: msgs.length, messages: msgs });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "whatsapp_read_chat", sessionKey, ok: false, durationMs: Date.now() - start, errorReason: reason });
        return fail(reason);
      }
    },
  );

  const search = tool(
    "whatsapp_search",
    "Full-text search WhatsApp messages via the local wacli SQLite store (FTS5). Optionally restrict to a single chat or date range.",
    {
      query: z.string().min(1),
      jid: z.string().optional().describe("Chat JID to restrict the search to."),
      after: z.string().optional().describe("ISO date or YYYY-MM-DD lower bound."),
      before: z.string().optional().describe("ISO date or YYYY-MM-DD upper bound."),
      limit: z.number().int().positive().max(100).default(20),
    },
    async (args) => {
      const start = Date.now();
      const probe = checkWacli();
      if (!probe.ok) return fail(probe.reason);
      const cur = currentJid();
      if (args.jid) {
        const gate = whatsappJidAllowed(scope, cur, args.jid);
        if (!gate.allowed) return fail(gate.reason);
      }
      try {
        const msgs = await wacli.searchMessages({
          query: args.query,
          chat: args.jid,
          limit: args.limit,
          after: args.after,
          before: args.before,
        });
        // If no jid filter was given, post-filter results by allowed JIDs to enforce scope
        const allowed = args.jid
          ? msgs
          : msgs.filter(m => whatsappJidAllowed(scope, cur, m.chatJid).allowed);
        auditTool({ server: SERVER, tool: "whatsapp_search", sessionKey, args: { q: args.query, jid: args.jid }, ok: true, durationMs: Date.now() - start, resultSummary: `${allowed.length}/${msgs.length}` });
        return okJson({ query: args.query, count: allowed.length, messages: allowed });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "whatsapp_search", sessionKey, ok: false, durationMs: Date.now() - start, errorReason: reason });
        return fail(reason);
      }
    },
  );

  const listChats = tool(
    "whatsapp_list_chats",
    "List known WhatsApp chats (groups and DMs) from the wacli store. Filtered to allowedJids when configured.",
    {
      query: z.string().optional().describe("Optional name/number substring filter."),
      limit: z.number().int().positive().max(200).default(50),
    },
    async (args) => {
      const start = Date.now();
      const probe = checkWacli();
      if (!probe.ok) return fail(probe.reason);
      try {
        const chats = await wacli.listChats({ query: args.query, limit: args.limit });
        const cur = currentJid();
        const allowed = chats.filter(c => whatsappJidAllowed(scope, cur, c.jid).allowed);
        auditTool({ server: SERVER, tool: "whatsapp_list_chats", sessionKey, args, ok: true, durationMs: Date.now() - start, resultSummary: `${allowed.length}/${chats.length}` });
        return okJson({ count: allowed.length, chats: allowed });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "whatsapp_list_chats", sessionKey, ok: false, durationMs: Date.now() - start, errorReason: reason });
        return fail(reason);
      }
    },
  );

  const backfill = tool(
    "whatsapp_backfill",
    "Pull older history for a specific chat into the local wacli store. Requires the user's phone to be online. Capped at 200 messages per call.",
    {
      jid: z.string().describe("Chat JID to backfill."),
      count: z.number().int().positive().max(200).default(50),
      requests: z.number().int().positive().max(5).default(2),
    },
    async (args) => {
      const start = Date.now();
      if (!canWrite) return fail("backfill requires `whatsapp:write` tool (it talks to WhatsApp servers)");
      const probe = checkWacli();
      if (!probe.ok) return fail(probe.reason);
      const cur = currentJid();
      const gate = whatsappJidAllowed(scope, cur, args.jid);
      if (!gate.allowed) return fail(gate.reason);
      try {
        const result = await wacli.backfillHistory({ chat: args.jid, count: args.count, requests: args.requests });
        auditTool({ server: SERVER, tool: "whatsapp_backfill", sessionKey, args, ok: true, durationMs: Date.now() - start, isWrite: true, resultSummary: `${result.backfilled}` });
        return okJson(result);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "whatsapp_backfill", sessionKey, ok: false, durationMs: Date.now() - start, isWrite: true, errorReason: reason });
        return fail(reason);
      }
    },
  );

  // ---------- WRITE ----------

  const sendMessage = tool(
    "whatsapp_send_message",
    "Send a WhatsApp message. Defaults to the current chat. Sending elsewhere requires `allowCrossChatWrite: true` and the JID in `allowedJids`.",
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
        // Type assertion: socket type is opaque in services/connectors.ts
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

  const tools: Array<SdkMcpToolDefinition<any>> = [readChat, search, listChats];
  if (canWrite) tools.push(backfill, sendMessage, react);

  return createSdkMcpServer({
    name: SERVER,
    version: "0.1.0",
    tools,
  });
}
