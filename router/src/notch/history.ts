import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";
import { logger } from "../services/logger";

const log = logger.child({ module: "notch-history" });

/**
 * Persistent chat log for the Notch surfaces. JSONL so appends are O(1) and
 * crash-safe (no half-written JSON object can poison the file — at worst the
 * last line is truncated and silently skipped on read). Rotated after a soft
 * cap so the file can't grow without bound between sessions.
 */
export type NotchHistoryRole = "user" | "agent";

export interface NotchHistoryRecord {
  id: string;
  ts: number;
  role: NotchHistoryRole;
  from?: string;
  text: string;
}

const HISTORY_DIR = join(homedir(), ".claude/jarvis/state");
const HISTORY_FILE = join(HISTORY_DIR, "notch-history.jsonl");
const HISTORY_ROTATED = `${HISTORY_FILE}.1`;
const ROTATE_AFTER_LINES = 2000;

let ensured = false;
async function ensureDir(): Promise<void> {
  if (ensured) return;
  try {
    await fs.mkdir(HISTORY_DIR, { recursive: true });
    ensured = true;
  } catch (err) {
    log.warn({ err }, "Failed to create notch history directory");
  }
}

function makeId(): string {
  return `nh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Append a record. Swallows IO errors (history is advisory, never fatal). */
export async function appendHistory(
  record: Omit<NotchHistoryRecord, "id"> & { id?: string },
): Promise<void> {
  await ensureDir();
  const full: NotchHistoryRecord = {
    id: record.id ?? makeId(),
    ts: record.ts ?? Date.now(),
    role: record.role,
    from: record.from,
    text: record.text,
  };
  try {
    await fs.appendFile(HISTORY_FILE, `${JSON.stringify(full)}\n`, "utf-8");
  } catch (err) {
    log.warn({ err }, "append failed");
    return;
  }
  // Opportunistic rotation — check after each append. Read+count is cheap at
  // 2k lines; we bail early when the file is clearly under the cap.
  try {
    const stat = await fs.stat(HISTORY_FILE);
    if (stat.size < ROTATE_AFTER_LINES * 80) return;
    const body = await fs.readFile(HISTORY_FILE, "utf-8");
    const lines = body.split("\n").filter(Boolean);
    if (lines.length <= ROTATE_AFTER_LINES) return;
    await fs.rm(HISTORY_ROTATED, { force: true }).catch(() => {});
    await fs.rename(HISTORY_FILE, HISTORY_ROTATED);
    await fs.writeFile(HISTORY_FILE, "", "utf-8");
  } catch (err) {
    log.warn({ err }, "rotate failed");
  }
}

/** Return the last `limit` records (oldest → newest). */
export async function readHistory(limit = 100): Promise<NotchHistoryRecord[]> {
  await ensureDir();
  let body: string;
  try {
    body = await fs.readFile(HISTORY_FILE, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    log.warn({ err }, "read failed");
    return [];
  }
  const lines = body.split("\n").filter(Boolean);
  const tail = limit > 0 ? lines.slice(-limit) : lines;
  const out: NotchHistoryRecord[] = [];
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line) as NotchHistoryRecord;
      if (parsed && typeof parsed.text === "string" && (parsed.role === "user" || parsed.role === "agent")) {
        out.push(parsed);
      }
    } catch { /* skip malformed */ }
  }
  return out;
}

/** Wipe current history (keeps rotated file as audit trail). */
export async function clearHistory(): Promise<void> {
  await ensureDir();
  try {
    await fs.writeFile(HISTORY_FILE, "", "utf-8");
  } catch (err) {
    log.warn({ err }, "clear failed");
  }
}
