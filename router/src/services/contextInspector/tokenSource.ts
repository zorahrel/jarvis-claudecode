import { promises as fs } from "fs";
import type { SdkSessionLike, LiveTokenSnapshot, TurnUsage, PricedModel } from "./types.js";
import { CONTEXT_WINDOWS } from "./types.js";

/** In-memory store of the most recent task_progress.usage.total_tokens per sessionKey. Updated by claude.ts (Plan 05 wires it in). */
const liveProgressMap = new Map<string, { totalTokens: number; capturedAt: number; lastTurnUsage: TurnUsage | null }>();

/**
 * Record a task_progress event for a session.
 * Called from claude.ts SDK consumer loop (wired in Plan 05) on every `system/task_progress` event.
 *
 * Merge semantics:
 *   - totalTokens: ALWAYS overwritten (latest signal wins)
 *   - lastTurnUsage: only overwritten if `lastTurnUsage` arg is non-null (preserves prior result-event data)
 */
export function recordTaskProgress(
  sessionKey: string,
  totalTokens: number,
  lastTurnUsage: TurnUsage | null = null,
): void {
  const prev = liveProgressMap.get(sessionKey);
  liveProgressMap.set(sessionKey, {
    totalTokens,
    capturedAt: Date.now(),
    lastTurnUsage: lastTurnUsage ?? prev?.lastTurnUsage ?? null,
  });
}

/**
 * Record the per-turn `usage` from a SDK `result` event.
 * Preserves the most recent `totalTokens` from task_progress, only updating lastTurnUsage.
 * If no prior task_progress was observed, totalTokens is computed from the result usage sum.
 *
 * Called from claude.ts SDK consumer loop (wired in Plan 05) on every `result` event.
 */
export function recordTurnResult(sessionKey: string, usage: TurnUsage): void {
  const prev = liveProgressMap.get(sessionKey);
  const sumFromUsage =
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens;
  liveProgressMap.set(sessionKey, {
    totalTokens: prev?.totalTokens ?? sumFromUsage,
    capturedAt: Date.now(),
    lastTurnUsage: usage,
  });
}

/** Clear progress for a session (on close / kill). */
export function clearTaskProgress(sessionKey: string): void {
  liveProgressMap.delete(sessionKey);
}

/** Test-only: clear the entire map. */
export function _resetForTests(): void {
  liveProgressMap.clear();
}

/**
 * Get the live token snapshot for a router-spawned session.
 * Priority: task_progress.usage.total_tokens > sum(lastTurnUsage) > totalInputTokens fallback.
 */
export function getLiveTokensFromSdk(session: SdkSessionLike, lastTurnUsage: TurnUsage | null = null): LiveTokenSnapshot {
  const model = normalizeModel(session.resolvedModel);
  const contextWindow = CONTEXT_WINDOWS[model];
  const progress = liveProgressMap.get(session.sessionKey);
  if (progress) {
    return {
      totalTokens: progress.totalTokens,
      source: "sdk-task-progress",
      capturedAt: progress.capturedAt,
      contextWindow,
      lastTurnUsage: progress.lastTurnUsage ?? lastTurnUsage,
    };
  }
  if (lastTurnUsage) {
    const total =
      lastTurnUsage.input_tokens +
      lastTurnUsage.output_tokens +
      lastTurnUsage.cache_creation_input_tokens +
      lastTurnUsage.cache_read_input_tokens;
    return {
      totalTokens: total,
      source: "sdk-result",
      capturedAt: Date.now(),
      contextWindow,
      lastTurnUsage,
    };
  }
  return {
    totalTokens: session.totalInputTokens || 0,
    source: "unknown",
    capturedAt: Date.now(),
    contextWindow,
    lastTurnUsage: null,
  };
}

/**
 * Read the last assistant.usage from a JSONL transcript. Tail-only read (max 64 KB).
 * Returns null if the file is missing, empty, or has no valid assistant.usage line in the tail.
 */
export async function getLiveTokensFromJsonl(transcriptPath: string, model: string | null = null): Promise<LiveTokenSnapshot | null> {
  let lines: string[];
  try {
    const fh = await fs.open(transcriptPath, "r");
    try {
      const st = await fh.stat();
      const start = Math.max(0, st.size - 64_000);
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      lines = buf.toString("utf-8").split("\n").filter((l) => l.trim());
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
  if (lines.length === 0) return null;
  // Walk backwards looking for the most recent assistant message with .message.usage
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]) as { type?: string; message?: { role?: string; model?: string; usage?: TurnUsage } };
      if (e.type === "assistant" && e.message?.usage) {
        const u = e.message.usage;
        const totalTokens =
          (u.input_tokens ?? 0) +
          (u.output_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0);
        const m = normalizeModel(model ?? e.message?.model ?? null);
        return {
          totalTokens,
          source: "jsonl-tail",
          capturedAt: Date.now(),
          contextWindow: CONTEXT_WINDOWS[m],
          lastTurnUsage: {
            input_tokens: u.input_tokens ?? 0,
            output_tokens: u.output_tokens ?? 0,
            cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          },
        };
      }
    } catch {
      /* skip malformed line, keep walking back */
    }
  }
  return null;
}

/** Map any model id (with version suffix or alias) to one of the three priced models. Defaults to sonnet. */
export function normalizeModel(model: string | null): PricedModel {
  if (!model) return "sonnet";
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("haiku")) return "haiku";
  return "sonnet";
}
