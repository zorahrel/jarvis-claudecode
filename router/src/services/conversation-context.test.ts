/**
 * Run with: npx tsx --test src/services/conversation-context.test.ts
 *
 * Guards the core fix: the model must ALWAYS learn where it is and who wrote,
 * the location line must NOT be gated on channel-MCP tools (only the tool hint
 * is), group chats must be flagged multi-person with per-message attribution,
 * and the real group name must be used (not the sender's name).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConversationContext,
  speakerLabel,
  isGroupChat,
  type ContextDeps,
} from "./conversation-context.js";
import type { IncomingMessage, AgentConfig } from "../types";

// Inject a resolver so role rendering doesn't depend on live config.
const OWNER = "+393313998288";
const deps: ContextDeps = {
  resolveSender: (_channel, id) =>
    id === OWNER ? { key: "attilio", name: "Attilio", role: "owner" } : null,
  resolveChat: () => null,
};

function msg(partial: Partial<IncomingMessage>): IncomingMessage {
  return {
    channel: "whatsapp",
    from: "",
    text: "ciao",
    timestamp: 0,
    reply: async () => {},
    ...partial,
  } as IncomingMessage;
}

const withTool = (tool: string) => ({ tools: [tool] }) as unknown as AgentConfig;
const noTools = () => ({ tools: [] }) as unknown as AgentConfig;

test("WhatsApp group: real group name, multi-person flag, role-aware sender", () => {
  const m = msg({
    channel: "whatsapp",
    from: OWNER,
    channelContext: {
      whatsapp: { jid: "120@g.us", isGroup: true, groupName: "Famiglia", senderName: "Attilio C." },
    },
  });
  const out = buildConversationContext(m, withTool("whatsapp"), deps)!;
  assert.match(out, /WhatsApp, group "Famiglia"/);
  assert.match(out, /multi-person/);
  assert.match(out, /from Attilio \(owner\)/);
  // tool present → hint included
  assert.match(out, /whatsapp_read_chat/);
  // never leak the sender's name as the group name
  assert.doesNotMatch(out, /group "Attilio/);
});

test("location line is ALWAYS present, even without the channel MCP tool", () => {
  const m = msg({
    channel: "whatsapp",
    from: OWNER,
    channelContext: { whatsapp: { jid: "120@g.us", isGroup: true, groupName: "Famiglia" } },
  });
  const out = buildConversationContext(m, noTools(), deps)!;
  assert.match(out, /WhatsApp, group "Famiglia"/);
  assert.match(out, /from Attilio \(owner\)/);
  // gated tool hint must be absent
  assert.doesNotMatch(out, /whatsapp_read_chat/);
});

test("unknown sender falls back to connector display name, no role", () => {
  const m = msg({
    channel: "whatsapp",
    from: "+390000000000",
    channelContext: { whatsapp: { jid: "120@g.us", isGroup: true, groupName: "Lavoro", senderName: "Mario" } },
  });
  const out = buildConversationContext(m, noTools(), deps)!;
  assert.match(out, /from Mario\b/);
  assert.doesNotMatch(out, /\(owner\)/);
  assert.equal(speakerLabel(m, deps), "Mario");
});

test("WhatsApp DM: 'direct message' + 'with X', no speaker prefix", () => {
  const m = msg({
    channel: "whatsapp",
    from: OWNER,
    channelContext: { whatsapp: { jid: "x@s.whatsapp.net", isGroup: false, senderName: "Attilio C." } },
  });
  const out = buildConversationContext(m, noTools(), deps)!;
  assert.match(out, /WhatsApp \(direct message\) with Attilio \(owner\)/);
  assert.doesNotMatch(out, /multi-person/);
  assert.equal(speakerLabel(m, deps), null); // DMs: no prefix
});

test("Discord guild: server + channel, tool hint gated", () => {
  const m = msg({
    channel: "discord",
    from: "999",
    channelContext: {
      discord: { guildId: "g1", guildName: "Armonia", channelId: "c1", channelName: "generale", authorName: "Luca" },
    },
  });
  const withHint = buildConversationContext(m, withTool("discord"), deps)!;
  assert.match(withHint, /Discord, server "Armonia" #generale/);
  assert.match(withHint, /multi-person/);
  assert.match(withHint, /from Luca\b/);
  assert.match(withHint, /discord_read_channel/);

  const noHint = buildConversationContext(m, noTools(), deps)!;
  assert.match(noHint, /Discord, server "Armonia" #generale/);
  assert.doesNotMatch(noHint, /discord_read_channel/);
});

test("Telegram supergroup: chatTitle + fromName fallback", () => {
  const m = msg({
    channel: "telegram",
    from: "777",
    channelContext: {
      telegram: { chatId: "-100", chatType: "supergroup", chatTitle: "Devs", fromName: "Giulia", fromUsername: "giul" },
    },
  });
  const out = buildConversationContext(m, withTool("telegram"), deps)!;
  assert.match(out, /Telegram, supergroup "Devs"/);
  assert.match(out, /from Giulia\b/);
  assert.match(out, /telegram_read_chat/);
  assert.equal(speakerLabel(m, deps), "Giulia");
});

test("no channelContext (e.g. notch) → null", () => {
  const m = msg({ channel: "notch", from: "notch", channelContext: undefined });
  assert.equal(buildConversationContext(m, noTools(), deps), null);
  assert.equal(speakerLabel(m, deps), null);
  assert.equal(isGroupChat(m), false);
});
