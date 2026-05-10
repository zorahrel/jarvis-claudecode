import { promises as fs } from "fs";
import {
  extractLastAssistantTurn,
  extractPendingToolUses,
} from "../contextInspector/jsonlParser.js";
import type { LocalSession } from "../localSessions/types.js";
import type { RefinedStatus } from "./types.js";

/**
 * Phase 2 Plan 02-01 — refinedStatus 5-state derivation (ORC-02).
 *
 * Decision rules (locked in CONTEXT.md `<specifics>`):
 *  - tool_pending: extractPendingToolUses returns non-empty
 *  - crashed: opts.pidAlive===false AND last assistant has no stop_reason
 *  - awaiting_user_input: last assistant stop_reason==="end_turn"
 *      AND mtime age >= 30000ms
 *  - working: last write age < 30000ms (and not tool_pending)
 *  - idle: pid in ps but no recent JSONL append (>30s) and no end_turn
 *
 * `refinedStatusFor` batches over a session list with a 2s in-process cache,
 * mirroring localSessions/discovery.ts CACHE_TTL_MS pattern.
 */

const IDLE_THRESHOLD_MS = 30_000;
const CACHE_TTL_MS = 2000;

let cache: { at: number; statuses: Map<number, RefinedStatus> } | null = null;

export async function deriveRefinedStatus(
  s: LocalSession,
  opts?: { pidAlive?: boolean },
): Promise<RefinedStatus> {
  if (!s.transcriptPath) return "idle";
  const last = await extractLastAssistantTurn(s.transcriptPath);
  const pending = await extractPendingToolUses(s.transcriptPath);
  if (pending.length > 0) return "tool_pending";
  // crashed: pid not alive AND last assistant has no stop_reason
  if (opts?.pidAlive === false && last && last.stop_reason == null) return "crashed";
  const stat = await fs.stat(s.transcriptPath).catch(() => null);
  const lastWriteAge = stat ? Date.now() - stat.mtimeMs : Infinity;
  if (last && last.stop_reason === "end_turn" && lastWriteAge >= IDLE_THRESHOLD_MS) {
    return "awaiting_user_input";
  }
  if (lastWriteAge < IDLE_THRESHOLD_MS) return "working";
  return "idle";
}

export async function refinedStatusFor(
  sessions: LocalSession[],
): Promise<Map<number, RefinedStatus>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.statuses;
  const out = new Map<number, RefinedStatus>();
  const pairs = await Promise.all(
    sessions.map(async (s) => [s.pid, await deriveRefinedStatus(s)] as const),
  );
  for (const [pid, st] of pairs) out.set(pid, st);
  cache = { at: Date.now(), statuses: out };
  return out;
}

/** Test helper: reset the in-module cache. */
export function _resetCacheForTests(): void {
  cache = null;
}
