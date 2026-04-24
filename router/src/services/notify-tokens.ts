/**
 * Notify token registry — channel+target binding for proactive messages.
 *
 * Root-causal design: the token IS the authority. Each token is bound to a
 * specific `{channel, target}` pair at issue time. Whoever presents the token
 * can only notify that one binding — spoofing via body params is impossible
 * by construction (the endpoint ignores channel/target from the body).
 *
 * Lifetime:
 *   issueToken()    — at CLI spawn (getOrCreateProcess in claude.ts)
 *   resolveToken()  — in POST /api/notify handler
 *   revokeToken()   — at CLI kill (killProcess in claude.ts)
 *
 * Persistence:
 *   On disk we store ONLY the SHA-256 hash of the token plaintext. The
 *   plaintext lives in:
 *     a) the in-memory map of this module (for O(1) resolve during a session)
 *     b) the env var of the child CLI process (JARVIS_NOTIFY_TOKEN)
 *   A router restart wipes (a) but (b) survives in any long-running background
 *   bash started before the restart. On restart those processes can still
 *   submit their token and we validate via the persisted hash set, then
 *   treat the hit as "valid, but no in-memory binding" — the caller must
 *   re-fail gracefully. In practice the child dies with the router, so this
 *   is mostly defensive: the hash registry lets us recognise valid tokens
 *   without persisting secrets.
 *
 * TTL: 24h. Longer than the CLI inactivity timeout (15m) so that a
 * `Bash(run_in_background)` child holding the token for a long time can still
 * notify when it finally finishes.
 *
 * GC: on module load + every 1h via setInterval. Removes expired entries
 * from the in-memory map and the on-disk hash registry.
 */

import { randomUUID, createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "fs";
import { dirname, join } from "path";
import { logger } from "./logger";

const log = logger.child({ module: "notify-tokens" });

const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const GC_INTERVAL_MS = 60 * 60 * 1000; // 1h

const FILE = join(process.cwd(), "data", "notify-tokens.json");

export interface NotifyBinding {
  channel: string;
  target: string;
  issuedAt: number;
  expiresAt: number;
}

interface PersistedEntry {
  hash: string;
  channel: string;
  target: string;
  issuedAt: number;
  expiresAt: number;
}

/** In-memory map: plaintext token → binding. Only populated for tokens issued
 *  by the current process. Lost on restart (by design — plaintext is never
 *  written to disk). */
const tokens = new Map<string, NotifyBinding>();

/** In-memory mirror of the on-disk hash registry. Keyed by SHA-256(hash) so a
 *  long-running child from a previous run can still present its token and be
 *  validated against the expiry metadata (channel/target persisted alongside
 *  so we can reconstruct the binding without the plaintext). */
const persistedHashes = new Map<string, PersistedEntry>();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function ensureDir(): void {
  const dir = dirname(FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadPersisted(): void {
  try {
    if (!existsSync(FILE)) return;
    const raw = readFileSync(FILE, "utf-8");
    const parsed = JSON.parse(raw) as PersistedEntry[];
    if (!Array.isArray(parsed)) return;
    const now = Date.now();
    for (const e of parsed) {
      if (!e || typeof e.hash !== "string") continue;
      if (e.expiresAt > now) persistedHashes.set(e.hash, e);
    }
  } catch (err) {
    log.warn({ err }, "Failed to load persisted notify tokens");
  }
}

function persist(): void {
  try {
    ensureDir();
    const entries = [...persistedHashes.values()];
    // 0600 at creation — no umask race between writeFileSync and chmodSync.
    // Registry stores hashes only, but associated channel/target metadata is
    // sensitive enough to warrant owner-only access from the first byte.
    writeFileSync(FILE, JSON.stringify(entries), { encoding: "utf-8", mode: 0o600 });
    // Defensive re-chmod in case the file already existed with looser perms
    // (writeFileSync preserves existing mode when the file exists).
    try { chmodSync(FILE, 0o600); } catch { /* best effort */ }
  } catch (err) {
    log.warn({ err }, "Failed to persist notify tokens");
  }
}

/** Issue a new token bound to the given (channel, target). Returns the
 *  plaintext token — only ever returned here. Caller is responsible for
 *  passing it to exactly one child process via env. */
export function issueToken(channel: string, target: string): string {
  const token = randomUUID();
  const now = Date.now();
  const binding: NotifyBinding = {
    channel,
    target,
    issuedAt: now,
    expiresAt: now + TTL_MS,
  };
  tokens.set(token, binding);
  const hash = hashToken(token);
  persistedHashes.set(hash, { hash, ...binding });
  persist();
  return token;
}

/** Resolve a token to its (channel, target) binding, or null if unknown or
 *  expired. Safe to call across restarts — falls back to the persisted hash
 *  registry when the in-memory map misses. */
export function resolveToken(token: string): { channel: string; target: string } | null {
  if (!token || typeof token !== "string") return null;
  const now = Date.now();

  const inMem = tokens.get(token);
  if (inMem) {
    if (inMem.expiresAt <= now) {
      tokens.delete(token);
      persistedHashes.delete(hashToken(token));
      persist();
      return null;
    }
    return { channel: inMem.channel, target: inMem.target };
  }

  const hash = hashToken(token);
  const persisted = persistedHashes.get(hash);
  if (!persisted) return null;
  if (persisted.expiresAt <= now) {
    persistedHashes.delete(hash);
    persist();
    return null;
  }
  return { channel: persisted.channel, target: persisted.target };
}

/** Revoke a token explicitly — called on CLI kill so leaked tokens from a
 *  dead session can't be used. */
export function revokeToken(token: string): void {
  if (!token) return;
  tokens.delete(token);
  const hash = hashToken(token);
  if (persistedHashes.delete(hash)) persist();
}

/** Remove all expired entries. */
function gc(): void {
  const now = Date.now();
  let changed = 0;
  for (const [token, binding] of tokens) {
    if (binding.expiresAt <= now) {
      tokens.delete(token);
      changed++;
    }
  }
  for (const [hash, entry] of persistedHashes) {
    if (entry.expiresAt <= now) {
      persistedHashes.delete(hash);
      changed++;
    }
  }
  if (changed > 0) {
    persist();
    log.debug({ removed: changed }, "Notify token GC");
  }
}

// Load + schedule GC on module load
loadPersisted();
gc();
const gcTimer = setInterval(gc, GC_INTERVAL_MS);
if (typeof gcTimer.unref === "function") gcTimer.unref();

/** Testing / observability. */
export function _debugStats(): { inMemory: number; persisted: number } {
  return { inMemory: tokens.size, persisted: persistedHashes.size };
}
