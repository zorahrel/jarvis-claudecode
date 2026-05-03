/**
 * In-process Telegram MCP server. Bot API has no historical fetch endpoint, so
 * read tools serve from a local ring buffer (services/message-buffer.ts) that
 * captures messages as they arrive at the connector. The buffer persists to
 * `state/telegram-buffer.json` so it survives restarts.
 *
 * Read tools (gated by `telegram` or `telegram:write`):
 *   telegram_read_chat, telegram_search, telegram_list_chats
 * Write tools (gated by `telegram:write`):
 *   telegram_send_message
 */

import { z } from "zod";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../types";
import { telegramBot } from "../services/connectors";
import { getSessionContext } from "../services/session-context";
import { readTelegram, listTelegramChats, searchTelegram } from "../services/message-buffer";
import {
  ok, okJson, fail, telegramChatAllowed, crossChatWriteAllowed, auditTool,
} from "./_helpers";

interface CreateOpts {
  agent: AgentConfig;
  sessionKey: string;
  canWrite: boolean;
}

const SERVER = "telegram";

export function createTelegramMcp(opts: CreateOpts): McpSdkServerConfigWithInstance {
  const { agent, sessionKey, canWrite } = opts;
  const scope = agent.telegram;

  function currentChatId(): string | null {
    return getSessionContext(sessionKey)?.telegram?.chatId ?? null;
  }

  // ---------- READ ----------

  const readChat = tool(
    "telegram_read_chat",
    "Read recent messages from a Telegram chat (from the local ring buffer captured during router uptime). Defaults to current chat. Note: history before the router started running is not available — Telegram bot API has no fetch_history.",
    {
      chat_id: z.string().optional().describe("Chat ID; defaults to current chat."),
      limit: z.number().int().positive().max(200).default(20),
    },
    async (args) => {
      const start = Date.now();
      const cur = currentChatId();
      const chatId = args.chat_id ?? cur;
      if (!chatId) return fail("no chat_id and no current Telegram chat in session");
      const gate = telegramChatAllowed(scope, cur, chatId);
      if (!gate.allowed) return fail(gate.reason);

      const msgs = readTelegram(chatId, { limit: args.limit });
      auditTool({ server: SERVER, tool: "telegram_read_chat", sessionKey, args: { chatId, limit: args.limit }, ok: true, durationMs: Date.now() - start, resultSummary: `${msgs.length}` });
      return okJson({ chatId, count: msgs.length, messages: msgs });
    },
  );

  const searchChats = tool(
    "telegram_search",
    "Search the local Telegram message buffer (case-insensitive substring). Optionally restrict to one chat.",
    {
      query: z.string().min(1),
      chat_id: z.string().optional(),
      limit: z.number().int().positive().max(100).default(20),
    },
    async (args) => {
      const start = Date.now();
      const cur = currentChatId();
      if (args.chat_id) {
        const gate = telegramChatAllowed(scope, cur, args.chat_id);
        if (!gate.allowed) return fail(gate.reason);
      }
      const matches = searchTelegram(args.query, { chatId: args.chat_id, limit: args.limit });
      const allowed = args.chat_id
        ? matches
        : matches.filter(m => telegramChatAllowed(scope, cur, m.chatId).allowed);
      auditTool({ server: SERVER, tool: "telegram_search", sessionKey, args: { q: args.query, chat_id: args.chat_id }, ok: true, durationMs: Date.now() - start, resultSummary: `${allowed.length}/${matches.length}` });
      return okJson({ query: args.query, count: allowed.length, matches: allowed });
    },
  );

  const listChats = tool(
    "telegram_list_chats",
    "List Telegram chats with messages in the local buffer.",
    {},
    async () => {
      const start = Date.now();
      const all = listTelegramChats();
      const cur = currentChatId();
      const allowed = all.filter(c => telegramChatAllowed(scope, cur, c.chatId).allowed);
      auditTool({ server: SERVER, tool: "telegram_list_chats", sessionKey, ok: true, durationMs: Date.now() - start, resultSummary: `${allowed.length}/${all.length}` });
      return okJson({ count: allowed.length, chats: allowed });
    },
  );

  // ---------- WRITE ----------

  const sendMessage = tool(
    "telegram_send_message",
    "Send a Telegram message. Defaults to the current chat. Sending elsewhere requires `allowCrossChatWrite: true` in agent.yaml.",
    {
      chat_id: z.string().optional(),
      content: z.string().min(1).max(4096),
    },
    async (args) => {
      const start = Date.now();
      if (!canWrite) return fail("write requires `telegram:write` tool");
      const bot = telegramBot();
      if (!bot) return fail("Telegram bot unavailable");
      const cur = currentChatId();
      const chatId = args.chat_id ?? cur;
      if (!chatId) return fail("no chat_id and no current Telegram chat");
      const scopeGate = telegramChatAllowed(scope, cur, chatId);
      if (!scopeGate.allowed) return fail(scopeGate.reason);
      const xGate = crossChatWriteAllowed(scope, cur, chatId);
      if (!xGate.allowed) return fail(xGate.reason);
      try {
        const sent = await bot.api.sendMessage(chatId, args.content);
        auditTool({ server: SERVER, tool: "telegram_send_message", sessionKey, args: { chatId, length: args.content.length }, ok: true, durationMs: Date.now() - start, isWrite: true, resultSummary: String(sent.message_id) });
        return ok(`Sent message ${sent.message_id} to ${chatId}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        auditTool({ server: SERVER, tool: "telegram_send_message", sessionKey, ok: false, durationMs: Date.now() - start, isWrite: true, errorReason: reason });
        return fail(reason);
      }
    },
  );

  const tools: Array<SdkMcpToolDefinition<any>> = [readChat, searchChats, listChats];
  if (canWrite) tools.push(sendMessage);

  return createSdkMcpServer({
    name: SERVER,
    version: "0.1.0",
    tools,
  });
}
