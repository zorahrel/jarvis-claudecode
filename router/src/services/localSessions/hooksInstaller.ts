import { promises as fs, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { logger } from "../logger";

const log = logger.child({ module: "localSessions:hooks" });

const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const HOOKS_DIR = join(homedir(), ".claude", "jarvis", "hooks");
export const EVENTS_DIR = join(homedir(), ".claude", "jarvis", "events");
const HOOK_SCRIPT = join(HOOKS_DIR, "jarvis-control-status.sh");
const HOOK_COMMAND_MARKER = HOOK_SCRIPT;

const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "Stop",
  "UserPromptSubmit",
  "PermissionRequest",
  "SubagentStart",
  "PostToolUseFailure",
] as const;

// Write directly to a temp file and rename, so a partial write can never
// corrupt the events file that the reader polls.
const HOOK_SCRIPT_BODY = `#!/bin/bash
# jarvis-control status hook — writes session events for local session monitor
set -e

EVENTS_DIR="${EVENTS_DIR}"
mkdir -p "$EVENTS_DIR"

INPUT=$(cat)

HOOK_EVENT=$(echo "$INPUT" | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\\([^"]*\\)"$/\\1/')
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\\([^"]*\\)"$/\\1/')
CWD=$(echo "$INPUT" | grep -o '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\\([^"]*\\)"$/\\1/')
TRANSCRIPT=$(echo "$INPUT" | grep -o '"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\\([^"]*\\)"$/\\1/')

if [ -z "$SESSION_ID" ] || [ -z "$HOOK_EVENT" ]; then
  exit 0
fi

TS=$(date +%s)
TMP="$EVENTS_DIR/$PPID.json.tmp"
echo "{\\"event\\":\\"$HOOK_EVENT\\",\\"session_id\\":\\"$SESSION_ID\\",\\"cwd\\":\\"$CWD\\",\\"transcript_path\\":\\"$TRANSCRIPT\\",\\"ts\\":$TS}" > "$TMP"
mv "$TMP" "$EVENTS_DIR/$PPID.json"
`;

let installed: boolean | null = null;

/**
 * Install jarvis-control status hooks into ~/.claude/settings.json.
 * Idempotent: merges into the existing hooks array, never replaces.
 * Safe to call repeatedly — hooks are keyed by command path.
 */
export async function ensureHooksInstalled(): Promise<boolean> {
  if (installed !== null) return installed;

  try {
    await fs.mkdir(HOOKS_DIR, { recursive: true });
    await fs.mkdir(EVENTS_DIR, { recursive: true });
    await fs.writeFile(HOOK_SCRIPT, HOOK_SCRIPT_BODY, "utf-8");
    await fs.chmod(HOOK_SCRIPT, 0o755);

    let settings: Record<string, unknown> = {};
    if (existsSync(CLAUDE_SETTINGS)) {
      try {
        settings = JSON.parse(await fs.readFile(CLAUDE_SETTINGS, "utf-8"));
      } catch (err) {
        log.warn({ err }, "settings.json unreadable — skipping hook install");
        installed = false;
        return false;
      }
    }

    const hooks = (settings.hooks ?? {}) as Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string; type?: string; timeout?: number; async?: boolean }> }>>;
    let changed = false;

    for (const event of HOOK_EVENTS) {
      const existing = hooks[event] ?? [];
      const already = existing.some((e) =>
        e.hooks?.some((h) => h.command === HOOK_COMMAND_MARKER),
      );
      if (already) continue;
      const matcher = event === "PostToolUseFailure" ? "Bash" : "";
      existing.push({
        matcher,
        hooks: [{ type: "command", command: HOOK_SCRIPT, timeout: 5, async: true }],
      });
      hooks[event] = existing;
      changed = true;
    }

    if (changed) {
      settings.hooks = hooks;
      await fs.writeFile(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      log.info("Installed jarvis-control status hooks into ~/.claude/settings.json");
    }

    installed = true;
    return true;
  } catch (err) {
    log.warn({ err }, "Failed to install jarvis-control hooks");
    installed = false;
    return false;
  }
}

/** Remove jarvis-control hooks from ~/.claude/settings.json. */
export async function uninstallHooks(): Promise<void> {
  if (!existsSync(CLAUDE_SETTINGS)) return;
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(await fs.readFile(CLAUDE_SETTINGS, "utf-8"));
  } catch {
    return;
  }
  const hooks = settings.hooks as Record<string, Array<{ hooks?: Array<{ command?: string }> }>> | undefined;
  if (!hooks) return;

  let changed = false;
  for (const event of HOOK_EVENTS) {
    if (!hooks[event]) continue;
    const filtered = hooks[event].filter((e) =>
      !e.hooks?.some((h) => h.command === HOOK_COMMAND_MARKER),
    );
    if (filtered.length !== hooks[event].length) {
      hooks[event] = filtered;
      changed = true;
    }
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (changed) {
    await fs.writeFile(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    log.info("Removed jarvis-control hooks from settings.json");
  }
  installed = null;
}
