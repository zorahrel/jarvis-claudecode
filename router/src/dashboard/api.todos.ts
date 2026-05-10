/**
 * Todos API handlers — Phase 2 Plan 02-02 (ORC-09).
 *
 * Why a separate module from `api.ts`:
 *   - `api.ts` exports a single `handleApi()` that imports baileys + cron + ws
 *     + notch connectors. Importing it transitively in tests hangs the
 *     runner (same problem Plan 02-01 hit with buildSnapshot — see
 *     `api.transcript.spec.ts` rationale). Extracting handler logic into
 *     a plain module with injectable dependencies makes the test suite
 *     fast and hermetic.
 *
 * The shape mirrors `services/orchestrator/snapshot.ts` — pure helpers
 * that the thin route wrapper in api.ts calls.
 */

import type { ReminderTodo, RemindersCli } from "../services/reminders/types.js";

/**
 * Injectable surface for the todos handlers. Production wires these to
 * the real reminders bridge (services/reminders/index.ts). Tests pass
 * stubs so we never spawn a CLI.
 */
export interface TodosDeps {
  listTodos: (list?: string, cli?: RemindersCli) => Promise<ReminderTodo[]>;
  addTodo: (
    input: { title: string; notes?: string; due?: string; metadata?: { pid: number; repo: string; phase: "plan" | "exec" | "review" } },
    list?: string,
    cli?: RemindersCli,
  ) => Promise<ReminderTodo>;
  completeTodo: (id: string, cli?: RemindersCli) => Promise<{ ok: boolean }>;
  probeAuth: (cli?: RemindersCli) => Promise<{ active: RemindersCli; authorized: boolean }>;
  /** PATCH route's edit primitive — called with the metadata-only notes blob. */
  editNotes: (uuid: string, notes: string) => Promise<void>;
}

/** Result envelope shared by every handler — handler-route maps these to HTTP. */
export type HandlerResult<T = unknown> = { status: number; body: T };

/**
 * GET /api/todos handler. Returns max 100 OPEN todos sorted by due-date
 * ascending (null due last).
 *
 * Graceful degradation paths (all return 200, never 500):
 *   - Reminders not authorized        → {todos:[], unauthorized:true}
 *   - "List not found" (first run)    → {todos:[], listMissing:true}
 *   - listTodos rejects for any other reason → {todos:[], error:"..."}
 *
 * The dashboard renders specific banners for each case. The router
 * NEVER crashes on the auth-denied or list-missing path (acceptance
 * criterion + plan constraint #2 / #3).
 */
export async function handleListTodos(deps: TodosDeps): Promise<HandlerResult> {
  try {
    const auth = await deps.probeAuth();
    if (!auth.authorized) {
      return { status: 200, body: { todos: [], unauthorized: true } };
    }
    let all;
    try {
      all = await deps.listTodos();
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      // Reminders list missing — first-run before the user has created
      // Jarvis/ActiveTasks via the iPhone app or AppleScript bootstrap.
      // Render a banner, not an error.
      if (/list not found/i.test(msg) || /no such list/i.test(msg)) {
        return {
          status: 200,
          body: {
            todos: [],
            unauthorized: false,
            listMissing: true,
            message: "Reminders list 'Jarvis/ActiveTasks' not found. Create it on your iPhone or Mac Reminders app to enable Jarvis todos.",
          },
        };
      }
      // Any other CLI failure → empty + log; still 200 so the polling
      // loop does not hammer 500s into the dashboard.
      return {
        status: 200,
        body: { todos: [], unauthorized: false, error: msg.slice(0, 200) },
      };
    }
    const open = all.filter((t) => !t.completed);
    open.sort((a, b) => {
      if (a.due && b.due) return a.due.localeCompare(b.due);
      if (a.due) return -1;
      if (b.due) return 1;
      return 0;
    });
    return { status: 200, body: { todos: open.slice(0, 100), unauthorized: false } };
  } catch (err) {
    // Only reachable if probeAuth itself throws — extremely unlikely
    // because probeAuth swallows its own errors.
    return {
      status: 500,
      body: { error: "todos_list_failed", message: String((err as Error).message ?? err) },
    };
  }
}

/**
 * POST /api/todos handler. Body: {title, notes?, due?, metadata?}.
 * Returns the created ReminderTodo with status 201.
 */
export async function handleAddTodo(
  deps: TodosDeps,
  body: { title?: unknown; notes?: unknown; due?: unknown; metadata?: unknown },
): Promise<HandlerResult> {
  try {
    if (!body.title || typeof body.title !== "string") {
      return { status: 400, body: { error: "title_required" } };
    }
    const created = await deps.addTodo({
      title: body.title,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      due: typeof body.due === "string" ? body.due : undefined,
      metadata: isMetadataPayload(body.metadata) ? body.metadata : undefined,
    });
    return { status: 201, body: created };
  } catch (err) {
    return {
      status: 500,
      body: { error: "todos_add_failed", message: String((err as Error).message ?? err) },
    };
  }
}

/** POST /api/todos/:uuid/complete handler. */
export async function handleCompleteTodo(deps: TodosDeps, uuid: string): Promise<HandlerResult> {
  try {
    if (!uuid) return { status: 400, body: { error: "uuid_required" } };
    const result = await deps.completeTodo(uuid);
    return { status: 200, body: result };
  } catch (err) {
    return {
      status: 500,
      body: { error: "todos_complete_failed", message: String((err as Error).message ?? err) },
    };
  }
}

/**
 * PATCH /api/todos/:uuid handler — moved here from Plan 02-03 (B2 FIX).
 *
 * Body: `{metadata: {pid, repo?, phase?}}`. Updates the reminder's notes
 * to the canonical metadata-only line. Used by the notch long-press
 * reassign flow (ORC-13) and by the dashboard's "reassign to session"
 * action.
 *
 * Returns 400 if `metadata.pid` is missing (the only required field —
 * repo and phase have safe defaults so an iPhone/Watch user can drag-
 * drop a todo onto a session pid without typing).
 */
export async function handlePatchTodo(
  deps: TodosDeps,
  uuid: string,
  body: { metadata?: unknown },
): Promise<HandlerResult> {
  try {
    if (!uuid) return { status: 400, body: { error: "uuid_required" } };
    const meta = body.metadata as { pid?: unknown; repo?: unknown; phase?: unknown } | undefined;
    if (!meta || typeof meta.pid !== "number") {
      return { status: 400, body: { error: "metadata_pid_required" } };
    }
    const repo = typeof meta.repo === "string" ? meta.repo : "unknown";
    const phase = meta.phase === "plan" || meta.phase === "exec" || meta.phase === "review" ? meta.phase : "exec";
    const newNote = `pid:${meta.pid} repo:${repo} phase:${phase}`;
    await deps.editNotes(uuid, newNote);
    return { status: 200, body: { ok: true } };
  } catch (err) {
    return {
      status: 500,
      body: { error: "todos_patch_failed", message: String((err as Error).message ?? err) },
    };
  }
}

function isMetadataPayload(x: unknown): x is { pid: number; repo: string; phase: "plan" | "exec" | "review" } {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.pid === "number" &&
    typeof o.repo === "string" &&
    (o.phase === "plan" || o.phase === "exec" || o.phase === "review")
  );
}
