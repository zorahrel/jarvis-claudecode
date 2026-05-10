/**
 * Phase 2 Plan 02-04 — tmux pid → pane mapping (ORC-15, ORC-16).
 *
 * Public API:
 *  - listAllPanes()     — single shell-out to `tmux list-panes -aF` parsed into PaneRow[].
 *  - findPaneForPid()   — resolves a session PID to its pane via parent-walking
 *                         through `ps -o ppid=`. Optional cachedPanes arg lets
 *                         callers (snapshot.ts) pass a pre-fetched pane map so
 *                         we don't shell out N times in a 5s polling loop (W4).
 *  - sendKeys()         — `tmux send-keys -t <pane> -- <line> Enter [<line> Enter ...]`.
 *                         Always passes args as ARRAY (RESEARCH.md Pitfall 4 — never
 *                         compose shell strings). Uses `--` terminator to neutralize
 *                         user-supplied text starting with `-`.
 *  - capturePane()      — `tmux capture-pane -p -S -<lines>` for echo verification.
 *
 * All exec invocations go through an injected `ExecFn` so unit tests can stub
 * tmux/ps without ever spawning a real process.
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFileDefault = promisify(execFileCb) as unknown as ExecFn;

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface PaneRow {
  pid: number;
  session: string;
  pane: string;
  windowIndex: number;
  active: boolean;
}

/**
 * One shell-out to `tmux list-panes -aF` covering ALL sessions.
 *
 * Returns [] on any error (tmux not running, no panes, exec failed) so
 * callers can treat "no tmux" as a normal degraded state rather than an
 * exception. Bare-TTY semantics live in CONTEXT.md.
 */
export async function listAllPanes(execFn: ExecFn = execFileDefault): Promise<PaneRow[]> {
  let stdout: string;
  try {
    const r = await execFn("tmux", [
      "list-panes",
      "-aF",
      "#{pane_pid} #{session_name} #{pane_id} #{window_index} #{pane_active}",
    ]);
    stdout = r.stdout;
  } catch {
    return [];
  }
  return stdout
    .trim()
    .split("\n")
    .filter((l) => l.length > 0)
    .map((line) => {
      const parts = line.split(" ");
      return {
        pid: parseInt(parts[0] ?? "0", 10),
        session: parts[1] ?? "",
        pane: parts[2] ?? "",
        windowIndex: parseInt(parts[3] ?? "0", 10),
        active: parts[4] === "1",
      };
    });
}

/**
 * Resolve a session PID to its pane via parent-walking.
 *
 * Why walk parents: Claude CLI under tmux runs as a *child* of the shell,
 * which is the pane's foreground process. So the pid we observe in
 * `discoverLocalSessions()` (the Claude CLI) won't match the pane_pid
 * directly — we have to walk up the ppid chain until we hit either a
 * matching pane_pid or PID 1 (give up).
 *
 * `cachedPanes` (W4 FIX): snapshot.ts builds a single pid→paneInfo map
 * once per snapshot and passes it here so we don't shell out to `tmux`
 * on every call when polling many sessions. When supplied, listAllPanes
 * is skipped entirely — only `ps -o ppid=` shell-outs remain (one per
 * level of the parent chain).
 */
export async function findPaneForPid(
  targetPid: number,
  execFn: ExecFn = execFileDefault,
  cachedPanes?: Map<number, { session: string; pane: string }>,
): Promise<{ session: string; pane: string } | null> {
  const panes: PaneRow[] = cachedPanes
    ? Array.from(cachedPanes.entries()).map(
        ([pid, v]) => ({ pid, session: v.session, pane: v.pane, windowIndex: 0, active: false }),
      )
    : await listAllPanes(execFn);
  if (panes.length === 0) return null;
  let cur = targetPid;
  // Cap the walk at 50 levels — sane upper bound to avoid infinite loops on
  // a misbehaving ps implementation.
  for (let i = 0; i < 50 && cur > 1; i++) {
    const hit = panes.find((p) => p.pid === cur);
    if (hit) return { session: hit.session, pane: hit.pane };
    try {
      const { stdout } = await execFn("ps", ["-o", "ppid=", "-p", String(cur)]);
      const ppid = parseInt(stdout.trim(), 10);
      if (!ppid || ppid === cur) break;
      cur = ppid;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Send keystrokes to a tmux pane.
 *
 * - Always uses execFile + arg-array (NEVER shell strings). RESEARCH.md
 *   Pitfall 4 — `\n` is literal in send-keys, multi-line text needs each
 *   line as its own argument with `Enter` literals between them.
 * - The `--` terminator neutralizes user-supplied text that starts with
 *   `-` (would otherwise be parsed as a tmux flag).
 * - Single send-keys invocation per call — atomic from tmux's POV.
 */
export async function sendKeys(
  paneId: string,
  text: string,
  execFn: ExecFn = execFileDefault,
): Promise<void> {
  const lines = text.split("\n");
  const args: string[] = ["send-keys", "-t", paneId, "--"];
  for (const line of lines) {
    args.push(line);
    args.push("Enter");
  }
  await execFn("tmux", args);
}

/**
 * Capture the last N lines of a pane for echo verification / audit aid.
 * Non-fatal — callers should swallow exceptions.
 */
export async function capturePane(
  paneId: string,
  lines: number = 50,
  execFn: ExecFn = execFileDefault,
): Promise<string> {
  const { stdout } = await execFn("tmux", [
    "capture-pane",
    "-t",
    paneId,
    "-p",
    "-S",
    `-${lines}`,
  ]);
  return stdout;
}
