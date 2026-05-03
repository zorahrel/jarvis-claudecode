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
