/**
 * mcp-remote orphan-lock janitor.
 *
 * `mcp-remote` (the OAuth wrapper for remote MCPs like zenda/tally/vercel)
 * coordinates between concurrent instances via lock files at
 * `~/.mcp-auth/mcp-remote-<ver>/<hash>_lock.json` containing `{ pid, port,
 * timestamp }`. The first instance binds an OAuth callback port; subsequent
 * instances reuse that port via the lock.
 *
 * Problem: when the holder process dies (router restart, kill), the lock
 * stays on disk. The next mcp-remote instance reads the orphan lock,
 * tries to reach the dead port → fails → opens a fresh OAuth dialog.
 * With multiple sessions doing this in parallel, the user gets a flurry
 * of unsolicited browser tabs even though the *token* is valid.
 *
 * This module finds orphan locks (pid not running) at boot and deletes them.
 * Cheap, idempotent, completely safe — at worst a live mcp-remote re-creates
 * its lock on the next request.
 */

import { readdirSync, readFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { logger } from "./logger";

const log = logger.child({ module: "mcp-auth-cleanup" });

const HOME = process.env.HOME ?? "";
const AUTH_ROOT = join(HOME, ".mcp-auth");

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but we can't signal (different user); EXIST'S = ESRCH = dead.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function cleanupOrphanMcpLocks(): { scanned: number; removed: number } {
  let scanned = 0;
  let removed = 0;
  if (!existsSync(AUTH_ROOT)) return { scanned, removed };
  let versionDirs: string[] = [];
  try {
    versionDirs = readdirSync(AUTH_ROOT)
      .filter(n => n.startsWith("mcp-remote-"))
      .map(n => join(AUTH_ROOT, n));
  } catch (err) {
    log.warn({ err: String(err) }, "couldn't enumerate ~/.mcp-auth");
    return { scanned, removed };
  }
  for (const dir of versionDirs) {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith("_lock.json")) continue;
      const lockPath = join(dir, name);
      scanned++;
      try {
        const raw = readFileSync(lockPath, "utf8");
        const parsed = JSON.parse(raw) as { pid?: number; port?: number };
        const pid = parsed.pid ?? 0;
        if (!isProcessAlive(pid)) {
          unlinkSync(lockPath);
          removed++;
          log.info({ lockPath, deadPid: pid }, "removed orphan mcp-remote lock");
        }
      } catch (err) {
        // Corrupt lock file — also worth removing.
        try {
          unlinkSync(lockPath);
          removed++;
          log.warn({ lockPath, err: String(err) }, "removed unreadable mcp-remote lock");
        } catch { /* ignore */ }
      }
    }
  }
  return { scanned, removed };
}
