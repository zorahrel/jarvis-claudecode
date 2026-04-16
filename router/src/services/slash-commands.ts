import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { logger } from "./logger";

const log = logger.child({ module: "slash-commands" });

export interface SlashCommand {
  /** Name shown in channel UIs (Telegram: [a-z0-9_], max 32). */
  tgName: string;
  /** Exact slash command as Claude CLI expects it (preserves hyphens, namespaces). */
  cliName: string;
  /** 3–256 chars. */
  description: string;
  /** Origin — helps dashboards/debug. */
  source: "user" | "native" | "plugin";
}

/** Curated native Claude Code commands that are useful via a chat bot. */
const NATIVE_COMMANDS: Array<{ name: string; description: string }> = [
  { name: "clear", description: "Clear conversation context" },
  { name: "compact", description: "Compact conversation context" },
  { name: "cost", description: "Show token cost for this session" },
  { name: "help", description: "Show Claude Code help" },
  { name: "status", description: "Show session status" },
  { name: "review", description: "Review a pull request or diff" },
  { name: "init", description: "Initialize CLAUDE.md for this project" },
  { name: "resume", description: "Resume a previous session" },
  { name: "doctor", description: "Run environment health check" },
  { name: "bug", description: "Report a Claude Code bug" },
];

/** Telegram limits: 1–32 chars, [a-z0-9_] only. */
function toTgName(raw: string): string | null {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  if (!normalized || normalized.length < 1) return null;
  return normalized;
}

/** Telegram requires 3–256 chars. Clamp and sanitize. */
function sanitizeDescription(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (oneLine.length < 3) return "Custom command";
  return oneLine.slice(0, 256);
}

/** Parse a command .md file, extracting description from frontmatter or first line. */
function parseCommandFile(filePath: string): string {
  try {
    const content = readFileSync(filePath, "utf8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
      if (descMatch) {
        return descMatch[1].replace(/^["']|["']$/g, "").trim();
      }
      const body = content.slice(fmMatch[0].length).trim();
      const firstLine = body.split("\n").find(l => l.trim());
      if (firstLine) return firstLine.trim();
    }
    const firstLine = content.split("\n").find(l => l.trim() && !l.startsWith("#"));
    return firstLine ?? "";
  } catch (err) {
    log.debug({ err, filePath }, "Failed to parse command file");
    return "";
  }
}

/** Load top-level user commands from ~/.claude/commands/*.md */
function loadUserCommands(): SlashCommand[] {
  const dir = join(homedir(), ".claude", "commands");
  if (!existsSync(dir)) return [];
  const out: SlashCommand[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const cliName = entry.name.replace(/\.md$/, "");
      const tgName = toTgName(cliName);
      if (!tgName) continue;
      const rawDesc = parseCommandFile(join(dir, entry.name));
      out.push({
        tgName,
        cliName,
        description: sanitizeDescription(rawDesc || cliName),
        source: "user",
      });
    }
  } catch (err) {
    log.warn({ err }, "Failed to scan user commands dir");
  }
  return out;
}

/** Load native curated commands. */
function loadNativeCommands(): SlashCommand[] {
  return NATIVE_COMMANDS.map(c => ({
    tgName: c.name,
    cliName: c.name,
    description: sanitizeDescription(c.description),
    source: "native" as const,
  }));
}

/**
 * Return the merged command catalog. Later sources override earlier ones on
 * tgName collision (user > native), and we hard-cap at Telegram's soft limit.
 */
export function loadSlashCommands(): SlashCommand[] {
  const byTgName = new Map<string, SlashCommand>();
  for (const cmd of loadNativeCommands()) byTgName.set(cmd.tgName, cmd);
  for (const cmd of loadUserCommands()) byTgName.set(cmd.tgName, cmd);
  const list = Array.from(byTgName.values())
    .sort((a, b) => a.tgName.localeCompare(b.tgName))
    .slice(0, 100); // Telegram renders up to ~100 menu entries cleanly
  log.info({ count: list.length }, "Loaded slash commands");
  return list;
}

/**
 * Rewrite an incoming message's leading slash token if it matches a TG-sanitized
 * name that differs from the CLI name (e.g. `/caveman_compress` → `/caveman-compress`).
 * Leaves everything else untouched.
 */
export function rewriteIncomingSlash(text: string, catalog: SlashCommand[]): string {
  if (!text.startsWith("/")) return text;
  const match = text.match(/^\/([a-z0-9_]+)(\b[\s\S]*)?$/i);
  if (!match) return text;
  const [, token, rest = ""] = match;
  const hit = catalog.find(c => c.tgName === token.toLowerCase() && c.tgName !== c.cliName);
  if (!hit) return text;
  return `/${hit.cliName}${rest}`;
}
