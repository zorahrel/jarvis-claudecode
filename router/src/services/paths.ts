/**
 * Shared filesystem paths for router runtime state.
 *
 * Centralized so subsystems agree on the layout under `~/.claude/jarvis/state/`
 * and we don't drift into per-module string concatenation.
 */

import { join } from "path";

const HOME = process.env.HOME ?? "";

/** Root directory for runtime state that should survive process restarts but not be committed. */
export const STATE_DIR = join(HOME, ".claude/jarvis/state");

/** Telegram ring-buffer (JSON file). */
export const TELEGRAM_BUFFER_FILE = join(STATE_DIR, "telegram-buffer.json");

/** Per-chat WhatsApp JSONL files (directory; one file per chat, hashed filename). */
export const WHATSAPP_HISTORY_DIR = join(STATE_DIR, "whatsapp-history");
