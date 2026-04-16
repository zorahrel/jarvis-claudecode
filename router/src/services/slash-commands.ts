import { readdirSync, readFileSync, existsSync, type Dirent } from "fs";
import { join } from "path";
import { homedir } from "os";
import { logger } from "./logger";
import { clearHistory, getProcesses, sessionKey } from "./claude";
import { clearSessionCache } from "./session-cache";
import { queryCosts } from "./cost-tracker";

const log = logger.child({ module: "slash-commands" });

export interface SlashCommand {
  /** Name shown in channel UIs (Telegram: [a-z0-9_], max 32). */
  tgName: string;
  /** Exact slash command as Claude CLI expects it (preserves hyphens, namespaces). */
  cliName: string;
  /** 3–256 chars. */
  description: string;
  /** Origin — helps dashboards/debug. */
  source: "user" | "router" | "plugin";
}

/**
 * Router-native commands — intercepted BEFORE the Claude spawn and handled
 * by the router itself. Claude Code's TUI built-ins (`/help`, `/clear`, `/cost`…)
 * are not exposed over stream-json, so we re-implement the useful ones.
 */
export const ROUTER_COMMANDS: Array<{ name: string; description: string }> = [
  { name: "help", description: "List available slash commands" },
  { name: "clear", description: "Reset this conversation's context" },
  { name: "cost", description: "Show today's token cost" },
  { name: "status", description: "Show router & session status" },
];

const ROUTER_COMMAND_NAMES = new Set(ROUTER_COMMANDS.map(c => c.name));

/** Telegram limits: 1–32 chars, [a-z0-9_] only. */
function toTgName(raw: string): string | null {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  if (!normalized) return null;
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
      if (descMatch) return descMatch[1].replace(/^["']|["']$/g, "").trim();
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

/**
 * Walk a `commands/` directory and yield `(cliName, filePath)` for every .md
 * file. Subdirectories become namespaces: `gsd/do.md` → `gsd:do`.
 */
function* walkCommandDir(root: string, relDir = ""): Generator<{ cliName: string; filePath: string }> {
  const absDir = relDir ? join(root, relDir) : root;
  let entries: Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      const nextRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      yield* walkCommandDir(root, nextRel);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const base = entry.name.replace(/\.md$/, "");
    const cliName = relDir ? `${relDir.replace(/\//g, ":")}:${base}` : base;
    yield { cliName, filePath: join(absDir, entry.name) };
  }
}

function commandsFromDir(dir: string, source: "user" | "plugin"): SlashCommand[] {
  if (!existsSync(dir)) return [];
  const out: SlashCommand[] = [];
  for (const { cliName, filePath } of walkCommandDir(dir)) {
    const tgName = toTgName(cliName);
    if (!tgName) continue;
    const rawDesc = parseCommandFile(filePath);
    out.push({
      tgName,
      cliName,
      description: sanitizeDescription(rawDesc || cliName),
      source,
    });
  }
  return out;
}

/** Load top-level + namespaced user commands from ~/.claude/commands/ */
function loadUserCommands(): SlashCommand[] {
  return commandsFromDir(join(homedir(), ".claude", "commands"), "user");
}

/**
 * Load commands exposed by installed plugins:
 *   ~/.claude/plugins/marketplaces/<mkt>/plugins/<plugin>/commands/*.md
 * Plugin commands are prefixed with the plugin name: `plugin-name:cmd`.
 */
function loadPluginCommands(): SlashCommand[] {
  const out: SlashCommand[] = [];
  const marketplacesDir = join(homedir(), ".claude", "plugins", "marketplaces");
  if (!existsSync(marketplacesDir)) return out;

  let marketplaces: Dirent[];
  try { marketplaces = readdirSync(marketplacesDir, { withFileTypes: true }); }
  catch { return out; }

  for (const mkt of marketplaces) {
    if (!mkt.isDirectory()) continue;
    const pluginsDir = join(marketplacesDir, mkt.name, "plugins");
    if (!existsSync(pluginsDir)) continue;

    let plugins: Dirent[];
    try { plugins = readdirSync(pluginsDir, { withFileTypes: true }); }
    catch { continue; }

    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      const cmdDir = join(pluginsDir, plugin.name, "commands");
      for (const cmd of commandsFromDir(cmdDir, "plugin")) {
        const prefixed = `${plugin.name}:${cmd.cliName}`;
        const tgName = toTgName(prefixed);
        if (!tgName) continue;
        out.push({ ...cmd, cliName: prefixed, tgName });
      }
    }
  }
  return out;
}

function loadRouterCommands(): SlashCommand[] {
  return ROUTER_COMMANDS.map(c => ({
    tgName: c.name,
    cliName: c.name,
    description: sanitizeDescription(c.description),
    source: "router" as const,
  }));
}

/**
 * Full catalog — every discoverable command. Used for slash rewriting
 * (/caveman_compress → /caveman-compress) and by `/help`. NOT the same
 * list published to Telegram's menu (see `pickMenuCommands`).
 */
export function loadSlashCommands(): SlashCommand[] {
  const byTgName = new Map<string, SlashCommand>();
  for (const cmd of loadRouterCommands()) byTgName.set(cmd.tgName, cmd);
  for (const cmd of loadUserCommands()) {
    if (ROUTER_COMMAND_NAMES.has(cmd.tgName)) continue;
    byTgName.set(cmd.tgName, cmd);
  }
  for (const cmd of loadPluginCommands()) {
    if (ROUTER_COMMAND_NAMES.has(cmd.tgName)) continue;
    if (byTgName.has(cmd.tgName)) continue;
    byTgName.set(cmd.tgName, cmd);
  }
  const list = Array.from(byTgName.values()).sort((a, b) => {
    const weight = (c: SlashCommand) => c.source === "router" ? 0 : c.source === "user" ? 1 : 2;
    const w = weight(a) - weight(b);
    return w !== 0 ? w : a.tgName.localeCompare(b.tgName);
  });
  log.info({
    total: list.length,
    router: list.filter(c => c.source === "router").length,
    user: list.filter(c => c.source === "user").length,
    plugin: list.filter(c => c.source === "plugin").length,
  }, "Loaded slash commands");
  return list;
}

/**
 * Telegram's Bot API rejects >100 commands in a single `setMyCommands` call,
 * and the UI gets unusable long before that. This picks the subset worth
 * showing in the `/`-menu while keeping the full catalog available for
 * manual invocation and `/help`.
 *
 * Priority (fills until MAX_MENU):
 *   1. router-native (always)
 *   2. top-level user commands (no namespace, e.g. /commit, /recap)
 *   3. namespaced user commands (e.g. /gsd:do), alphabetical
 *   4. plugin commands, alphabetical
 */
const MAX_MENU = 50;
export function pickMenuCommands(catalog: SlashCommand[]): SlashCommand[] {
  const router = catalog.filter(c => c.source === "router");
  const topUser = catalog.filter(c => c.source === "user" && !c.cliName.includes(":"));
  const nsUser = catalog.filter(c => c.source === "user" && c.cliName.includes(":"));
  const plugin = catalog.filter(c => c.source === "plugin");
  const ordered = [...router, ...topUser, ...nsUser, ...plugin];
  return ordered.slice(0, MAX_MENU);
}

/**
 * Rewrite an incoming message's leading slash token if it matches a TG-sanitized
 * name that differs from the CLI name. Leaves everything else untouched.
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

/** Context needed to resolve a router-native command. */
export interface RouterCommandContext {
  channel: "telegram" | "whatsapp" | "discord";
  from: string;
  group?: string;
}

function formatHelp(catalog: SlashCommand[]): string {
  const MAX_LEN = 3800; // < Telegram's 4096 text limit, leave headroom for markdown
  const short = (s: string) => s.length > 80 ? s.slice(0, 77) + "…" : s;
  const lines = ["*Comandi disponibili*", ""];
  let usedLen = lines.join("\n").length;
  let overflow = 0;

  const group = (src: SlashCommand["source"], label: string) => {
    const items = catalog.filter(c => c.source === src);
    if (items.length === 0) return;
    const header = `_${label}_ (${items.length})`;
    const buf: string[] = [header];
    for (const c of items) {
      const line = `• /${c.tgName} — ${short(c.description)}`;
      if (usedLen + buf.join("\n").length + line.length + 2 > MAX_LEN) {
        overflow += items.length - (buf.length - 1);
        break;
      }
      buf.push(line);
    }
    buf.push("");
    lines.push(...buf);
    usedLen = lines.join("\n").length;
  };

  group("router", "Router");
  group("user", "Utente");
  group("plugin", "Plugin");
  if (overflow > 0) lines.push(`_… e altri ${overflow} comandi. Scrivi /\\<nome\\> direttamente._`);
  return lines.join("\n").trim();
}

function formatClear(ctx: RouterCommandContext): string {
  const key = sessionKey(ctx.channel, ctx.from, ctx.group);
  clearHistory(key);
  clearSessionCache(key);
  return "✅ Conversazione resettata. Ricomincio da capo al prossimo messaggio.";
}

function formatCost(): string {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const entries = queryCosts({ from: todayStart.getTime() });
  if (entries.length === 0) return "💸 Nessun costo registrato oggi.";
  const total = entries.reduce((s, e) => s + e.costUsd, 0);
  const inTok = entries.reduce((s, e) => s + e.inputTokens, 0);
  const outTok = entries.reduce((s, e) => s + e.outputTokens, 0);
  const byRoute = new Map<string, number>();
  for (const e of entries) byRoute.set(e.route, (byRoute.get(e.route) ?? 0) + e.costUsd);
  const breakdown = Array.from(byRoute.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([route, cost]) => `  • ${route}: $${cost.toFixed(4)}`)
    .join("\n");
  return [
    `💸 *Costo oggi*: $${total.toFixed(4)}`,
    `📥 input: ${inTok.toLocaleString()} tok`,
    `📤 output: ${outTok.toLocaleString()} tok`,
    `🗂 ${entries.length} richieste`,
    "",
    "_Per agent:_",
    breakdown,
  ].join("\n");
}

function formatStatus(ctx: RouterCommandContext): string {
  const procs = getProcesses();
  const key = sessionKey(ctx.channel, ctx.from, ctx.group);
  const mine = procs.find(p => p.key === key);
  const uptime = process.uptime();
  const uptimeStr = uptime > 3600
    ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
    : `${Math.floor(uptime / 60)}m`;
  const lines = [
    "🤖 *Router status*",
    `• uptime: ${uptimeStr}`,
    `• sessioni attive: ${procs.length}`,
    "",
  ];
  if (mine) {
    const lastSec = Math.floor((Date.now() - mine.lastMessageAt) / 1000);
    lines.push(
      "🧵 *Questa sessione*",
      `• agent: ${mine.workspace.split("/").pop()}`,
      `• model: ${mine.model}`,
      `• messaggi: ${mine.messageCount}`,
      `• costo: $${mine.costUsd.toFixed(4)}`,
      `• ultimo msg: ${lastSec}s fa`,
    );
  } else {
    lines.push("🧵 Nessuna sessione attiva per questa chat.");
  }
  return lines.join("\n");
}

/**
 * If `text` starts with a router-native command, return the response to send
 * back. Otherwise return `null` and let the message flow continue to Claude.
 */
export function handleRouterCommand(
  text: string,
  catalog: SlashCommand[],
  ctx: RouterCommandContext,
): string | null {
  if (!text.startsWith("/")) return null;
  const match = text.match(/^\/([a-z0-9_-]+)/i);
  if (!match) return null;
  const token = match[1].toLowerCase();
  if (!ROUTER_COMMAND_NAMES.has(token)) return null;

  switch (token) {
    case "help":   return formatHelp(catalog);
    case "clear":  return formatClear(ctx);
    case "cost":   return formatCost();
    case "status": return formatStatus(ctx);
    default:       return null;
  }
}
