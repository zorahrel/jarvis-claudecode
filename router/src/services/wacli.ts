/**
 * Subprocess wrapper for `wacli` (https://wacli.sh) — the WhatsApp CLI by
 * @steipete that maintains a local SQLite store of message history with FTS5
 * search, plus send capabilities. We shell out to it with `--json` to drive
 * the in-process WhatsApp MCP (mcp/whatsapp.ts).
 *
 * This is a *parallel* path to the live Baileys connector (router/src/connectors/whatsapp.ts):
 *   - Baileys handles real-time bot duties: receive messages, reply, react, media.
 *   - wacli handles deep-history search and provides on-demand chat list/backfill.
 *   - Both auth on the same WhatsApp number; they each pair once via QR/code.
 *
 * Failure mode: `wacli` may not be installed. The `probe()` function caches
 * availability at boot — MCP tools check `isAvailable()` and return a structured
 * "service unavailable" message when missing, with install hints.
 */

import { spawn } from "child_process";
import { logger } from "./logger";

const log = logger.child({ module: "wacli" });

let probed = false;
let available = false;
let version: string | null = null;
let probeError: string | null = null;

export async function probe(): Promise<void> {
  if (probed) return;
  probed = true;
  try {
    const { stdout } = await runWacli(["doctor", "--json"], { timeoutMs: 5000 });
    available = true;
    try {
      const parsed = JSON.parse(stdout);
      version = typeof parsed.version === "string" ? parsed.version : null;
    } catch {
      version = null;
    }
    log.info({ version }, "wacli detected");
  } catch (err) {
    available = false;
    probeError = err instanceof Error ? err.message : String(err);
    log.info({ reason: probeError }, "wacli not available — WhatsApp MCP read tools disabled (install: brew install steipete/tap/wacli)");
  }
}

export function isAvailable(): boolean {
  return available;
}
export function unavailableReason(): string {
  return probeError ?? "wacli not installed (run: brew install steipete/tap/wacli)";
}
export function getVersion(): string | null {
  return version;
}

interface RunOpts {
  timeoutMs?: number;
}

function runWacli(args: string[], opts: RunOpts = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("wacli", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | null = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`wacli timeout after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }
    proc.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    proc.on("error", err => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    proc.on("close", code => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`wacli exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

// ============================================================
// TYPED COMMAND WRAPPERS
// ============================================================

export interface WacliChat {
  jid: string;
  name?: string;
  isGroup: boolean;
  lastMessageAt?: string;
  unread?: number;
}

export interface WacliMessage {
  id: string;
  chatJid: string;
  fromJid?: string;
  fromName?: string;
  text?: string;
  ts: string;
  fromMe: boolean;
  hasMedia?: boolean;
  mediaType?: string;
}

function parseJsonLines<T>(stdout: string): T[] {
  const out: T[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t) as T); } catch { /* skip non-JSON lines */ }
  }
  return out;
}

function parseSingle<T>(stdout: string): T | null {
  const t = stdout.trim();
  if (!t) return null;
  // Try as object/array first; fall back to first JSONL line
  try { return JSON.parse(t) as T; } catch {
    const lines = parseJsonLines<T>(t);
    return lines[0] ?? null;
  }
}

export async function listChats(opts: { query?: string; limit?: number } = {}): Promise<WacliChat[]> {
  const args = ["chats", "list", "--json"];
  if (opts.limit) args.push("--limit", String(opts.limit));
  if (opts.query) args.push("--query", opts.query);
  const { stdout } = await runWacli(args, { timeoutMs: 10000 });
  const parsed = parseSingle<WacliChat[] | { chats: WacliChat[] }>(stdout);
  if (!parsed) return parseJsonLines<WacliChat>(stdout);
  if (Array.isArray(parsed)) return parsed;
  return parsed.chats ?? [];
}

export async function searchMessages(opts: {
  query: string;
  chat?: string;
  limit?: number;
  after?: string;
  before?: string;
}): Promise<WacliMessage[]> {
  const args = ["messages", "search", opts.query, "--json"];
  if (opts.chat) args.push("--chat", opts.chat);
  if (opts.limit) args.push("--limit", String(opts.limit));
  if (opts.after) args.push("--after", opts.after);
  if (opts.before) args.push("--before", opts.before);
  const { stdout } = await runWacli(args, { timeoutMs: 15000 });
  const parsed = parseSingle<WacliMessage[] | { messages: WacliMessage[] }>(stdout);
  if (!parsed) return parseJsonLines<WacliMessage>(stdout);
  if (Array.isArray(parsed)) return parsed;
  return parsed.messages ?? [];
}

export async function listChatMessages(opts: {
  chat: string;
  limit?: number;
  before?: string;
}): Promise<WacliMessage[]> {
  // wacli has `messages search` and `history backfill`, but also exposes a
  // chat-specific list via `messages list --chat`. Format may vary by version;
  // we accept either an array or NDJSON.
  const args = ["messages", "list", "--chat", opts.chat, "--json"];
  if (opts.limit) args.push("--limit", String(opts.limit));
  if (opts.before) args.push("--before", opts.before);
  const { stdout } = await runWacli(args, { timeoutMs: 10000 });
  const parsed = parseSingle<WacliMessage[] | { messages: WacliMessage[] }>(stdout);
  if (!parsed) return parseJsonLines<WacliMessage>(stdout);
  if (Array.isArray(parsed)) return parsed;
  return parsed.messages ?? [];
}

export async function backfillHistory(opts: {
  chat: string;
  count?: number;
  requests?: number;
}): Promise<{ ok: true; backfilled: number }> {
  const cap = Math.min(opts.count ?? 50, 200);
  const args = ["history", "backfill", "--chat", opts.chat, "--count", String(cap), "--json"];
  if (opts.requests) args.push("--requests", String(opts.requests));
  const { stdout } = await runWacli(args, { timeoutMs: 60000 });
  const parsed = parseSingle<{ backfilled?: number }>(stdout);
  return { ok: true, backfilled: parsed?.backfilled ?? 0 };
}
