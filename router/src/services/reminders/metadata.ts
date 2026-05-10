/**
 * Reminders metadata parser/formatter — Phase 2 Plan 02-02 (ORC-08).
 *
 * Each Jarvis-managed Reminder ends its body with the canonical line
 * `pid:NNNN repo:<name> phase:<plan|exec|review>`. This module is the
 * bidirectional bridge: parseTodoMetadata extracts, formatTodoMetadata
 * rebuilds. Round-trip parity is required so user prose survives our
 * write-backs.
 *
 * Locked schema (CONTEXT.md `<decisions>` + RESEARCH.md lines 460-475):
 *   - Position: LAST line of the notes blob, separated from prose by `\n\n`
 *   - Format:   pid:<digits> repo:<word> phase:<plan|exec|review>
 *   - Regex:    /^pid:(\d+)\s+repo:([^\s]+)\s+phase:(plan|exec|review)\s*$/m
 */

import type { TodoMetadata, TodoPhase } from "./types.js";

const META_LINE = /^pid:(\d+)\s+repo:([^\s]+)\s+phase:(plan|exec|review)\s*$/m;

/**
 * Extract pid/repo/phase from a notes blob.
 *
 * Returns `{}` for null/undefined/empty input or if no metadata line is
 * present — never throws. Callers should distinguish "untracked todo"
 * (returned `{}`) from "tracked but unparseable" (which we treat as `{}`
 * so the bridge stays resilient to user-edited notes).
 */
export function parseTodoMetadata(notes: string | null | undefined): TodoMetadata {
  if (!notes) return {};
  const m = notes.match(META_LINE);
  if (!m) return {};
  return {
    pid: parseInt(m[1], 10),
    repo: m[2],
    phase: m[3] as TodoPhase,
  };
}

/**
 * Build the canonical metadata line. Caller is responsible for prepending
 * user prose + `\n\n` if any (see cli.ts addTodo).
 */
export function formatTodoMetadata(meta: { pid: number; repo: string; phase: TodoPhase }): string {
  return `pid:${meta.pid} repo:${meta.repo} phase:${meta.phase}`;
}
