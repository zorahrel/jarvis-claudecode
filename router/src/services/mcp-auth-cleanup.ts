/**
 * mcp-remote orphan-state janitor.
 *
 * `mcp-remote` (the OAuth wrapper for remote MCPs like zenda/tally/vercel)
 * coordinates between concurrent instances via lock files at
 * `~/.mcp-auth/mcp-remote-<ver>/<hash>_lock.json` containing `{ pid, port,
 * timestamp }`. The first instance binds an OAuth callback port; subsequent
 * instances reuse that port via the lock.
 *
 * Two failure modes that pop unsolicited browser tabs:
 *
 *   1) ORPHAN LOCK — the holder process dies (router restart, kill), the lock
 *      stays on disk. The next mcp-remote instance reads the orphan lock,
 *      tries to reach the dead port → fails → opens a fresh OAuth dialog.
 *
 *   2) ABORTED OAUTH — `<hash>_code_verifier.txt` (PKCE verifier, one-shot
 *      per OAuth flow) and `<hash>_client_info.json` (dynamic client
 *      registration) are written before the user finishes auth in the
 *      browser. If the user closes the tab — or two registrations happen
 *      for the same upstream URL because mcp-remote thinks the previous
 *      hash was stale — the orphan files accumulate and confuse subsequent
 *      flows: mcp-remote may treat a stale client_info as authoritative
 *      and re-trigger OAuth on every spawn (this is what gave us the
 *      "Tally pops in a loop" bug on 2026-05-08).
 *
 * This module deletes both classes of orphan state at boot. Cheap,
 * idempotent, completely safe — at worst a live mcp-remote re-runs its
 * own OAuth flow once on the next request.
 *
 * NOTE: only servers configured as `stdio + npx mcp-remote URL` use this
 * directory. Servers configured as `type: http` use Claude Code's native
 * auth store and never touch `~/.mcp-auth/`.
 */

import { readdirSync, readFileSync, statSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { logger } from "./logger";

const log = logger.child({ module: "mcp-auth-cleanup" });

const HOME = process.env.HOME ?? "";
const AUTH_ROOT = join(HOME, ".mcp-auth");

/**
 * How long an OAuth verifier may live without a matching tokens.json before
 * we consider the flow aborted. mcp-remote completes OAuth in seconds when
 * the user is awake; tens of minutes is conservative and kills only true
 * orphans (closed browser tab, killed mcp-remote mid-flow).
 */
const ABORTED_OAUTH_GRACE_MS = 30 * 60 * 1000; // 30 min

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but we can't signal (different user); ESRCH = dead.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface CleanupStats {
  scanned: number;
  removed: number;
  orphanLocks: number;
  abortedOauth: number;
  duplicateClients: number;
}

/**
 * Group entries by their hash prefix. mcp-remote names every artifact
 * `<32-char-md5-hex>_<kind>.<ext>`; the prefix identifies the (URL, client)
 * pair. We use this to reason about each pair as a unit (e.g. "this hash
 * has a verifier but no tokens → aborted flow").
 */
function groupByHash(entries: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const name of entries) {
    const m = name.match(/^([0-9a-f]{32})_(.+)$/);
    if (!m) continue;
    const hash = m[1]!;
    const arr = groups.get(hash) ?? [];
    arr.push(name);
    groups.set(hash, arr);
  }
  return groups;
}

export function cleanupOrphanMcpLocks(): CleanupStats {
  const stats: CleanupStats = {
    scanned: 0, removed: 0,
    orphanLocks: 0, abortedOauth: 0, duplicateClients: 0,
  };
  if (!existsSync(AUTH_ROOT)) return stats;

  let versionDirs: string[] = [];
  try {
    versionDirs = readdirSync(AUTH_ROOT)
      .filter(n => n.startsWith("mcp-remote-"))
      .map(n => join(AUTH_ROOT, n));
  } catch (err) {
    log.warn({ err: String(err) }, "couldn't enumerate ~/.mcp-auth");
    return stats;
  }

  for (const dir of versionDirs) {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }

    // Pass 1 — remove orphan lock files (dead pid or unreadable JSON).
    for (const name of entries) {
      if (!name.endsWith("_lock.json")) continue;
      const lockPath = join(dir, name);
      stats.scanned++;
      try {
        const raw = readFileSync(lockPath, "utf8");
        const parsed = JSON.parse(raw) as { pid?: number; port?: number };
        const pid = parsed.pid ?? 0;
        if (!isProcessAlive(pid)) {
          unlinkSync(lockPath);
          stats.removed++; stats.orphanLocks++;
          log.info({ lockPath, deadPid: pid }, "removed orphan mcp-remote lock");
        }
      } catch (err) {
        try {
          unlinkSync(lockPath);
          stats.removed++; stats.orphanLocks++;
          log.warn({ lockPath, err: String(err) }, "removed unreadable mcp-remote lock");
        } catch { /* ignore */ }
      }
    }

    // Re-list after lock removal so subsequent passes see the current state.
    try { entries = readdirSync(dir); } catch { continue; }
    const groups = groupByHash(entries);

    // Pass 2 — purge aborted OAuth flows: a hash with a code_verifier and no
    // matching tokens.json after the grace window. The PKCE verifier is
    // single-use and useless without a completed token exchange.
    for (const [hash, files] of groups.entries()) {
      const hasVerifier = files.includes(`${hash}_code_verifier.txt`);
      const hasTokens = files.includes(`${hash}_tokens.json`);
      if (!hasVerifier || hasTokens) continue;
      const verifierPath = join(dir, `${hash}_code_verifier.txt`);
      let mtime = 0;
      try { mtime = statSync(verifierPath).mtimeMs; } catch { /* ignore */ }
      if (mtime <= 0 || Date.now() - mtime < ABORTED_OAUTH_GRACE_MS) continue;
      for (const name of files) {
        const p = join(dir, name);
        try {
          unlinkSync(p);
          stats.removed++; stats.abortedOauth++;
          log.info({ path: p, ageMs: Date.now() - mtime }, "removed aborted-OAuth artifact");
        } catch { /* ignore */ }
      }
    }

    // Pass 3 — collapse duplicate client_info per upstream URL. mcp-remote
    // normally derives one stable hash per URL but, on a dynamic-client-
    // registration retry, you can end up with two distinct hashes pointing
    // at the same `server_url` (this is the Tally loop bug). We keep the
    // hash with the most recently refreshed token and drop the others.
    try { entries = readdirSync(dir); } catch { continue; }
    const groups2 = groupByHash(entries);
    const byUrl = new Map<string, Array<{ hash: string; tokenMtime: number }>>();
    for (const [hash, files] of groups2.entries()) {
      const clientInfoName = `${hash}_client_info.json`;
      if (!files.includes(clientInfoName)) continue;
      let serverUrl = "";
      try {
        const ci = JSON.parse(readFileSync(join(dir, clientInfoName), "utf8")) as { server_url?: string };
        serverUrl = ci.server_url ?? "";
      } catch { /* ignore */ }
      if (!serverUrl) continue;
      let tokenMtime = 0;
      const tokensName = `${hash}_tokens.json`;
      if (files.includes(tokensName)) {
        try { tokenMtime = statSync(join(dir, tokensName)).mtimeMs; } catch { /* ignore */ }
      }
      const arr = byUrl.get(serverUrl) ?? [];
      arr.push({ hash, tokenMtime });
      byUrl.set(serverUrl, arr);
    }
    for (const [url, candidates] of byUrl.entries()) {
      if (candidates.length < 2) continue;
      // Keep the hash with the most recent token; if all have mtime 0
      // (no tokens at all anywhere — odd but possible), keep the first
      // one and drop the rest.
      candidates.sort((a, b) => b.tokenMtime - a.tokenMtime);
      const keep = candidates[0]!.hash;
      for (const c of candidates.slice(1)) {
        const drop = c.hash;
        const dropFiles = groups2.get(drop) ?? [];
        for (const name of dropFiles) {
          const p = join(dir, name);
          try {
            unlinkSync(p);
            stats.removed++; stats.duplicateClients++;
            log.info({ path: p, url, kept: keep, dropped: drop }, "removed duplicate mcp-remote client artifact");
          } catch { /* ignore */ }
        }
      }
    }
  }

  return stats;
}
