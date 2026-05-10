import { discoverLocalSessions } from "../localSessions/discovery.js";
import {
  extractLastAssistantTurn,
  readJsonlTailLines,
} from "../contextInspector/jsonlParser.js";
import { refinedStatusFor } from "./refinedStatus.js";
import { suggestNext } from "./suggest.js";
import { detectConflict } from "./lock.js";
import { findPaneForPid, listAllPanes, type PaneRow } from "./tmuxMap.js";
import type { LocalSession } from "../localSessions/types.js";
import type {
  OrchestratorSnapshot,
  RefinedStatus,
  SnapshotEntry,
} from "./types.js";

// Transcript projection types — exported so the dashboard handler and
// the transcript spec share a single contract.
export interface TranscriptBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
}

export interface TranscriptTurn {
  role: "assistant" | "user";
  content: TranscriptBlock[];
  stop_reason: string | null;
  timestamp: string;
  uuid: string;
}

export interface TranscriptResponse {
  pid: number;
  turns: TranscriptTurn[];
}

/**
 * Read the JSONL tail and project to last-N {role, content, ...} turns.
 * Skips `attachment` and `last-prompt` rows. User content strings are
 * normalized to a single `{type:"text"}` block so the consumer always sees
 * an array.
 */
export async function buildTranscript(
  transcriptPath: string,
  pid: number,
  limit: number,
): Promise<TranscriptResponse> {
  const lines = await readJsonlTailLines(transcriptPath, 256_000);
  const turns: TranscriptTurn[] = [];
  for (const raw of lines) {
    try {
      const obj = JSON.parse(raw) as {
        type?: string;
        message?: {
          role?: "assistant" | "user";
          content?: unknown;
          stop_reason?: string | null;
        };
        timestamp?: string;
        uuid?: string;
      };
      if (obj.type !== "assistant" && obj.type !== "user") continue;
      const role = obj.message?.role;
      if (role !== "assistant" && role !== "user") continue;
      let content: TranscriptBlock[];
      if (typeof obj.message?.content === "string") {
        content = [{ type: "text", text: obj.message.content }];
      } else if (Array.isArray(obj.message?.content)) {
        content = obj.message!.content as TranscriptBlock[];
      } else {
        content = [];
      }
      turns.push({
        role,
        content,
        stop_reason: obj.message?.stop_reason ?? null,
        timestamp: obj.timestamp ?? "",
        uuid: obj.uuid ?? "",
      });
    } catch {
      /* skip malformed */
    }
  }
  const out = turns.slice(Math.max(0, turns.length - limit));
  return { pid, turns: out };
}

/**
 * Phase 2 Plan 02-01 — orchestrator snapshot composer.
 * Plan 02-04 enriches the composer with tmux pid→pane info.
 *
 * Two functions:
 *  1. `composeSnapshot` (PURE) — synchronous, takes pre-fetched inputs
 *     including a `tmuxByPid` map. Easy to unit-test without tmpdirs or
 *     env mocking.
 *  2. `buildSnapshot` (ASYNC) — fetches all inputs (discoverLocalSessions
 *     + refinedStatusFor + extractLastAssistantTurn + detectConflict +
 *     getTmuxPanesOnce + findPaneForPid for parent-walking) then delegates
 *     to composeSnapshot.
 *
 * `todo_link` still emitted as null — that's Plan 02-02's job at write time
 * (it's populated by enriching with Reminders metadata if a snapshot consumer
 * needs it).
 */

/**
 * (W4 FIX) Build a pid → paneInfo map ONCE per snapshot invocation.
 *
 * `findPaneForPid` normally shells out to `tmux list-panes` per call. At a 5s
 * polling cadence with N sessions, that's N tmux exec calls every 5s. Here we
 * shell out exactly once and reuse the cache for every pane lookup in this
 * snapshot — same trick `refinedStatusFor` uses with its 2s cache.
 *
 * Returns an empty Map on tmux failure (no tmux running, exec error). Bare
 * Terminal.app sessions live in this codepath as null tmux info — that's the
 * locked CONTEXT.md decision.
 */
async function getTmuxPanesOnce(): Promise<Map<number, { session: string; pane: string }>> {
  const out = new Map<number, { session: string; pane: string }>();
  try {
    const rows: PaneRow[] = await listAllPanes();
    for (const r of rows) out.set(r.pid, { session: r.session, pane: r.pane });
  } catch {
    /* tmux not running — degraded path is fine. */
  }
  return out;
}

export function composeSnapshot(
  sessions: LocalSession[],
  statusMap: Map<number, RefinedStatus>,
  lastByPid: Map<number, string | null>,
  conflictMap: Map<number, number | null>,
  tmuxByPid?: Map<number, { session: string; pane: string } | null>,
): OrchestratorSnapshot {
  const entries: SnapshotEntry[] = sessions.map((s) => {
    const status = statusMap.get(s.pid) ?? "idle";
    const lastSummary = lastByPid.get(s.pid) ?? null;
    const sug = suggestNext({ refinedStatus: status, lastAssistantSummary: lastSummary });
    return {
      pid: s.pid,
      repo: s.repoName ?? "",
      branch: s.branch ?? null,
      cwd: s.cwd,
      status,
      last_assistant_summary: lastSummary,
      suggestion: sug.text,
      action: sug.action,
      confidence: sug.confidence,
      todo_link: null, // populated by Plan 02-02 at consumer-side enrichment time
      tmux: tmuxByPid?.get(s.pid) ?? null,
      conflict: conflictMap.get(s.pid) ?? null,
    };
  });
  return { generated_at: new Date().toISOString(), sessions: entries };
}

export async function buildSnapshot(): Promise<OrchestratorSnapshot> {
  const sessions = await discoverLocalSessions();
  const statusMap = await refinedStatusFor(sessions);

  const lastByPid = new Map<number, string | null>();
  for (const s of sessions) {
    if (!s.transcriptPath) {
      lastByPid.set(s.pid, null);
      continue;
    }
    const last = await extractLastAssistantTurn(s.transcriptPath).catch(() => null);
    const summary = last?.content
      ?.find((b: { type: string; text?: string }) => b.type === "text")
      ?.text?.slice(0, 200) ?? null;
    lastByPid.set(s.pid, summary);
  }

  // Build conflict map: for each session, find another session whose cwd conflicts.
  const conflictMap = new Map<number, number | null>();
  for (let i = 0; i < sessions.length; i++) {
    let conflictPid: number | null = null;
    for (let j = 0; j < sessions.length; j++) {
      if (i === j) continue;
      if (await detectConflict(sessions[i].cwd, sessions[j].cwd)) {
        conflictPid = sessions[j].pid;
        break;
      }
    }
    conflictMap.set(sessions[i].pid, conflictPid);
  }

  // (W4 FIX) tmux enrichment — single shell-out for the whole snapshot.
  const tmuxCache = await getTmuxPanesOnce();
  const tmuxByPid = new Map<number, { session: string; pane: string } | null>();
  for (const s of sessions) {
    // Direct hit first; otherwise walk parents (still cheap — only `ps -o
    // ppid=` shell-outs, no further tmux calls thanks to the cache pass).
    const direct = tmuxCache.get(s.pid);
    if (direct) {
      tmuxByPid.set(s.pid, direct);
      continue;
    }
    const walked = await findPaneForPid(s.pid, undefined, tmuxCache).catch(() => null);
    tmuxByPid.set(s.pid, walked);
  }

  return composeSnapshot(sessions, statusMap, lastByPid, conflictMap, tmuxByPid);
}
