/**
 * Append-only audit log for permission-mutating dashboard actions.
 *
 * One JSONL line per event at `~/.claude/jarvis/router/data/audit.jsonl`.
 * Format is intentionally flat and stable so future tooling (CLI grep,
 * dashboard timeline view, off-host shipping) can parse it without
 * schema knowledge:
 *
 *   {
 *     "ts": "2026-05-10T19:30:00.000Z",
 *     "event": "agent.tools.patched",
 *     "actor": "dashboard",
 *     "agent": "cecilia",
 *     "diff": { "added": ["mcp:tally"], "removed": [] },
 *     "after": ["vision", "whatsapp", "mcp:tally"],
 *     "killedSessions": 1
 *   }
 *
 * Writes are best-effort: a failed append never breaks the originating
 * dashboard request. The file is opened append-only and small (one line
 * per change); rotation is the caller's problem (logrotate, etc.).
 */

import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { logger } from "./logger";

const log = logger.child({ module: "audit-log" });

const HOME = process.env.HOME ?? "";
const AUDIT_PATH = join(HOME, ".claude/jarvis/router/data/audit.jsonl");

export type AuditEvent =
  | "agent.config.updated"
  | "agent.tools.patched"
  | "agent.channel-scope.patched"
  | "agent.file.saved"
  | "agent.created"
  | "agent.deleted"
  | "mcp.authenticate"
  | "mcp.approve-pending"
  | "mcp.disconnect"
  | "mcp.restart"
  | "config.yaml.saved";

export interface AuditEntry {
  event: AuditEvent;
  /** Who triggered the change. "dashboard" today; in future "telegram:<chatId>", "cron:<name>", etc. */
  actor: string;
  /** Target agent (when applicable). */
  agent?: string;
  /** Tool / MCP server / file path involved (when applicable). */
  target?: string;
  /** Compact diff for tool/scope mutations. */
  diff?: {
    added?: string[];
    removed?: string[];
    before?: unknown;
    after?: unknown;
  };
  /** How many live sessions were killed as a side effect. */
  killedSessions?: number;
  /** Free-form details for debugging / display. */
  details?: Record<string, unknown>;
  /** Result. Default "ok". */
  result?: "ok" | "denied" | "error";
  /** When result is non-ok, why. */
  reason?: string;
}

/**
 * Append a single audit event. Best-effort: errors are logged at debug
 * level and swallowed so a broken filesystem doesn't break the request
 * that triggered the audit.
 */
export function audit(entry: AuditEntry): void {
  const line = {
    ts: new Date().toISOString(),
    ...entry,
    result: entry.result ?? "ok",
  };
  try {
    const dir = dirname(AUDIT_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(AUDIT_PATH, JSON.stringify(line) + "\n", "utf-8");
  } catch (err) {
    log.debug({ err: String(err), entry }, "audit append failed (best-effort)");
  }
}

/**
 * Helper: diff two arrays into {added, removed}. Order-independent.
 */
export function arrayDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((x) => !beforeSet.has(x));
  const removed = before.filter((x) => !afterSet.has(x));
  return { added, removed };
}

export const AUDIT_LOG_PATH = AUDIT_PATH;
