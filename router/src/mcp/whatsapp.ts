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

  const listGroups = tool(
    "whatsapp_list_groups",
    "List ALL WhatsApp groups the bot's account participates in, with name, JID, and participant count. Works regardless of message history — Baileys queries the server. Use this to resolve a group name (e.g. 'Armonia Campus') to a JID.",
    {
      query: z.string().optional().describe("Optional substring filter on group name."),
    },
    async (args) => {
      const start = Date.now();
      const sock = whatsappSocket();
      if (!sock) return fail("WhatsApp socket unavailable (not paired or disconnected)");
      try {
        const s = sock as { groupFetchAllParticipating: () => Promise<Record<string, { id: string; subject?: string; participants?: Array<{ id: string }>; creation?: number; desc?: string }>> };
        const all = await s.groupFetchAllParticipating();
        const q = args.query?.toLowerCase();
        const cur = currentJid();
        const out = Object.values(all)
          .filter(g => !q || (g.subject?.toLowerCase().includes(q) ?? false))
          .filter(g => whatsappJidAllowed(scope, cur, g.id).allowed)
          .map(g => ({
            jid: g.id,
            name: g.subject ?? "(no name)",
            participantCount: g.participants?.length ?? 0,
            createdAt: g.creation ? new Date(g.creation * 1000).toISOString() : undefined,
            description: g.desc,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        auditTool({ server: SERVER, tool: "whatsapp_list_groups", sessionKey, args, ok: true, durationMs: Date.now() - start, resultSummary: `${out.length} groups` });
        return okJson({ count: out.length, groups: out });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "whatsapp_list_groups", sessionKey, ok: false, durationMs: Date.now() - start, errorReason: reason });
        return fail(reason);
      }
    },
  );

  const getGroupInfo = tool(
    "whatsapp_get_group_info",
    "Fetch full metadata for a specific WhatsApp group: name, description, all participants, admin status, creation date. Auto-resolves LID-anonymous participants (`…@lid`) to their phone-number JIDs (`…@s.whatsapp.net`) when WhatsApp has shared the mapping with the bot's account. LIDs that haven't yet been mapped come back as `phoneJid: null` — call `whatsapp_resolve_phone` if you have a phone number to look up the inverse direction.",
    {
      jid: z.string().describe("Group JID (`…@g.us`)."),
    },
    async (args) => {
      const start = Date.now();
      const sock = whatsappSocket();
      if (!sock) return fail("WhatsApp socket unavailable");
      const cur = currentJid();
      const gate = whatsappJidAllowed(scope, cur, args.jid);
      if (!gate.allowed) return fail(gate.reason);
      try {
        const s = sock as {
          groupMetadata: (jid: string) => Promise<{ id: string; subject?: string; subjectOwner?: string; subjectTime?: number; creation?: number; owner?: string; desc?: string; descOwner?: string; participants: Array<{ id: string; admin?: "admin" | "superadmin" | null; lid?: string }> }>;
          signalRepository?: { lidMapping?: { getPNForLID: (lid: string) => Promise<string | null> } };
        };
        const meta = await s.groupMetadata(args.jid);
        const lidStore = s.signalRepository?.lidMapping;
        // Resolve LID participants to phone-number JIDs in parallel.
        const participants = await Promise.all(meta.participants.map(async p => {
          const isLid = p.id.endsWith("@lid");
          let phoneJid: string | null = isLid ? null : p.id;
          if (isLid && lidStore) {
            try { phoneJid = await lidStore.getPNForLID(p.id); } catch { phoneJid = null; }
          } else if (!isLid && p.lid) {
            // Some Baileys versions return phone-JID as id and LID as separate field.
            phoneJid = p.id;
          }
          const phone = phoneJid ? phoneJid.split("@")[0]?.split(":")[0] ?? null : null;
          return {
            participantJid: p.id,                 // raw — usually @lid these days
            phoneJid: phoneJid,                   // resolved @s.whatsapp.net (or null if mapping unknown)
            phone: phone,                         // bare digits, easier for the model to display
            admin: p.admin ?? null,
            isLid,
          };
        }));
        const resolved = participants.filter(p => p.phoneJid).length;
        auditTool({ server: SERVER, tool: "whatsapp_get_group_info", sessionKey, args, ok: true, durationMs: Date.now() - start, resultSummary: `${participants.length} participants, ${resolved} resolved` });
        return okJson({
          jid: meta.id,
          name: meta.subject ?? "(no name)",
          description: meta.desc,
          owner: meta.owner,
          createdAt: meta.creation ? new Date(meta.creation * 1000).toISOString() : undefined,
          participantCount: participants.length,
          participantsResolved: resolved,
          participants,
          note: resolved < participants.length
            ? "Some participants are LID-anonymized and the phone mapping isn't shared with this account. Try whatsapp_resolve_phone if you already know a phone number, or wait for live messages from the participant to flow through (Baileys learns mappings over time)."
            : undefined,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "whatsapp_get_group_info", sessionKey, ok: false, durationMs: Date.now() - start, errorReason: reason });
        return fail(reason);
      }
    },
  );

  const resolvePhone = tool(
    "whatsapp_resolve_phone",
    "Check whether a phone number has WhatsApp and return its JID (`…@s.whatsapp.net`). Use to translate user-supplied phone numbers (e.g. \"+39 333 1234567\") into a JID that can be passed to whatsapp_read_chat / whatsapp_send_message.",
    {
      phone: z.string().describe("Phone number in any format (E.164 with or without +, with or without spaces)."),
    },
    async (args) => {
      const start = Date.now();
      const sock = whatsappSocket();
      if (!sock) return fail("WhatsApp socket unavailable");
      const digits = args.phone.replace(/[^0-9]/g, "");
      if (digits.length < 6) return fail(`phone "${args.phone}" doesn't look like a valid number`);
      try {
        const s = sock as { onWhatsApp: (...numbers: string[]) => Promise<Array<{ jid: string; exists: boolean }> | undefined> };
        const result = await s.onWhatsApp(digits);
        const hit = result?.[0];
        auditTool({ server: SERVER, tool: "whatsapp_resolve_phone", sessionKey, args: { phone: digits }, ok: true, durationMs: Date.now() - start, resultSummary: hit?.exists ? hit.jid : "not registered" });
        if (!hit || !hit.exists) return okJson({ phone: digits, exists: false });
        return okJson({ phone: digits, exists: true, jid: hit.jid });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "whatsapp_resolve_phone", sessionKey, ok: false, durationMs: Date.now() - start, errorReason: reason });
        return fail(reason);
      }
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

  const tools: Array<SdkMcpToolDefinition<any>> = [readChat, search, listChats, listGroups, getGroupInfo, resolvePhone];
  if (canWrite) tools.push(sendMessage, react, backfill);

  return createSdkMcpServer({
    name: SERVER,
    version: "0.1.0",
    tools,
  });
}
