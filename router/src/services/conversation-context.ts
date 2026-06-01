/**
 * Conversation context — the single source of truth for telling the model
 * WHERE it is and WHO is talking, on every inbound messaging turn.
 *
 * Replaces the old `buildMessagingNudge`. Two important changes vs that:
 *   1. The location + speaker line is ALWAYS emitted (when channelContext
 *      exists), not gated on the agent having the channel MCP tool. Knowing
 *      where you are and who wrote is fundamental orientation, not a
 *      tool-dependent extra. Only the "use these tools" hint stays gated.
 *   2. Senders are resolved against the `users:` registry, so the model gets
 *      role-aware identity ("Attilio (owner)" vs an unknown "Mario"), and
 *      group chats are flagged as multi-person so attribution matters.
 *
 * Per-message speaker labelling for group chats lives in `speakerLabel`,
 * consumed by handler.composeFullMessage to prefix the body — uniform across
 * Discord/WhatsApp/Telegram (previously only Discord baked an inline prefix).
 */
import type { IncomingMessage, AgentConfig } from "../types";
import {
  resolveSender as resolveSenderProd,
  resolveChat as resolveChatProd,
  type UserRole,
} from "./identity";
import {
  canDiscord, canWhatsapp, canTelegram, canChannels,
  canDiscordWrite, canWhatsappWrite, canTelegramWrite,
} from "./capabilities";

/**
 * Resolver dependencies — injectable for tests so the formatter can be
 * exercised without loading the live config. Defaults to the real resolvers.
 */
export interface ContextDeps {
  resolveSender?: typeof resolveSenderProd;
  resolveChat?: typeof resolveChatProd;
}

/** Is this message from a multi-person chat (group/guild/supergroup)? */
export function isGroupChat(msg: IncomingMessage): boolean {
  const cc = msg.channelContext;
  if (!cc) return false;
  if (cc.discord) return !!cc.discord.guildId;
  if (cc.whatsapp) return cc.whatsapp.isGroup;
  if (cc.telegram) return cc.telegram.chatType !== "private";
  return false;
}

/** Connector-provided display name for the current sender, if any. */
function connectorDisplayName(msg: IncomingMessage): string | undefined {
  const cc = msg.channelContext;
  if (!cc) return undefined;
  return (
    cc.discord?.authorName ??
    cc.whatsapp?.senderName ??
    cc.telegram?.fromName ??
    cc.telegram?.fromUsername ??
    undefined
  );
}

interface SenderInfo {
  name: string;
  role?: UserRole;
}

/** Resolve the current sender to a name (+ role when known). */
function senderInfo(msg: IncomingMessage, resolveSender: typeof resolveSenderProd): SenderInfo {
  const resolved = resolveSender(msg.channel, msg.from != null ? String(msg.from) : undefined);
  const display = connectorDisplayName(msg);
  if (resolved) return { name: resolved.name, role: resolved.role };
  return { name: display ?? "unknown" };
}

/**
 * Short speaker name to prefix a group message body (e.g. "Attilio", "Mario").
 * Null for DMs (single speaker — no prefix needed) and when no name is known.
 */
export function speakerLabel(msg: IncomingMessage, deps: ContextDeps = {}): string | null {
  if (!isGroupChat(msg)) return null;
  const { name } = senderInfo(msg, deps.resolveSender ?? resolveSenderProd);
  return name && name !== "unknown" ? name : null;
}

function whoStr(info: SenderInfo): string {
  return info.role ? `${info.name} (${info.role})` : info.name;
}

/**
 * Build the always-on conversation header prepended to the user prompt.
 * Returns null only when there is no channel context (e.g. notch — a single
 * local surface with no where/who concept).
 */
export function buildConversationContext(
  msg: IncomingMessage,
  agent: AgentConfig | undefined,
  deps: ContextDeps = {},
): string | null {
  const cc = msg.channelContext;
  if (!cc) return null;

  const resolveSender = deps.resolveSender ?? resolveSenderProd;
  const resolveChat = deps.resolveChat ?? resolveChatProd;

  const who = whoStr(senderInfo(msg, resolveSender));
  let where: string;
  let hint = "";

  if (cc.discord) {
    where = cc.discord.guildId
      ? `Discord, server "${cc.discord.guildName ?? cc.discord.guildId}" #${cc.discord.channelName ?? cc.discord.channelId}`
      : "Discord (direct message)";
    if (canDiscord(agent)) {
      hint = ` Call discord_read_channel to load surrounding messages before asking for clarification${canDiscordWrite(agent) ? "; discord_send_message to reply" : ""}.`;
    }
  } else if (cc.whatsapp) {
    if (cc.whatsapp.isGroup) {
      const client = resolveChat("whatsapp", cc.whatsapp.jid);
      const label = cc.whatsapp.groupName ?? cc.whatsapp.jid;
      where = client
        ? `WhatsApp, group "${label}" (${client.name} / ${client.role})`
        : `WhatsApp, group "${label}"`;
    } else {
      where = "WhatsApp (direct message)";
    }
    if (canWhatsapp(agent)) {
      hint = ` Call whatsapp_read_chat / whatsapp_search to look up history${canWhatsappWrite(agent) ? "; whatsapp_send_message to reply" : ""}.`;
    }
  } else if (cc.telegram) {
    where = cc.telegram.chatType === "private"
      ? "Telegram (direct message)"
      : `Telegram, ${cc.telegram.chatType} "${cc.telegram.chatTitle ?? cc.telegram.chatId}"`;
    if (canTelegram(agent)) {
      hint = ` Call telegram_read_chat / telegram_search for buffered history${canTelegramWrite(agent) ? "; telegram_send_message to reply" : ""} (only messages seen during router uptime are available).`;
    }
  } else {
    return null;
  }

  // Fallback channel hint when the agent has the cross-channel registry but no
  // specific channel context branch fired above.
  if (!hint && canChannels(agent)) {
    hint = " Use channels_resolve / channels_list_known to map human names → channel IDs.";
  }

  const body = isGroupChat(msg)
    ? `You are on ${where}. This is a multi-person chat — attribute each message to its sender. The message below is from ${who}.${hint}`
    : `You are on ${where} with ${who}.${hint}`;

  return `[Conversation context: ${body}]`;
}
