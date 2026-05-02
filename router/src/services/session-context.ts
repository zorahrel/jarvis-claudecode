/**
 * Session-context: per-session metadata about *where* the conversation is happening.
 *
 * Populated by connectors before invoking handler.handleMessage(); read by in-process
 * messaging MCPs (mcp/discord.ts, mcp/whatsapp.ts, mcp/telegram.ts) so tool calls
 * default to the *current* conversation when the agent omits channel/jid/chatId.
 *
 * The MCP also uses this to enforce "no cross-chat send unless allowCrossChatWrite".
 */

export interface DiscordSessionContext {
  guildId: string | null;
  guildName?: string;
  channelId: string;
  channelName?: string;
  lastMessageId?: string;
  lastMessageTs?: number;
  authorId?: string;
  authorName?: string;
}

export interface WhatsAppSessionContext {
  jid: string;
  isGroup: boolean;
  groupName?: string;
  senderJid?: string;
  senderName?: string;
  lastMessageId?: string;
  lastMessageTs?: number;
}

export interface TelegramSessionContext {
  chatId: string;
  chatType: "private" | "group" | "supergroup" | "channel";
  chatTitle?: string;
  fromId?: string;
  fromUsername?: string;
  lastMessageId?: number;
  lastMessageTs?: number;
}

export interface SessionContext {
  discord?: DiscordSessionContext;
  whatsapp?: WhatsAppSessionContext;
  telegram?: TelegramSessionContext;
  /** Wall-clock time when this context was last refreshed by a connector. */
  updatedAt: number;
}

const sessions = new Map<string, SessionContext>();

/**
 * Replace the channel-specific slice of a session's context. Other channel slices
 * are preserved (in theory a single sessionKey doesn't span channels, but we don't
 * assume — defensive). updatedAt always refreshes.
 */
export function setSessionContext(
  sessionKey: string,
  patch: Partial<Pick<SessionContext, "discord" | "whatsapp" | "telegram">>,
): void {
  const existing = sessions.get(sessionKey);
  const next: SessionContext = {
    ...existing,
    ...patch,
    updatedAt: Date.now(),
  };
  sessions.set(sessionKey, next);
}

export function getSessionContext(sessionKey: string): SessionContext | undefined {
  return sessions.get(sessionKey);
}

export function clearSessionContext(sessionKey: string): void {
  sessions.delete(sessionKey);
}

/** Soft size cap — older entries are evicted on demand to keep this from leaking. */
const MAX_ENTRIES = 500;
export function gcSessionContexts(): void {
  if (sessions.size <= MAX_ENTRIES) return;
  const entries = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const toDelete = sessions.size - MAX_ENTRIES;
  for (let i = 0; i < toDelete; i++) {
    const entry = entries[i];
    if (entry) sessions.delete(entry[0]);
  }
}
