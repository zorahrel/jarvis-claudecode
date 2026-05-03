/**
 * Per-chat ring buffer for messages we observe in real time on channels that
 * have no server-side history API (Telegram bot API can't fetch arbitrary chat
 * history). Persisted to disk so it survives router restarts.
 *
 * Used by:
 *   - mcp/telegram.ts (read_chat / list_chats / search via this buffer)
 *
 * Caveat documented in INTEGRATIONS.md: history before the bot was added (or
 * before this buffer existed) is unreachable from the bot API. Backfilling
 * Telegram requires an MTProto user-account session — out of scope here.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { logger } from "./logger";
import { STATE_DIR, TELEGRAM_BUFFER_FILE as BUFFER_FILE } from "./paths";

const log = logger.child({ module: "message-buffer" });
const MAX_PER_CHAT = 200;
const MAX_CHATS = 500;
const PERSIST_DEBOUNCE_MS = 2000;

export interface BufferedMessage {
  /** Per-chat message id (string for portability across channels). */
  id: string;
  /** Sender's stable id (Telegram user id as string). */
  fromId?: string;
  /** Display name at the time of capture. */
  fromName?: string;
  /** Plain text or caption — empty string if media-only without caption. */
  text: string;
  /** Unix epoch seconds. */
  ts: number;
}

interface BufferShape {
  /** chatId → messages newest-last (we trim from the front when over capacity). */
  chats: Record<string, BufferedMessage[]>;
}

let buf: BufferShape = { chats: {} };
let dirty = false;
let persistTimer: NodeJS.Timeout | null = null;

function loadFromDisk(): void {
  if (!existsSync(BUFFER_FILE)) return;
  try {
    const raw = readFileSync(BUFFER_FILE, "utf8");
    const parsed = JSON.parse(raw) as BufferShape;
    if (parsed && typeof parsed === "object" && parsed.chats) {
      buf = parsed;
    }
  } catch (err) {
    log.warn({ err: String(err) }, "failed to load telegram-buffer; starting empty");
  }
}

function schedulePersist(): void {
  dirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(BUFFER_FILE, JSON.stringify(buf), "utf8");
    } catch (err) {
      log.warn({ err: String(err) }, "failed to persist telegram-buffer");
    }
  }, PERSIST_DEBOUNCE_MS);
}

loadFromDisk();

/** Append a message to the per-chat buffer. Trims oldest when over capacity. */
export function pushTelegram(chatId: string, msg: BufferedMessage): void {
  const list = buf.chats[chatId] ?? [];
  list.push(msg);
  if (list.length > MAX_PER_CHAT) list.splice(0, list.length - MAX_PER_CHAT);
  buf.chats[chatId] = list;

  // Soft cap on number of distinct chats — drop the chat with the oldest
  // last-message when we exceed the cap.
  const chatIds = Object.keys(buf.chats);
  if (chatIds.length > MAX_CHATS) {
    let oldestChatId: string | null = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const id of chatIds) {
      const arr = buf.chats[id];
      const last = arr && arr.length > 0 ? arr[arr.length - 1] : undefined;
      const ts = last ? last.ts : 0;
      if (ts < oldestTs) {
        oldestTs = ts;
        oldestChatId = id;
      }
    }
    if (oldestChatId) delete buf.chats[oldestChatId];
  }

  schedulePersist();
}

export function readTelegram(chatId: string, opts: { limit?: number } = {}): BufferedMessage[] {
  const list = buf.chats[chatId] ?? [];
  const limit = opts.limit ?? 20;
  return list.slice(-limit);
}

export function listTelegramChats(): Array<{ chatId: string; lastTs: number; count: number }> {
  return Object.entries(buf.chats).map(([chatId, msgs]) => ({
    chatId,
    lastTs: msgs.length > 0 ? msgs[msgs.length - 1]!.ts : 0,
    count: msgs.length,
  }));
}

export function searchTelegram(query: string, opts: { chatId?: string; limit?: number } = {}): Array<BufferedMessage & { chatId: string }> {
  const needle = query.toLowerCase();
  const out: Array<BufferedMessage & { chatId: string }> = [];
  const limit = opts.limit ?? 20;
  const target = opts.chatId ? { [opts.chatId]: buf.chats[opts.chatId] ?? [] } : buf.chats;
  for (const [chatId, msgs] of Object.entries(target)) {
    for (let i = msgs.length - 1; i >= 0 && out.length < limit; i--) {
      const m = msgs[i]!;
      if (m.text && m.text.toLowerCase().includes(needle)) {
        out.push({ ...m, chatId });
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}
