/**
 * Reminders bridge — type contracts (Phase 2 Plan 02-02).
 *
 * Single source of truth for the reminder bridge primitives. The CLI wrapper
 * (`cli.ts`), the metadata parser (`metadata.ts`), the polling loop
 * (`poll.ts`), the dashboard API (`/api/todos`), and the React Todos tab
 * all import from here.
 *
 * Locked decisions (CONTEXT.md):
 *   - Apple Reminders is the intent layer (single source of truth for
 *     "what should be worked on"). EventKit-backed CLIs surface the data.
 *   - Body schema: `pid:NNNN repo:<name> phase:<plan|exec|review>` is the
 *     LAST line of the notes blob, separated from user prose by `\n\n`.
 *   - Three CLIs are probed in priority order (RESEARCH.md lines 122-148):
 *     remindctl (steipete tap, primary) > apple-reminders-cli (`reminder`)
 *     > ekctl. If none are installed/authorized, the bridge falls back to
 *     a local file at `~/.claude/jarvis/todos.json`.
 */

/** Active CLI selected via `getActiveCli()`. */
export type RemindersCli = "remindctl" | "apple-reminders-cli" | "ekctl" | "fallback-file";

/** Phase tag for a todo's metadata — maps to the orchestrator suggestion engine. */
export type TodoPhase = "plan" | "exec" | "review";

/** Parsed metadata extracted from the notes body. */
export interface TodoMetadata {
  pid?: number;
  repo?: string;
  phase?: TodoPhase;
}

/**
 * Single reminder (todo) shape returned by the CLI. Mirrors `remindctl show
 * --json` output 1:1 with one addition: parsed metadata exposed alongside the
 * raw `notes` string.
 *
 * @see router/src/services/reminders/__fixtures__/sample-show-active.json for
 * the canonical shape captured live.
 */
export interface ReminderTodo {
  id: string;            // UUID from EventKit (e.g. "AAAA0001-2222-44A4-84A8-58A9D976D920")
  title: string;
  list: string;          // List title (e.g. "Jarvis/ActiveTasks")
  notes: string | null;
  due: string | null;    // ISO 8601 string or null
  priority: number;      // 0=none, 1=low, 5=medium, 9=high (per EventKit convention)
  completed: boolean;
  metadata: TodoMetadata;
}

/** Result of probing the active CLI for authorization (Pitfall 2 in RESEARCH.md). */
export interface CliProbe {
  active: RemindersCli;
  authorized: boolean;
  version?: string;
}

/**
 * Diff event emitted by `startReminderPolling` whenever the 3s tick detects a
 * change. Deletions are intentionally NOT emitted — ORC-07 only tracks
 * added/completed/updated.
 */
export type TodoEvent =
  | { type: "todo:added"; todo: ReminderTodo }
  | { type: "todo:completed"; todo: ReminderTodo }
  | { type: "todo:updated"; todo: ReminderTodo; previous: ReminderTodo };
