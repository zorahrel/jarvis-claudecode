/**
 * Reminders CLI wrapper — Phase 2 Plan 02-02 (ORC-06).
 *
 * Wraps three macOS Apple Reminders CLIs in priority order:
 *   1. remindctl                (steipete tap — primary, locked in CONTEXT.md)
 *   2. apple-reminders-cli      (`reminder` binary, AungMyoKyaw — fallback #1)
 *   3. ekctl                    (schappim — fallback #2)
 *   4. fallback-file            (~/.claude/jarvis/todos.json) when no CLI present
 *
 * Why dependency-injected execFile: the spec passes a stub so we can verify
 * argv shapes + JSON parsing without spawning a real binary. Production code
 * uses the default promisified `execFile` from `child_process`.
 *
 * Pitfall 2 (RESEARCH.md line 324): EventKit returns empty / authorized:false
 * on first run until the user grants Reminders access. probeAuth() catches
 * the rejection and returns `{authorized: false}` so the dashboard can render
 * an "Authorize Reminders" banner instead of crashing.
 *
 * Anti-pattern alert (RESEARCH.md line 295): all CLI invocations go through
 * THIS module. Never spawn `remindctl` from another file directly. Swap-in
 * to apple-reminders-cli or ekctl is a one-line probe change here.
 */

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ReminderTodo, RemindersCli, CliProbe, TodoMetadata } from "./types.js";
import { parseTodoMetadata, formatTodoMetadata } from "./metadata.js";

/**
 * Live remindctl 0.1.1 JSON shape — captured from `remindctl show all
 * --list "..." --json` on macOS 25.2.0. Differs from the documented
 * ReminderTodo:
 *   - `isCompleted` (bool) instead of `completed`
 *   - `listName`    (str)  instead of `list`
 *   - `priority`    is "none"|"low"|"medium"|"high" instead of number
 *   - extra fields: `listID`, `completionDate`
 *
 * `normalizeRemindCtl` adapts the live shape to our internal contract so
 * downstream consumers (dashboard, polling diff, snapshot enricher) get
 * one stable `ReminderTodo` regardless of CLI version drift.
 *
 * If we ever swap to apple-reminders-cli or ekctl their shapes will be
 * different again — add a sibling normalizer per CLI flavor.
 */
interface RemindCtlRaw {
  id: string;
  title: string;
  list?: string;
  listName?: string;
  notes?: string | null;
  due?: string | null;
  priority?: string | number;
  completed?: boolean;
  isCompleted?: boolean;
}

const PRIORITY_TO_NUM: Record<string, number> = {
  none: 0,
  low: 1,
  medium: 5,
  high: 9,
};

function normalizeRemindCtl(raw: RemindCtlRaw): Omit<ReminderTodo, "metadata"> {
  return {
    id: raw.id,
    title: raw.title,
    list: raw.list ?? raw.listName ?? "",
    notes: raw.notes ?? null,
    due: raw.due ?? null,
    priority: typeof raw.priority === "number"
      ? raw.priority
      : (PRIORITY_TO_NUM[String(raw.priority ?? "none").toLowerCase()] ?? 0),
    completed: raw.completed ?? raw.isCompleted ?? false,
  };
}

const execFileDefault = promisify(execFileCb);

/** Minimal exec contract — return shape mirrors `promisify(execFile)`. */
export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const FALLBACK_FILE = join(homedir(), ".claude", "jarvis", "todos.json");
const ACTIVE_LIST = "Jarvis/ActiveTasks";

/**
 * Probe each CLI in priority order; return the first that responds to
 * `--version`. If none answer, return "fallback-file" so callers can
 * gracefully degrade to local-file persistence.
 *
 * Important: we map the binary name `reminder` to the cli identifier
 * `apple-reminders-cli` because the npm package and its docs use the
 * longer name (and we want the type-level union to match CONTEXT.md).
 */
export async function getActiveCli(execFn: ExecFn = execFileDefault): Promise<RemindersCli> {
  const candidates: Array<{ bin: string; cli: RemindersCli }> = [
    { bin: "remindctl", cli: "remindctl" },
    { bin: "reminder", cli: "apple-reminders-cli" },
    { bin: "ekctl", cli: "ekctl" },
  ];
  for (const { bin, cli } of candidates) {
    try {
      await execFn(bin, ["--version"]);
      return cli;
    } catch {
      /* try next */
    }
  }
  return "fallback-file";
}

/** Return the actual binary name for a CLI identifier (apple-reminders-cli → reminder). */
function binFor(cli: RemindersCli): string {
  if (cli === "apple-reminders-cli") return "reminder";
  if (cli === "ekctl") return "ekctl";
  return "remindctl";
}

/**
 * Probe authorization status. Returns `{authorized: false}` on any error
 * including the EventKit "not authorized" stderr — we DO NOT throw, because
 * the dashboard banner relies on this returning truthy in both states.
 *
 * For "fallback-file" mode we report authorized:true unconditionally (the
 * local JSON file doesn't need OS permissions).
 */
export async function probeAuth(cli: RemindersCli = "remindctl", execFn: ExecFn = execFileDefault): Promise<CliProbe> {
  if (cli === "fallback-file") return { active: cli, authorized: true };
  try {
    const bin = binFor(cli);
    const { stdout } = await execFn(bin, ["status", "--json"]);
    const parsed = JSON.parse(stdout || "{}");
    return { active: cli, authorized: !!parsed.authorized };
  } catch (err) {
    // Any exec rejection or JSON parse error means we cannot reach the CLI
    // OR Reminders access has not been granted yet. Both → unauthorized.
    const stderr = (err as { stderr?: string }).stderr ?? "";
    if (stderr.includes("not authorized")) return { active: cli, authorized: false };
    return { active: cli, authorized: false };
  }
}

/**
 * List open + completed reminders for a given list. Each entry returns its
 * raw JSON shape PLUS parsed metadata so consumers (dashboard, polling
 * diff, snapshot enrichment) don't have to re-parse.
 */
export async function listTodos(
  list: string = ACTIVE_LIST,
  cli: RemindersCli = "remindctl",
  execFn: ExecFn = execFileDefault,
): Promise<ReminderTodo[]> {
  if (cli === "fallback-file") {
    try {
      const raw = await fs.readFile(FALLBACK_FILE, "utf8");
      const arr = JSON.parse(raw) as Array<Omit<ReminderTodo, "metadata"> & { metadata?: TodoMetadata }>;
      // Always re-derive metadata from notes so a hand-edited todos.json
      // can't drift between notes and metadata.
      return arr.map((t) => ({ ...t, metadata: parseTodoMetadata(t.notes) }));
    } catch {
      return [];
    }
  }

  // (W2 FIX) Primary CLI is remindctl. Fallback CLIs (apple-reminders-cli,
  // ekctl) have DIFFERENT JSON shapes — RESEARCH.md confidence is "medium"
  // for them. We do not adapt their shapes; instead we emit a warning so
  // the dashboard banner can prompt the user to install remindctl.
  if (cli !== "remindctl") {
    console.warn(
      `[reminders] using fallback CLI ${cli} — JSON shape may differ from remindctl. ` +
      `Install steipete/remindctl for fully tested behavior: brew install steipete/tap/remindctl`,
    );
  }

  const bin = binFor(cli);
  // remindctl uses `show all --list <name> --json`. Fallback CLIs use
  // `show --list <name> --json` per RESEARCH.md (best-effort behavior).
  const args = cli === "remindctl"
    ? ["show", "all", "--list", list, "--json"]
    : ["show", "--list", list, "--json"];
  const { stdout } = await execFn(bin, args);
  const raw = JSON.parse(stdout || "[]") as RemindCtlRaw[];
  return raw.map((r) => {
    const normalized = normalizeRemindCtl(r);
    return { ...normalized, metadata: parseTodoMetadata(normalized.notes) };
  });
}

interface AddTodoInput {
  title: string;
  notes?: string;
  due?: string;
  metadata?: { pid: number; repo: string; phase: "plan" | "exec" | "review" };
}

/**
 * Add a new reminder. When `metadata` is provided we append the canonical
 * `pid:N repo:R phase:P` line to the notes blob (separated by a blank line
 * from any user prose). The polling loop and the snapshot enricher rely on
 * this format being present.
 *
 * Round-trip note: the response from remindctl includes the same notes we
 * sent, so parseTodoMetadata on the response will produce the same metadata
 * object the caller passed in (verified in cli.spec.ts).
 */
export async function addTodo(
  input: AddTodoInput,
  list: string = ACTIVE_LIST,
  cli: RemindersCli = "remindctl",
  execFn: ExecFn = execFileDefault,
): Promise<ReminderTodo> {
  const fullNotes = input.metadata
    ? (input.notes ? `${input.notes}\n\n` : "") + formatTodoMetadata(input.metadata)
    : (input.notes ?? "");

  if (cli === "fallback-file") {
    const todos = await listTodos(list, cli, execFn);
    const newTodo: ReminderTodo = {
      id: `local-${Date.now()}`,
      title: input.title,
      list,
      notes: fullNotes || null,
      due: input.due ?? null,
      priority: 0,
      completed: false,
      metadata: input.metadata ?? {},
    };
    await fs.mkdir(join(homedir(), ".claude", "jarvis"), { recursive: true });
    // Strip the cached `metadata` field so the on-disk shape mirrors the
    // remindctl JSON contract (notes is the source of truth).
    const onDisk = [...todos, newTodo].map(({ metadata: _m, ...rest }) => rest);
    await fs.writeFile(FALLBACK_FILE, JSON.stringify(onDisk, null, 2));
    return newTodo;
  }

  const bin = binFor(cli);
  const args = ["add", input.title, "--list", list];
  if (fullNotes) {
    args.push("--notes", fullNotes);
  }
  if (input.due) {
    args.push("--due", input.due);
  }
  args.push("--json");
  const { stdout } = await execFn(bin, args);
  const created = JSON.parse(stdout) as RemindCtlRaw;
  const normalized = normalizeRemindCtl(created);
  return { ...normalized, metadata: parseTodoMetadata(normalized.notes) };
}

/**
 * Mark a reminder as completed. `id` accepts either the full UUID or a
 * unique prefix (remindctl resolves prefixes; the apple-reminders-cli +
 * ekctl fallbacks accept the full UUID).
 */
export async function completeTodo(
  id: string,
  cli: RemindersCli = "remindctl",
  execFn: ExecFn = execFileDefault,
): Promise<{ ok: boolean }> {
  if (cli === "fallback-file") {
    const todos = await listTodos(ACTIVE_LIST, cli, execFn);
    const next = todos.map((t) => (t.id === id ? { ...t, completed: true } : t));
    const onDisk = next.map(({ metadata: _m, ...rest }) => rest);
    await fs.writeFile(FALLBACK_FILE, JSON.stringify(onDisk, null, 2));
    return { ok: true };
  }
  const bin = binFor(cli);
  await execFn(bin, ["complete", id, "--json"]);
  return { ok: true };
}
