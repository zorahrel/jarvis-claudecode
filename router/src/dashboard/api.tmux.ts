/**
 * tmux mapping + inject API handlers — Phase 2 Plan 02-04 (ORC-15, ORC-16).
 *
 * Why a separate module from `api.ts`: same reason as Plan 02-01's
 * buildTranscript and Plan 02-02's api.todos.ts. Importing `handleApi`
 * transitively pulls in baileys + cron + ws and hangs the test runner.
 * Pure handler helpers + injectable deps = fast, hermetic specs.
 *
 * The thin wrappers in api.ts wire these to discoverLocalSessions /
 * findPaneForPid / sendKeys / capturePane / appendAudit / detectConflict.
 */

import type { LocalSession } from "../services/localSessions/types.js";
import type { AuditEntry } from "../services/orchestrator/types.js";

/** Result envelope shared with Plan 02-02 conventions. */
export type HandlerResult<T = unknown> = { status: number; body: T };

/** Injectable surface — production wires real services; tests inject stubs. */
export interface TmuxDeps {
  /** Snapshot of all known local sessions (for pid existence + cwd lookup). */
  discoverSessions: () => Promise<LocalSession[]>;
  /** Walk pid → pane chain (cached call inside the request). */
  findPane: (pid: number) => Promise<{ session: string; pane: string } | null>;
  /** tmux send-keys via execFile arg-array. */
  sendKeys: (paneId: string, text: string) => Promise<void>;
  /** Optional echo capture (debug aid; failures must not block inject). */
  capturePane: (paneId: string, lines: number) => Promise<string>;
  /** cwd lock conflict detector — same realpath/git-root rules as Plan 02-01. */
  detectConflict: (a: string, b: string) => Promise<boolean>;
  /** Append-only audit JSONL writer with single-writer mutex + 10MB rotation. */
  appendAudit: (entry: AuditEntry) => Promise<void>;
}

/**
 * GET /api/sessions/:pid/tmux — returns has_tmux + session_name + pane_id.
 *
 * 200 always (degraded path returns has_tmux:false). 400 on invalid pid.
 */
export async function handleTmuxLookup(
  deps: Pick<TmuxDeps, "findPane">,
  pid: number,
): Promise<HandlerResult<{ has_tmux: boolean; session_name?: string; pane_id?: string } | { error: string }>> {
  if (!Number.isFinite(pid) || pid <= 0) {
    return { status: 400, body: { error: "invalid_pid" } };
  }
  const result = await deps.findPane(pid);
  if (!result) return { status: 200, body: { has_tmux: false } };
  return {
    status: 200,
    body: { has_tmux: true, session_name: result.session, pane_id: result.pane },
  };
}

/**
 * POST /api/sessions/:pid/inject — body: {text, source, confidence?, reason?, force?}.
 *
 * Status semantics (locked in plan interfaces):
 *  - 200 → ok:true with paneId + auditTs
 *  - 400 → invalid_pid | text_required | invalid_source
 *  - 404 → session_not_found | pane_lost (pane disappeared between resolve+send)
 *  - 409 → no_tmux | lock_conflict (with conflictPid; force=true bypasses)
 *  - 500 → inject_failed (unexpected — audit not written)
 */
export async function handleInject(
  deps: TmuxDeps,
  pid: number,
  body: unknown,
): Promise<HandlerResult> {
  if (!Number.isFinite(pid) || pid <= 0) {
    return { status: 400, body: { error: "invalid_pid" } };
  }
  const b = (body ?? {}) as {
    text?: unknown;
    source?: unknown;
    confidence?: unknown;
    reason?: unknown;
    force?: unknown;
  };
  if (typeof b.text !== "string" || b.text.length === 0) {
    return { status: 400, body: { error: "text_required" } };
  }
  if (b.source !== "user-approved" && b.source !== "auto" && b.source !== "skill") {
    return { status: 400, body: { error: "invalid_source" } };
  }
  const text = b.text;
  const source = b.source as "user-approved" | "auto" | "skill";
  const force = b.force === true;
  const confidence = b.confidence === "low" || b.confidence === "medium" || b.confidence === "high"
    ? (b.confidence as "low" | "medium" | "high")
    : undefined;
  const reason = typeof b.reason === "string" ? b.reason : undefined;

  // Verify the session exists.
  const sessions = await deps.discoverSessions();
  const me = sessions.find((s) => s.pid === pid);
  if (!me) return { status: 404, body: { error: "session_not_found" } };

  // Lock-conflict check (skipped when force=true).
  if (!force) {
    for (const other of sessions) {
      if (other.pid === pid) continue;
      if (await deps.detectConflict(me.cwd, other.cwd)) {
        return {
          status: 409,
          body: {
            error: "lock_conflict",
            message: `cwd shared with pid ${other.pid}`,
            conflictPid: other.pid,
          },
        };
      }
    }
  }

  // (Pitfall 1) Re-resolve pane immediately before send. A pane resolved at
  // 10:00 may not exist at 10:05 (window closed, session detached, pane
  // killed). If first send fails, retry once after a fresh resolution.
  const pane = await deps.findPane(pid);
  if (!pane) {
    return {
      status: 409,
      body: {
        error: "no_tmux",
        message: "session not under tmux — bare TTY is read-only",
      },
    };
  }

  try {
    await deps.sendKeys(pane.pane, text);
  } catch (err) {
    const retry = await deps.findPane(pid);
    if (!retry) {
      return {
        status: 404,
        body: {
          error: "pane_lost",
          message: `pane ${pane.pane} disappeared between resolve and send`,
        },
      };
    }
    try {
      await deps.sendKeys(retry.pane, text);
    } catch (err2) {
      return {
        status: 404,
        body: {
          error: "pane_lost",
          message: String((err2 as Error)?.message ?? err2 ?? err),
        },
      };
    }
  }

  const ts = Date.now();
  await deps.appendAudit({
    ts,
    pid,
    repo: me.repoName ?? "",
    action: "inject",
    text,
    source,
    confidence,
    reason,
  });

  // Optional echo capture — never blocks the response on failure.
  let echo: string | undefined;
  try {
    echo = await deps.capturePane(pane.pane, 5);
  } catch {
    /* ignore */
  }

  return {
    status: 200,
    body: {
      ok: true,
      paneId: pane.pane,
      auditTs: ts,
      echoTail: echo?.split("\n").slice(-3).join("\n"),
    },
  };
}
