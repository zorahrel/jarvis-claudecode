import { promises as fs } from "fs";

/**
 * JSONL parsing helpers for Claude Code session transcripts.
 *
 * All functions are tail-only: they read at most `maxBytes` (default 256 KB)
 * from the end of the file. This keeps memory bounded even for multi-GB JSONLs.
 *
 * Used by:
 * - cruft.ts (extractToolUseEvents)
 * - diskHygiene.ts (sumTokens, countTurns, countCompactions)
 * - Plan 05 endpoints
 */

const DEFAULT_TAIL_BYTES = 256_000;

export interface ToolUseRecord {
  name: string;
  inputKeys: string[];
  turnIndex: number;
}

export interface TokenSummary {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
}

/**
 * Read the trailing `maxBytes` of a JSONL file and split into lines.
 * On any error returns []. Skips empty trailing lines.
 */
export async function readJsonlTailLines(
  path: string,
  maxBytes: number = DEFAULT_TAIL_BYTES,
): Promise<string[]> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(path, "r");
    const st = await fh.stat();
    const toRead = Math.min(st.size, maxBytes);
    const offset = Math.max(0, st.size - toRead);
    const buf = Buffer.alloc(toRead);
    await fh.read(buf, 0, toRead, offset);
    const text = buf.toString("utf8");
    return text.split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }
}

interface AnyAssistantMessage {
  type?: string;
  message?: {
    content?: Array<{
      type?: string;
      name?: string;
      input?: Record<string, unknown>;
      text?: string;
      id?: string;
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  isCompactSummary?: boolean;
}

function safeParse(line: string): AnyAssistantMessage | null {
  try {
    return JSON.parse(line) as AnyAssistantMessage;
  } catch {
    return null;
  }
}

/**
 * Walk JSONL tail and return tool_use records from the last `lastNTurns` assistant turns.
 * Each `assistant` line increments `turnIndex`. We keep only entries where
 * `turnIndex >= totalTurns - lastNTurns`.
 */
export async function extractToolUseEvents(
  path: string,
  lastNTurns: number = 5,
): Promise<ToolUseRecord[]> {
  const lines = await readJsonlTailLines(path);
  if (lines.length === 0) return [];

  const allEvents: ToolUseRecord[] = [];
  let turnIndex = -1;
  for (const line of lines) {
    const obj = safeParse(line);
    if (!obj) continue;
    if (obj.type === "assistant") {
      turnIndex++;
      const blocks = obj.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          allEvents.push({
            name: block.name,
            inputKeys: block.input ? Object.keys(block.input) : [],
            turnIndex,
          });
        }
      }
    }
  }

  const totalTurns = turnIndex + 1; // 0-indexed → count
  if (totalTurns <= 0) return [];
  const cutoff = Math.max(0, totalTurns - lastNTurns);
  return allEvents.filter((e) => e.turnIndex >= cutoff);
}

/** Count lines whose parsed JSON has `isCompactSummary === true`. */
export async function countCompactions(path: string): Promise<number> {
  const lines = await readJsonlTailLines(path, 1_000_000);
  let count = 0;
  for (const line of lines) {
    const obj = safeParse(line);
    if (obj?.isCompactSummary === true) count++;
  }
  return count;
}

/**
 * Sum token usage fields across all `assistant` lines in the tail.
 * Missing fields default to 0.
 */
export async function sumTokens(path: string): Promise<TokenSummary> {
  const lines = await readJsonlTailLines(path);
  let input = 0;
  let output = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  for (const line of lines) {
    const obj = safeParse(line);
    if (obj?.type === "assistant" && obj.message?.usage) {
      const u = obj.message.usage;
      input += u.input_tokens ?? 0;
      output += u.output_tokens ?? 0;
      cacheCreation += u.cache_creation_input_tokens ?? 0;
      cacheRead += u.cache_read_input_tokens ?? 0;
    }
  }
  return {
    input,
    output,
    cacheCreation,
    cacheRead,
    total: input + output + cacheCreation + cacheRead,
  };
}

/** Count assistant lines (one per turn, approximately). */
export async function countTurns(path: string): Promise<number> {
  const lines = await readJsonlTailLines(path);
  let count = 0;
  for (const line of lines) {
    const obj = safeParse(line);
    if (obj?.type === "assistant") count++;
  }
  return count;
}

// ─── Phase 2 (Plan 02-01) — orchestrator helpers ───────────────────────────
// These extend jsonlParser additively — Phase 1 callers (countTurns, sumTokens,
// extractToolUseEvents) are untouched. The helpers below feed refinedStatus
// derivation, suggestion engine, and the new /api/sessions/:pid/transcript
// endpoint. All are tail-only reads; no full-file scan even on multi-GB JSONLs.

/**
 * Walk the JSONL tail in reverse and return the last `assistant`-typed turn.
 * Returns null if no assistant turn is found (empty file, malformed-only, or
 * file lacks any assistant rows).
 *
 * Used by:
 *  - refinedStatus.ts (decide awaiting_user_input vs crashed via stop_reason)
 *  - snapshot.ts (last_assistant_summary projection — first text block)
 *  - dashboard/api.ts /api/sessions/:pid/transcript handler
 */
export async function extractLastAssistantTurn(transcriptPath: string): Promise<{
  stop_reason: string | null;
  content: Array<{
    type: string;
    text?: string;
    name?: string;
    id?: string;
    input?: unknown;
  }>;
  timestamp: string;
  uuid: string;
} | null> {
  const lines = await readJsonlTailLines(transcriptPath, 256_000);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]) as {
        type?: string;
        message?: {
          role?: string;
          content?: Array<{ type: string; text?: string; name?: string; id?: string; input?: unknown }>;
          stop_reason?: string | null;
        };
        timestamp?: string;
        uuid?: string;
      };
      if (obj.type === "assistant" && obj.message?.role === "assistant") {
        return {
          stop_reason: obj.message.stop_reason ?? null,
          content: obj.message.content ?? [],
          timestamp: obj.timestamp ?? "",
          uuid: obj.uuid ?? "",
        };
      }
    } catch {
      /* skip malformed line */
    }
  }
  return null;
}

/**
 * Walk the JSONL tail and return the set of `tool_use` blocks emitted by
 * `assistant` turns that do NOT yet have a matching `tool_result` block in a
 * subsequent `user` turn. A non-empty result means the session is in
 * "tool_pending" state — Claude is waiting for a tool result before continuing.
 *
 * Matching is by `tool_use.id` ↔ `tool_result.tool_use_id`. Order within the
 * tail does not matter; we collect all tool_uses then subtract matched ids.
 */
export async function extractPendingToolUses(transcriptPath: string): Promise<Array<{
  id: string;
  name: string;
  input: unknown;
}>> {
  const lines = await readJsonlTailLines(transcriptPath, 256_000);
  const toolUses = new Map<string, { id: string; name: string; input: unknown }>();
  const matchedIds = new Set<string>();
  for (const raw of lines) {
    try {
      const obj = JSON.parse(raw) as {
        type?: string;
        message?: {
          role?: string;
          content?: Array<{ type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string }>;
        };
      };
      // Collect tool_use blocks from assistant turns
      if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
        for (const block of obj.message!.content!) {
          if (block?.type === "tool_use" && typeof block.id === "string") {
            toolUses.set(block.id, {
              id: block.id,
              name: typeof block.name === "string" ? block.name : "",
              input: block.input ?? null,
            });
          }
        }
      }
      // Collect tool_result tool_use_ids from user turns
      if (obj.type === "user" && Array.isArray(obj.message?.content)) {
        for (const block of obj.message!.content!) {
          if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
            matchedIds.add(block.tool_use_id);
          }
        }
      }
    } catch {
      /* skip malformed line */
    }
  }
  return [...toolUses.values()].filter((tu) => !matchedIds.has(tu.id));
}

/**
 * Convenience wrapper around extractLastAssistantTurn that returns just the
 * stop_reason (or null when missing). Used by refinedStatus crashed-detection
 * — a transcript whose last assistant has stop_reason==null AND whose process
 * is gone from `ps` is "crashed".
 */
export async function getStopReason(transcriptPath: string): Promise<string | null> {
  const last = await extractLastAssistantTurn(transcriptPath);
  return last?.stop_reason ?? null;
}
