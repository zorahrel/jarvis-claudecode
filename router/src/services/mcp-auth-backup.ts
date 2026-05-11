/**
 * MCP Auth State Backup — daily snapshot of OAuth token stores.
 *
 * Why:
 *   - `~/.mcp-auth/mcp-remote-*` stores tokens for stdio + npx mcp-remote MCPs.
 *     If the version directory bumps (npm pulls a new mcp-remote) the OLD
 *     tokens look "lost" until you locate the previous version dir.
 *   - `~/.claude/mcp-needs-auth-cache.json` (Claude Code's native auth store
 *     for type:http MCPs). If this file gets corrupted / cleared by an
 *     uninstall+reinstall, all type:http MCPs revert to needs-auth.
 *   - macOS upgrades sometimes clear keychain entries or TCC permissions.
 *
 * What we do:
 *   - Daily snapshot of both directories/files into
 *     `~/.claude/jarvis/backups/auth/YYYY-MM-DD/`
 *   - Keep the last 30 days; older snapshots are pruned.
 *
 * What we DON'T do:
 *   - We don't decrypt or read token contents — pure file-level copy.
 *   - We don't restore automatically — restore is a manual `cp -R` after
 *     reading from the backup directory. Future v3.2: dashboard `Restore` button.
 */

import { promises as fs } from "fs";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

import { logger } from "./logger";

const log = logger.child({ module: "mcp-auth-backup" });

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const KEEP_DAYS = 30;
/** First backup runs this long after boot. Lets the router stabilize. */
const INITIAL_DELAY_MS = 5 * 60 * 1000;

let intervalHandle: NodeJS.Timeout | null = null;
let initialHandle: NodeJS.Timeout | null = null;

interface Source {
  src: string;
  dst: string; // relative to the day's backup dir
}

function buildSources(): Source[] {
  const home = homedir();
  return [
    { src: join(home, ".mcp-auth"), dst: "mcp-auth" },
    { src: join(home, ".claude", "mcp-needs-auth-cache.json"), dst: "mcp-needs-auth-cache.json" },
    { src: join(home, ".claude", ".credentials.json"), dst: "claude-credentials.json" },
  ];
}

async function copyDirRecursive(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const sFull = join(src, entry.name);
    const dFull = join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(sFull, dFull);
    } else if (entry.isFile()) {
      await fs.copyFile(sFull, dFull);
    }
    // skip symlinks/sockets/etc — we don't need them
  }
}

async function snapshotAuthState(): Promise<void> {
  const home = homedir();
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const targetDir = join(home, ".claude", "jarvis", "backups", "auth", date);
  await fs.mkdir(targetDir, { recursive: true });

  let copied = 0;
  for (const { src, dst } of buildSources()) {
    if (!existsSync(src)) continue;
    const stat = await fs.stat(src);
    const dstFull = join(targetDir, dst);
    try {
      if (stat.isDirectory()) {
        await copyDirRecursive(src, dstFull);
      } else if (stat.isFile()) {
        await fs.copyFile(src, dstFull);
      }
      copied++;
    } catch (err) {
      log.warn({ err, src }, "[mcp-auth-backup] copy failed for source — continuing");
    }
  }
  log.info({ date, copied, targetDir }, "[mcp-auth-backup] snapshot complete");
}

async function rotateOldBackups(): Promise<void> {
  const home = homedir();
  const backupRoot = join(home, ".claude", "jarvis", "backups", "auth");
  if (!existsSync(backupRoot)) return;

  const cutoffMs = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const entries = await fs.readdir(backupRoot, { withFileTypes: true });

  let purged = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(backupRoot, entry.name);
    try {
      const stat = await fs.stat(dirPath);
      if (stat.mtimeMs < cutoffMs) {
        await fs.rm(dirPath, { recursive: true, force: true });
        purged++;
      }
    } catch (err) {
      log.warn({ err, dirPath }, "[mcp-auth-backup] rotation failed for entry — continuing");
    }
  }
  if (purged > 0) {
    log.info({ purged, keepDays: KEEP_DAYS }, "[mcp-auth-backup] rotation complete");
  }
}

async function tick(): Promise<void> {
  try {
    await snapshotAuthState();
    await rotateOldBackups();
  } catch (err) {
    log.error({ err }, "[mcp-auth-backup] tick failed");
  }
}

/** Start the daily backup. Safe to call multiple times — idempotent. */
export function startMcpAuthBackup(): void {
  if (intervalHandle) return;
  log.info({ intervalMs: BACKUP_INTERVAL_MS, keepDays: KEEP_DAYS, initialDelayMs: INITIAL_DELAY_MS }, "MCP Auth Backup starting");
  initialHandle = setTimeout(tick, INITIAL_DELAY_MS);
  intervalHandle = setInterval(tick, BACKUP_INTERVAL_MS);
}

export function stopMcpAuthBackup(): void {
  if (initialHandle) {
    clearTimeout(initialHandle);
    initialHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
