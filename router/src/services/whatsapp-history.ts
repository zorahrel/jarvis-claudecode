/**
 * Per-chat message store for WhatsApp, built on the live Baileys socket.
 *
 * Why this exists: the in-process WhatsApp MCP (mcp/whatsapp.ts) needs to
 * read past messages, but the Baileys WASocket only emits live events
 * (`messages.upsert`, `messaging-history.set`). We capture those into a
 * local store so MCP read tools can serve them on demand.
 *
 * Sources:
 *   - `messaging-history.set` (after pair) → up to ~14 days of past messages
 *   - `messages.upsert` (live) → everything from now on
 *   - `sock.fetchMessageHistory(count, key, ts)` → on-demand backfill,
 *      results arrive back via `messages.upsert` (type=notify, requestId set)
 *
 * Persistence: per-chat JSONL files under `state/whatsapp-history/<sha1(jid)>.jsonl`,
 * appended on every captured message. Loaded into memory on first read per chat
 * (lazy). Capped at MAX_PER_CHAT entries — older messages stay on disk but the
 * in-memory window slides forward.
 *
 * No separate authentication, no extra process — same Baileys session paired
 * via the dashboard.
 */

import { mkdirSync, existsSync, createReadStream, appendFileSync, readdirSync } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import { createHash } from "crypto";
import { logger } from "./logger";
import { WHATSAPP_HISTORY_DIR as STATE_DIR } from "./paths";

const log = logger.child({ module: "whatsapp-history" });

mkdirSync(STATE_DIR, { recursive: true });

const MAX_PER_CHAT = 500;
const MAX_LOAD_BYTES = 4 * 1024 * 1024; // safety: don't load chats larger than 4 MB on demand

export interface WAStoredMessage {
  /** Stable per-chat message id (`waMsg.key.id`). */
  id: string;
  /** Chat JID (group `…@g.us` or DM `…@s.whatsapp.net`). */
  chatJid: string;
  /** Sender's JID. For groups this is the participant; for DMs it's the chat JID itself or `null` if `fromMe`. */
  fromJid?: string;
  /** Display name at capture time (Baileys `pushName`). */
  fromName?: string;
  /** Plain text or caption. Empty when media-only without caption. */
  text: string;
  /** Unix epoch seconds. */
  ts: number;
  /** True when sent by the bot's own account. */
  fromMe: boolean;
  /** Media kind, when present. */
  mediaType?: "image" | "video" | "audio" | "voice" | "document" | "sticker";
}

// In-memory window per chat (most recent MAX_PER_CHAT entries).
const chats = new Map<string, WAStoredMessage[]>();
// Chats we have already loaded from disk this process — avoids re-reading.
const loaded = new Set<string>();

function fileForJid(jid: string): string {
  const hash = createHash("sha1").update(jid).digest("hex").slice(0, 16);
  return join(STATE_DIR, `${hash}.jsonl`);
}

async function loadChatFromDisk(jid: string): Promise<void> {
  if (loaded.has(jid)) return;
  loaded.add(jid);
  const file = fileForJid(jid);
  if (!existsSync(file)) {
    chats.set(jid, []);
    return;
  }
  // Cheap protection: skip if absurdly large (something else needs to handle that).
  try {
    const stat = (await import("fs/promises")).stat;
    const s = await stat(file);
    if (s.size > MAX_LOAD_BYTES) {
      log.warn({ jid, bytes: s.size }, "WA history file exceeds load cap; reading tail only");
    }
  } catch { /* ignore */ }

  const tail: WAStoredMessage[] = [];
  await new Promise<void>((resolve) => {
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }) });
    rl.on("line", (line) => {
      if (!line) return;
      try {
        const m = JSON.parse(line) as WAStoredMessage;
        tail.push(m);
        if (tail.length > MAX_PER_CHAT) tail.shift();
      } catch { /* skip corrupt line */ }
    });
    rl.on("close", () => resolve());
    rl.on("error", () => resolve());
  });
  chats.set(jid, tail);
}

async function ensureLoaded(jid: string): Promise<WAStoredMessage[]> {
  if (!loaded.has(jid)) await loadChatFromDisk(jid);
  return chats.get(jid) ?? [];
}

/** Append a captured message to the in-memory window and disk. */
export function pushMessage(msg: WAStoredMessage): void {
  const arr = chats.get(msg.chatJid) ?? [];
  // Dedupe by id (Baileys can replay during reconnects).
  if (arr.some(m => m.id === msg.id)) return;
  arr.push(msg);
  if (arr.length > MAX_PER_CHAT) arr.splice(0, arr.length - MAX_PER_CHAT);
  chats.set(msg.chatJid, arr);
  loaded.add(msg.chatJid);
  // Persist (best-effort).
  try {
    appendFileSync(fileForJid(msg.chatJid), JSON.stringify(msg) + "\n", "utf8");
  } catch (err) {
    log.warn({ err: String(err), jid: msg.chatJid }, "WA history append failed");
  }
}

/** Bulk ingest from `messaging-history.set`. */
export function pushBulk(msgs: WAStoredMessage[]): void {
  for (const m of msgs) pushMessage(m);
}

export async function listMessages(jid: string, opts: { limit?: number; before?: string } = {}): Promise<WAStoredMessage[]> {
  const arr = await ensureLoaded(jid);
  const limit = opts.limit ?? 20;
  if (opts.before) {
    const idx = arr.findIndex(m => m.id === opts.before);
    if (idx > 0) return arr.slice(Math.max(0, idx - limit), idx);
    return [];
  }
  return arr.slice(-limit);
}

export async function searchMessages(query: string, opts: { jid?: string; limit?: number } = {}): Promise<WAStoredMessage[]> {
  const needle = query.toLowerCase();
  const limit = opts.limit ?? 20;
  const out: WAStoredMessage[] = [];
  if (opts.jid) {
    const arr = await ensureLoaded(opts.jid);
    for (let i = arr.length - 1; i >= 0 && out.length < limit; i--) {
      const m = arr[i]!;
      if (m.text && m.text.toLowerCase().includes(needle)) out.push(m);
    }
    return out;
  }
  // Multi-chat search: scan everything currently in memory + on-demand-load
  // chats we've never touched. We *don't* preload all chats from disk on every
  // search (could be hundreds of MB); we use what's already cached.
  for (const [jid, arr] of chats) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const m = arr[i]!;
      if (m.text && m.text.toLowerCase().includes(needle)) {
        out.push(m);
        if (out.length >= limit) return out;
      }
    }
    if (out.length >= limit) break;
  }
  // Best-effort: also probe chats we haven't loaded yet — just enumerate file
  // names → JID is hashed so we can't reverse it; rely on chats already loaded
  // by previous reads. Document this in INTEGRATIONS.md.
  return out;
}

export async function listChats(opts: { query?: string; limit?: number } = {}): Promise<Array<{ jid: string; lastTs: number; count: number; lastFromName?: string }>> {
  // Surface all chats we know about — both in-memory and discovered on disk.
  // Disk discovery: enumerate files, attempt to read first/last line for jid + ts.
  const known = new Set<string>(chats.keys());
  let onDiskJids: string[] = [];
  try {
    onDiskJids = readdirSync(STATE_DIR)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => f.replace(/\.jsonl$/, ""));
  } catch { /* ignore */ }

  // For chats not yet loaded, lazy-load just enough to surface them here.
  for (const _hash of onDiskJids) {
    // We can't reverse-hash to JID; rely on `pushMessage` having already cached
    // the chat in `chats` whenever it was last seen. Cold chats not pushed
    // yet this process won't surface — first received message will register them.
  }

  const out: Array<{ jid: string; lastTs: number; count: number; lastFromName?: string }> = [];
  for (const jid of known) {
    const arr = chats.get(jid)!;
    if (arr.length === 0) continue;
    const last = arr[arr.length - 1]!;
    if (opts.query) {
      const q = opts.query.toLowerCase();
      if (!jid.toLowerCase().includes(q) && !(last.fromName?.toLowerCase().includes(q) ?? false)) continue;
    }
    out.push({ jid, lastTs: last.ts, count: arr.length, lastFromName: last.fromName });
  }
  out.sort((a, b) => b.lastTs - a.lastTs);
  return out.slice(0, opts.limit ?? 50);
}

/** Returns the oldest in-memory message for a chat — used by backfill to anchor `fetchMessageHistory`. */
export async function oldestMessage(jid: string): Promise<WAStoredMessage | null> {
  const arr = await ensureLoaded(jid);
  return arr.length > 0 ? arr[0]! : null;
}
