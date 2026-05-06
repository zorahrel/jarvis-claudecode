import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";
import { logger } from "../services/logger";

const log = logger.child({ module: "notch-prefs" });

/**
 * User-visible toggles exposed on the notch toolbar. Persisted to disk so the
 * native tray app + the dashboard mirror reload the same state on restart.
 * New keys must preserve backwards compat via `DEFAULTS` — old files may not
 * contain them and we never want a partial read to clobber the whole object.
 */
export interface NotchPrefs {
  /** Auto-speak agent replies via TTS. Default ON. */
  tts: boolean;
  /** Arm the streaming recorder on hover (experimental). Default OFF. */
  hoverRecord: boolean;
  /** Swallow all audio output (both TTS and ambient cues). Default OFF. */
  mute: boolean;
  /**
   * Model override for this notch session. `null` = use the agent.yaml default
   * (currently `opus`). Lets the user A/B latency vs quality from the toolbar
   * without re-editing config + restarting.
   */
  model: "opus" | "sonnet" | "haiku" | null;
}

export const DEFAULTS: NotchPrefs = {
  tts: true,
  hoverRecord: false,
  mute: false,
  model: null,
};

const PREFS_DIR = join(homedir(), ".claude/jarvis/state");
const PREFS_FILE = join(PREFS_DIR, "notch-prefs.json");

let cache: NotchPrefs | null = null;

export async function getPrefs(): Promise<NotchPrefs> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(PREFS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<NotchPrefs>;
    cache = { ...DEFAULTS, ...parsed };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export async function setPrefs(patch: Partial<NotchPrefs>): Promise<NotchPrefs> {
  const current = await getPrefs();
  const next: NotchPrefs = { ...current, ...patch };
  cache = next;
  try {
    await fs.mkdir(PREFS_DIR, { recursive: true });
    await fs.writeFile(PREFS_FILE, JSON.stringify(next, null, 2), "utf-8");
  } catch (err) {
    log.warn({ err }, "prefs write failed");
  }
  return next;
}
