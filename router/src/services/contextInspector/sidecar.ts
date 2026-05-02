import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * PID-to-sessionKey linkage via per-process JSON sidecar files.
 *
 * Why sidecar (not env-var-via-ps): the router's spawn discipline already sets
 * `JARVIS_SPAWN=1` env on Claude SDK child processes, but parsing env from
 * `ps eww <pid>` is fragile (executable-name dependent, escaping varies).
 * A sidecar JSON keyed by PID gives discovery.ts a clean filesystem read
 * with no shell parsing — and survives across SDK process variants.
 *
 * Lifecycle:
 *  - claude.ts `registerSessionSidecars(s)` writes one file per discovered
 *    child PID after the first `task_progress` event (proves the process is
 *    alive and discoverable via `ps`).
 *  - claude.ts `unregisterSessionSidecars(sessionKey)` removes them in
 *    `killSession` to keep the directory clean.
 *  - discovery.ts `readSessionSidecar(pid)` looks up the sidecar to attach
 *    `sessionKey`/`agent`/`fullAccess`/`inheritUserScope` to each LocalSession.
 *
 * This is the MAJOR 5 fix from the plan-checker revision: without the sidecar,
 * router-spawned sessions could not be reliably correlated to their sessionKey,
 * which broke the whole live-token + cost-calc pipeline (CTX-04, CTX-15).
 */

/** Directory under which we stash one JSON per spawned Claude SDK process, keyed by PID. */
export const ACTIVE_SESSIONS_DIR = join(homedir(), ".claude", "jarvis", "active-sessions");

export interface SessionSidecar {
  pid: number;
  sessionKey: string;
  agent: string;
  workspace: string;
  model: string;
  resolvedModel?: string | null;
  fullAccess: boolean;
  inheritUserScope: boolean;
  spawnedAt: number;
}

async function ensureDir(): Promise<void> {
  try {
    await fs.mkdir(ACTIVE_SESSIONS_DIR, { recursive: true });
  } catch {
    /* readdir/write below will surface real errors */
  }
}

/** Write the sidecar file. Idempotent — overwrites if it exists. */
export async function writeSessionSidecar(s: SessionSidecar): Promise<void> {
  await ensureDir();
  const path = join(ACTIVE_SESSIONS_DIR, `${s.pid}.json`);
  await fs.writeFile(path, JSON.stringify(s), "utf-8");
}

/** Read sidecar by PID. Returns null on any error (missing file, malformed JSON). */
export async function readSessionSidecar(pid: number): Promise<SessionSidecar | null> {
  try {
    const raw = await fs.readFile(join(ACTIVE_SESSIONS_DIR, `${pid}.json`), "utf-8");
    return JSON.parse(raw) as SessionSidecar;
  } catch {
    return null;
  }
}

/** Remove sidecar by PID. Idempotent — silently ignores missing file. */
export async function removeSessionSidecar(pid: number): Promise<void> {
  try {
    await fs.unlink(join(ACTIVE_SESSIONS_DIR, `${pid}.json`));
  } catch {
    /* already gone — fine */
  }
}

/** List all active sidecars (for diagnostics + GC). Returns array of {pid, sidecar} pairs. */
export async function listSessionSidecars(): Promise<Array<{ pid: number; sidecar: SessionSidecar }>> {
  let entries: string[];
  try {
    entries = await fs.readdir(ACTIVE_SESSIONS_DIR);
  } catch {
    return [];
  }
  const results: Array<{ pid: number; sidecar: SessionSidecar }> = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const pid = parseInt(name.replace(/\.json$/, ""), 10);
    if (!Number.isFinite(pid)) continue;
    const sidecar = await readSessionSidecar(pid);
    if (sidecar) results.push({ pid, sidecar });
  }
  return results;
}
