/**
 * Phase 2 Plan 02-04 — orchestrator inject audit log (ORC-17).
 *
 * Append-only JSONL at `~/.claude/jarvis/orchestrator/audit.jsonl` (default)
 * or `$JARVIS_AUDIT_DIR/audit.jsonl` (test override).
 *
 * Single-writer mutex: serialize concurrent `appendAudit` calls via a
 * Promise queue so two simultaneous injects don't interleave bytes mid-line
 * or both detect "size > 10 MB" and double-rotate (RESEARCH.md Pitfall 7).
 *
 * Rotation: when the file exceeds 10 MB, rename to `audit.jsonl.<ts>` and
 * start a fresh file. No external rotator dependency — stdlib only.
 *
 * Why dynamic dir lookup: the AUDIT_DIR/AUDIT_FILE_PATH constants are
 * evaluated at module load. Tests set `JARVIS_AUDIT_DIR` per-test, so the
 * write path must re-read the env var on each call — `getAuditDir()` does
 * that.
 */
import { promises as fs } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AuditEntry } from "./types.js";

function getAuditDir(): string {
  return process.env.JARVIS_AUDIT_DIR ?? join(homedir(), ".claude", "jarvis", "orchestrator");
}

/** Module-load resolution — kept for back-compat exports. Runtime uses getAuditDir(). */
export const AUDIT_DIR = getAuditDir();
export const AUDIT_FILE_PATH = join(getAuditDir(), "audit.jsonl");
export const ROTATE_BYTES = 10 * 1024 * 1024;

/** Single-writer queue. Each appendAudit chains onto this Promise. */
let writeQueue: Promise<void> = Promise.resolve();

export function appendAudit(entry: AuditEntry): Promise<void> {
  writeQueue = writeQueue
    .then(async () => {
      const dir = getAuditDir();
      const path = join(dir, "audit.jsonl");
      await fs.mkdir(dir, { recursive: true });
      try {
        const st = await fs.stat(path);
        if (st.size > ROTATE_BYTES) {
          const archive = `${path}.${Date.now()}`;
          await fs.rename(path, archive);
        }
      } catch {
        /* file doesn't exist yet — fine, the appendFile below will create it. */
      }
      await fs.appendFile(path, JSON.stringify(entry) + "\n", "utf8");
    })
    .catch(() => undefined);
  return writeQueue;
}
