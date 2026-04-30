import type { IncomingMessage, ServerResponse } from "http";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getProcesses, killProcessByKey, resolveCliPath } from "../services/claude";
import { loadSessionThread, isValidKey } from "../services/session-cache";
import { searchDocsDetailed, searchMemoriesDetailed, getMemoryStats, getDocuments, getMemories, deleteMemory, reindexDocs } from "../services/memory";
import { getConfig, readRawConfig, writeRawConfig, getToolRegistry, getToolRouteMap, getEmailAccounts, getAgentRegistry, reloadConfig } from "../services/config-loader";
import { getCronStates, triggerCronJob, listCronRuns, deleteCronRuns, getDeliveryFn } from "../services/cron";
import { resolveToken } from "../services/notify-tokens";
import {
  hasNotifyBudget,
  consumeNotifyBudget,
  checkNotifyRate,
  checkNotifyDedup,
  notifyBudgetRemaining,
} from "../services/rate-limiter";
import { formatForChannel } from "../services/formatting";
import { broadcast } from "./ws";
import { randomUUID } from "crypto";
import { queryCosts, aggregateCosts, getTotalCost } from "../services/cost-tracker";
import { logger } from "../services/logger";
import { clearLogEntries } from "./state";
import { corsOrigin, json, parseBody, requireConfirm, validateAgentName, safeReadFile } from "./helpers";
import { getLogEntries, getCliSessions, getCliSessionsMap, invalidateHtmlCache, persistCliSessionsNow } from "./state";
import { getRoutesData, getAgentsData, getStatsData, getResponseTimesData, getProcessesWithContext, walkMemoryDir } from "./data";
import { getAllServices, generatePlist } from "../services/services";
import { discoverLocalSessions, dispatchOpenTarget, availableTargets, type OpenTargetId } from "../services/localSessions";
import { subscribe as subscribeNotch, emitNotch } from "../notch/events";
import { NotchConnector } from "../connectors/notch";
import { WhatsAppConnector } from "../connectors/whatsapp";
import { readHistory, clearHistory } from "../notch/history";
import { getPrefs, setPrefs } from "../notch/prefs";
import { speakToFile } from "../services/tts";

const log = logger.child({ module: "dashboard" });
const HOME = process.env.HOME!;

// --- Debounced memory reindex after file CRUD ---
// Multiple rapid edits coalesce into a single reindex call ~2s after the last mutation.
let _reindexTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleReindex(reason: string): void {
  if (_reindexTimer) clearTimeout(_reindexTimer);
  _reindexTimer = setTimeout(() => {
    _reindexTimer = null;
    reindexDocs()
      .then((r) => log.info("[memory] auto-reindex after %s: %o", reason, r))
      .catch((e) => log.warn("[memory] auto-reindex failed after %s: %s", reason, e.message));
  }, 2000);
}

// --- Memory graph response cache ---
// Building the graph walks the FS and reads every .md file; caching for a window
// cuts repeat latency. Invalidated on any PUT/DELETE via invalidateGraphCache().
const GRAPH_CACHE_TTL_MS = 30_000;
let _graphCache: { at: number; payload: { nodes: any[]; edges: any[] } } | null = null;
function invalidateGraphCache(): void { _graphCache = null; }

// --- Scope descriptions for memory dropdown ---
// Built-in descriptions for common scopes. User-defined scopes (see
// jarvis.memoryScopePatterns in config.yaml) fall through to a default label
// rendered by the dashboard.
export const SCOPE_HELP: Record<string, string> = {
  "": "All scopes",
  business: "Default scope for conversations — work / clients / routing",
  global: "General purpose scope — cross-cutting notes",
};

export async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  // Strip query string so endpoint matches with `path === "..."` work correctly
  const qIdx = path.indexOf("?");
  if (qIdx >= 0) path = path.slice(0, qIdx);

  // CORS preflight
  if (req.method === "OPTIONS") {
    const origin = corsOrigin(req);
    const headers: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Confirm",
    };
    if (origin) headers["Access-Control-Allow-Origin"] = origin;
    res.writeHead(204, headers);
    res.end();
    return;
  }

  const logEntries = getLogEntries();
  const cliSessions = getCliSessionsMap();

  // --- CONSOLIDATED DASHBOARD STATE ---
  if (path === "/api/dashboard-state") {
    // Config-backed state (safely read, fallbacks to empty)
    let callers: string[] = [];
    let alwaysReplyGroups: string[] = [];
    try {
      const raw = readRawConfig() as any;
      callers = raw?.jarvis?.allowedCallers ?? [];
      alwaysReplyGroups = raw?.jarvis?.alwaysReplyGroups ?? [];
    } catch { /* ignore */ }

    // Global CLAUDE.md (system-wide, auto-loaded by all agents)
    const HOME = process.env.HOME!;
    const globalClaudeMdPath = `${HOME}/.claude/CLAUDE.md`;
    const globalClaudeMd = safeReadFile(globalClaudeMdPath) ?? "";
    const globalClaudeMdSize = globalClaudeMd.length;

    // settings.json → hooks list (MCP + plugins live in Tools / Skills pages)
    let settingsHooks: string[] = [];
    try {
      const settingsRaw = safeReadFile(`${HOME}/.claude/settings.json`);
      if (settingsRaw) {
        const s = JSON.parse(settingsRaw);
        settingsHooks = Object.keys(s.hooks ?? {});
      }
    } catch { /* ignore */ }

    // Agent names — used by Cron create form
    let agentNames: string[] = [];
    try {
      const agents = getAgentsData();
      agentNames = agents.map((a: any) => a.name);
    } catch { /* ignore */ }

    json(req, res, {
      stats: getStatsData(),
      processes: getProcessesWithContext(),
      responseTimes: getResponseTimesData(),
      logs: logEntries.slice(-50),
      cliSessions: getCliSessions(),
      scopeHelp: SCOPE_HELP,
      callers,
      alwaysReplyGroups,
      globalClaudeMd,
      globalClaudeMdSize,
      settingsHooks,
      agentNames,
    });

  // --- CLI SESSION APIs ---
  } else if (path === "/api/session-start" && req.method === "POST") {
    const body = await parseBody(req);
    const id = body.id || `cli-${Date.now()}`;
    const workspace = body.workspace || process.cwd();
    const existing = cliSessions.get(id);
    cliSessions.set(id, {
      id,
      workspace,
      startedAt: existing?.startedAt ?? Date.now(),
      lastSeen: Date.now(),
      alive: true,
    });
    persistCliSessionsNow();
    log.info("[cli] Session started: %s in %s", id, workspace);
    json(req, res, { ok: true, id });

  } else if (path === "/api/session-stop" && req.method === "POST") {
    const body = await parseBody(req);
    const id = body.id || "";
    if (cliSessions.has(id)) {
      cliSessions.get(id)!.alive = false;
      persistCliSessionsNow();
      log.info("[cli] Session stopped: %s", id);
    }
    json(req, res, { ok: true });

  } else if (path === "/api/session-heartbeat" && req.method === "POST") {
    const body = await parseBody(req);
    const id = body.id || "";
    const workspace = body.workspace as string | undefined;
    const existing = cliSessions.get(id);
    if (existing) {
      existing.lastSeen = Date.now();
      existing.alive = true;
    } else if (id) {
      // First heartbeat for an unseen id (e.g. router restarted) — auto-register.
      cliSessions.set(id, { id, workspace: workspace || "", startedAt: Date.now(), lastSeen: Date.now(), alive: true });
    }
    json(req, res, { ok: true });

  } else if (path === "/api/cli-sessions" && req.method === "DELETE") {
    // Prune all dead/stale CLI sessions.
    let removed = 0;
    for (const [id, s] of cliSessions) {
      if (!s.alive) { cliSessions.delete(id); removed++; }
    }
    persistCliSessionsNow();
    json(req, res, { ok: true, removed });

  } else if (path.startsWith("/api/cli-sessions/") && req.method === "DELETE") {
    const id = decodeURIComponent(path.slice("/api/cli-sessions/".length));
    const removed = cliSessions.delete(id);
    if (removed) persistCliSessionsNow();
    json(req, res, { ok: removed });

  } else if (path === "/api/cli-sessions") {
    json(req, res, getCliSessions());

  // --- SESSION THREAD (conversation drill-down) ---
  } else if (path.match(/^\/api\/sessions\/[^/]+\/thread$/) && req.method === "GET") {
    const key = decodeURIComponent(path.split("/")[3]);
    if (!isValidKey(key)) { json(req, res, { error: "invalid session key" }, 400); return; }
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    const limitParam = parseInt(reqUrl.searchParams.get("limit") || "50", 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 50;
    const thread = loadSessionThread(key, limit);
    if (!thread) { json(req, res, { error: "session not found" }, 404); return; }
    json(req, res, thread);

  // --- PROACTIVE NOTIFY (agent → origin channel) ---
  // Auth: bearer token issued at CLI spawn, bound to (channel, target).
  // NEVER accept channel/target from body — spoofing-proof by construction.
  } else if (path === "/api/notify" && req.method === "POST") {
    const authHeader = req.headers["authorization"];
    const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";
    if (!token) { json(req, res, { error: "missing bearer token" }, 401); return; }

    const binding = resolveToken(token);
    if (!binding) { json(req, res, { error: "invalid or expired token" }, 401); return; }

    let body: { text?: unknown; silent?: unknown };
    try { body = await parseBody(req); } catch { json(req, res, { error: "bad body" }, 400); return; }

    const text = typeof body.text === "string" ? body.text : "";
    if (!text || text.length === 0) { json(req, res, { error: "missing text" }, 400); return; }
    if (text.length > 10000) { json(req, res, { error: "text too long (max 10000)" }, 400); return; }
    const silent = body.silent === true;

    // Session key is the binding itself — notify tokens are 1:1 with session.
    const sessionKey = `${binding.channel}:${binding.target}`;
    const BUDGET_LIMIT = 100;

    // S4 guard 1 — budget headroom (non-mutating; consume only after delivery).
    if (!hasNotifyBudget(sessionKey, BUDGET_LIMIT)) {
      json(req, res, { error: "budget_exceeded", remaining: { budget: 0 } }, 429);
      return;
    }
    // S4 guard 2 — sliding-window rate per (channel, target).
    if (!checkNotifyRate(binding.channel, binding.target)) {
      json(req, res, {
        error: "rate_limited",
        remaining: { budget: notifyBudgetRemaining(sessionKey, BUDGET_LIMIT) },
      }, 429);
      return;
    }
    // S4 guard 3 — identical text to same target within 5s is a silent drop.
    if (!checkNotifyDedup(binding.target, text)) {
      json(req, res, { ok: true, deduped: true, messageId: null });
      return;
    }

    const deliver = getDeliveryFn();
    if (!deliver) {
      json(req, res, { error: "delivery not available" }, 503);
      return;
    }

    const formatted = formatForChannel(text, binding.channel);
    try {
      await deliver(binding.channel, binding.target, formatted);
    } catch (err: any) {
      log.error({ err: err?.message, channel: binding.channel, target: binding.target }, "Proactive notify delivery failed");
      json(req, res, { error: "delivery failed" }, 502);
      return;
    }

    // Only pay budget for messages that made it out — failures/drops above don't count.
    consumeNotifyBudget(sessionKey);
    const messageId = randomUUID();
    log.info({ channel: binding.channel, target: binding.target, textLen: text.length, messageId }, "Proactive notify delivered");

    if (!silent) {
      broadcast({
        type: "notify.outbound",
        data: {
          channel: binding.channel,
          target: binding.target,
          preview: text.slice(0, 120),
          messageId,
          ts: Date.now(),
        },
      });
    }

    json(req, res, {
      ok: true,
      messageId,
      remaining: { budget: notifyBudgetRemaining(sessionKey, BUDGET_LIMIT) },
    });

  // --- READ APIs ---
  } else if (path === "/api/processes") {
    json(req, res, getProcessesWithContext());
  } else if (path === "/api/stats") {
    json(req, res, getStatsData());
  } else if (path === "/api/response-times") {
    json(req, res, getResponseTimesData());
  } else if (path === "/api/costs" && req.method === "GET") {
    const url = new URL(req.url!, `http://${req.headers.host ?? "localhost"}`);
    const days = url.searchParams.get("days") ? parseInt(url.searchParams.get("days")!) : undefined;
    const from = days ? Date.now() - days * 86400_000 : (url.searchParams.get("from") ? parseInt(url.searchParams.get("from")!) : undefined);
    const to = url.searchParams.get("to") ? parseInt(url.searchParams.get("to")!) : undefined;
    const route = url.searchParams.get("route") || undefined;
    const groupBy = (url.searchParams.get("groupBy") as "route" | "channel" | "day" | "model") || "route";
    const aggregated = aggregateCosts({ from, to, route, groupBy });
    const byDay = aggregateCosts({ from, to, route, groupBy: "day" });
    const raw = queryCosts({ from, to, route });
    const { totalCost, count } = getTotalCost();
    json(req, res, { totalCost, count, aggregated, byDay, recent: raw.slice(-100) });
  } else if (path === "/api/logs") {
    json(req, res, logEntries.slice(-50));
  } else if (path.startsWith("/api/kill/") && req.method === "POST") {
    const key = decodeURIComponent(path.slice("/api/kill/".length));
    json(req, res, { ok: killProcessByKey(key), key });

  // --- CONFIG READ ---
  } else if (path === "/api/config" && req.method === "GET") {
    try {
      const raw = readRawConfig();
      json(req, res, raw);
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- TOOLS REGISTRY ---
  } else if (path === "/api/tools" && req.method === "GET") {
    try {
      const registry = getToolRegistry();
      const routeMap = getToolRouteMap();
      json(req, res, { tools: registry, byRoute: routeMap });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- CRON JOBS ---
  } else if (path === "/api/crons" && req.method === "GET") {
    json(req, res, getCronStates().map(s => ({
      name: s.job.name,
      schedule: s.job.schedule,
      timezone: s.job.timezone ?? "UTC",
      workspace: s.job.workspace,
      model: s.job.model ?? "opus",
      prompt: s.job.prompt,
      timeout: s.job.timeout ?? 300,
      delivery: s.job.delivery ?? null,
      lastRun: s.lastRun,
      lastStatus: s.lastStatus,
      lastDurationMs: s.lastDurationMs,
      lastError: s.lastError,
      runCount: s.runCount,
      consecutiveErrors: s.consecutiveErrors,
      lastDeliveryStatus: s.lastDeliveryStatus,
    })));

  } else if (path.match(/^\/api\/crons\/[^/]+\/runs$/) && req.method === "GET") {
    const name = decodeURIComponent(path.split("/")[3]);
    const limitParam = new URL(req.url!, "http://x").searchParams.get("limit");
    const limit = Math.min(500, Math.max(1, parseInt(limitParam || "50", 10) || 50));
    json(req, res, { runs: listCronRuns(name, limit) });

  } else if (path.match(/^\/api\/crons\/[^/]+\/run$/) && req.method === "POST") {
    const name = decodeURIComponent(path.split("/")[3]);
    const result = await triggerCronJob(name);
    json(req, res, result, result.ok ? 200 : 400);

  // --- SKILLS & PLUGINS ---
  } else if (path === "/api/skills" && req.method === "GET") {
    try {
      const pluginsPath = join(process.env.HOME || "", ".claude/plugins/installed_plugins.json");
      const settingsPath = join(process.env.HOME || "", ".claude", "settings.json");
      let plugins: any[] = [];
      let enabledPlugins: Record<string, boolean> = {};

      if (existsSync(settingsPath)) {
        try { enabledPlugins = JSON.parse(readFileSync(settingsPath, "utf-8")).enabledPlugins ?? {}; } catch {}
      }

      if (existsSync(pluginsPath)) {
        try {
          const raw = JSON.parse(readFileSync(pluginsPath, "utf-8"));
          for (const [name, installs] of Object.entries(raw.plugins ?? {})) {
            for (const inst of installs as any[]) {
              plugins.push({
                name,
                scope: inst.scope ?? "user",
                project: inst.projectPath ?? null,
                enabled: enabledPlugins[name] ?? false,
                installedAt: inst.installedAt ?? null,
              });
            }
          }
        } catch {}
      }

      // Helper: parse SKILL.md frontmatter using the YAML parser (handles block
      // scalars, lists, and single-line values uniformly). Falls back to empty
      // fields if the frontmatter is malformed.
      const parseSkillMd = (content: string) => {
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        let name = "", description = "", allowedTools: string[] = [];
        if (fmMatch) {
          try {
            const fm = parseYaml(fmMatch[1]) as Record<string, unknown>;
            name = typeof fm?.name === "string" ? fm.name.trim() : "";
            if (typeof fm?.description === "string") {
              description = fm.description.replace(/\s+/g, " ").trim();
            }
            const at = fm?.["allowed-tools"];
            if (Array.isArray(at)) {
              allowedTools = at.filter((x): x is string => typeof x === "string");
            }
          } catch { /* malformed YAML — leave fields empty */ }
        }
        const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
        return { name, description, allowedTools, body };
      };

      // Enumerate non-SKILL.md entries in the skill directory (scripts, rules, references, etc.)
      const listResources = (skillDir: string): string[] => {
        try {
          return readdirSync(skillDir, { withFileTypes: true })
            .filter((d) => d.name !== "SKILL.md" && !d.name.startsWith("."))
            .map((d) => d.name + (d.isDirectory() ? "/" : ""));
        } catch { return []; }
      };

      // Custom skills: scan both the legacy flat layout (~/.claude/<name>/SKILL.md)
      // and the canonical Claude Code layout (~/.claude/skills/<name>/SKILL.md).
      const customSkills: any[] = [];
      const claudeDir = join(process.env.HOME || "", ".claude");
      const scanSkillsIn = (baseDir: string) => {
        try {
          for (const entry of readdirSync(baseDir)) {
            if (entry === "plugins" || entry === "skills" || entry.startsWith(".")) continue;
            const skillPath = join(baseDir, entry, "SKILL.md");
            if (existsSync(skillPath)) {
              const content = readFileSync(skillPath, "utf-8");
              const parsed = parseSkillMd(content);
              const skillDir = join(baseDir, entry);
              let lastModified: string | null = null;
              try { lastModified = statSync(skillPath).mtime.toISOString(); } catch {}
              customSkills.push({
                name: parsed.name || entry,
                dirName: entry,
                path: skillDir,
                description: parsed.description,
                allowedTools: parsed.allowedTools,
                resources: listResources(skillDir),
                lastModified,
                content: content.length > 2000 ? content.slice(0, 2000) + "\n..." : content,
              });
            }
          }
        } catch {}
      };
      scanSkillsIn(claudeDir);
      scanSkillsIn(join(claudeDir, "skills"));

      // Local-path marketplaces registered via `claude plugin marketplace add <path>`:
      // their installLocation in known_marketplaces.json points at an external dir,
      // never copied to ~/.claude/plugins/marketplaces/. Scan them too.
      try {
        const kmPath = join(claudeDir, "plugins", "known_marketplaces.json");
        if (existsSync(kmPath)) {
          const km = JSON.parse(readFileSync(kmPath, "utf-8"));
          for (const entry of Object.values(km) as any[]) {
            const src = entry?.source;
            const loc = entry?.installLocation;
            if (src?.source === "directory" && typeof loc === "string" && existsSync(loc)) {
              scanSkillsIn(join(loc, "skills"));
            }
          }
        }
      } catch {}

      // Plugin skills (SKILL.md in ~/.claude/plugins/marketplaces/*/plugins/*/skills/*)
      const pluginSkills: any[] = [];
      const marketplacesDir = join(claudeDir, "plugins", "marketplaces");
      try {
        if (existsSync(marketplacesDir)) {
          for (const marketplace of readdirSync(marketplacesDir)) {
            const mpDir = join(marketplacesDir, marketplace, "plugins");
            if (!existsSync(mpDir)) continue;
            for (const pluginDir of readdirSync(mpDir)) {
              const skillsDir = join(mpDir, pluginDir, "skills");
              if (!existsSync(skillsDir)) continue;
              try {
                for (const skillDir of readdirSync(skillsDir)) {
                  const skillMdPath = join(skillsDir, skillDir, "SKILL.md");
                  if (!existsSync(skillMdPath)) continue;
                  const content = readFileSync(skillMdPath, "utf-8");
                  const parsed = parseSkillMd(content);
                  let lastModified: string | null = null;
                  try { lastModified = statSync(skillMdPath).mtime.toISOString(); } catch {}
                  pluginSkills.push({
                    name: parsed.name || skillDir,
                    plugin: `${pluginDir}@${marketplace}`,
                    pluginName: pluginDir,
                    description: parsed.description,
                    allowedTools: parsed.allowedTools,
                    resources: listResources(join(skillsDir, skillDir)),
                    lastModified,
                    content: content.length > 2000 ? content.slice(0, 2000) + "\n..." : content,
                    path: skillMdPath,
                  });
                }
              } catch {}
            }
          }
        }
      } catch {}

      json(req, res, { plugins, customSkills, pluginSkills });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- SKILL CONTENT GET/PUT ---
  } else if (path.match(/^\/api\/skills\/[^/]+\/content$/) && (req.method === "GET" || req.method === "PUT")) {
    const skillName = decodeURIComponent(path.split("/")[3]);
    const claudeDir = join(process.env.HOME || "", ".claude");
    const flatPath = join(claudeDir, skillName, "SKILL.md");
    const nestedPath = join(claudeDir, "skills", skillName, "SKILL.md");

    // Also consider local-path marketplaces registered via known_marketplaces.json
    const marketplacePaths: string[] = [];
    try {
      const kmPath = join(claudeDir, "plugins", "known_marketplaces.json");
      if (existsSync(kmPath)) {
        const km = JSON.parse(readFileSync(kmPath, "utf-8"));
        for (const entry of Object.values(km) as any[]) {
          const src = entry?.source;
          const loc = entry?.installLocation;
          if (src?.source === "directory" && typeof loc === "string") {
            marketplacePaths.push(join(loc, "skills", skillName, "SKILL.md"));
          }
        }
      }
    } catch {}

    const skillPath = existsSync(flatPath)
      ? flatPath
      : existsSync(nestedPath)
        ? nestedPath
        : marketplacePaths.find((p) => existsSync(p)) || nestedPath;
    if (req.method === "GET") {
      try {
        if (!existsSync(skillPath)) { json(req, res, { error: "not found" }, 404); return; }
        json(req, res, { content: readFileSync(skillPath, "utf-8") });
      } catch (e: any) { json(req, res, { error: e.message }, 500); }
    } else {
      try {
        const body = await parseBody(req);
        if (!body.content && body.content !== "") { json(req, res, { error: "content required" }, 400); return; }
        writeFileSync(skillPath, body.content, "utf-8");
        json(req, res, { ok: true });
      } catch (e: any) { json(req, res, { error: e.message }, 500); }
    }

  // --- PLUGIN ENABLE/DISABLE ---
  } else if (path.match(/^\/api\/plugins\/[^/]+\/toggle$/) && req.method === "POST") {
    try {
      const pluginName = decodeURIComponent(path.split("/")[3]);
      const settingsPath = join(process.env.HOME || "", ".claude", "settings.json");
      if (!existsSync(settingsPath)) { json(req, res, { error: "settings.json not found" }, 404); return; }
      const raw = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw);
      settings.enabledPlugins = settings.enabledPlugins || {};
      const next = !settings.enabledPlugins[pluginName];
      settings.enabledPlugins[pluginName] = next;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      json(req, res, { ok: true, plugin: pluginName, enabled: next });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- MCP SERVER STATUS (runs `claude mcp list`) ---
  } else if (path === "/api/mcp-status" && req.method === "GET") {
    try {
      const { execFile } = await import("child_process");
      const cli = resolveCliPath();
      const out: string = await new Promise((resolve, reject) => {
        execFile(cli, ["mcp", "list"], { timeout: 15000 }, (err, stdout, stderr) => {
          if (err && !stdout) reject(new Error(stderr || err.message));
          else resolve(stdout);
        });
      });
      // Parse lines like: "name: target - ✓ Connected" / "- ! Needs authentication" / "- ✗ Failed"
      // Name may contain colons (e.g. "plugin:playwright:playwright"), so split from the right.
      const servers = out.split("\n")
        .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim()) // strip ANSI
        .map((l) => {
          const m = l.match(/^(.+?)\s+-\s+([✓✗!])\s+(.*)$/);
          if (!m) return null;
          const [, head, icon, statusText] = m;
          // Separator is the FIRST ": " (colon + space) — names may contain colons
          // (e.g. "plugin:playwright:playwright") and targets may be URLs ("https://...").
          const splitIdx = head.indexOf(": ");
          if (splitIdx < 0) return null;
          const name = head.slice(0, splitIdx).trim();
          const target = head.slice(splitIdx + 2).trim();
          if (!name) return null;
          const status = icon === "✓" ? "connected" : icon === "!" ? "auth" : "failed";
          return { name, target, status, statusText: statusText.trim() };
        })
        .filter(Boolean);
      json(req, res, { servers });
    } catch (e: any) { json(req, res, { error: e.message, servers: [] }, 200); }

  // --- ROUTES GET --- (thin matchers referencing agents by name)
  } else if (path === "/api/routes" && req.method === "GET") {
    try {
      const raw = readRawConfig();
      const registry = getAgentRegistry();
      const routes = (raw.routes || []).map((r: any, i: number) => {
        const agent = r.use ? registry[r.use] : undefined;
        return {
          index: i,
          channel: r.match?.channel ?? "*",
          from: r.match?.from ?? "*",
          group: r.match?.group ?? null,
          guild: r.match?.guild ?? null,
          jid: r.match?.jid ?? null,
          use: r.use ?? null,
          action: r.action ?? "route",
          agent: agent ? {
            name: agent.name,
            workspace: agent.workspace,
            model: agent.model ?? "default",
            fallbacks: agent.fallbacks ?? [],
            tools: agent.tools ?? [],
            effort: agent.effort ?? null,
            fullAccess: agent.fullAccess === true,
            inheritUserScope: agent.inheritUserScope !== false,
          } : null,
        };
      });
      json(req, res, routes);
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- SETTINGS GET ---
  } else if (path === "/api/settings" && req.method === "GET") {
    try {
      const settingsPath = join(process.env.HOME || "", ".claude", "settings.json");
      const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {};
      json(req, res, {
        hooks: settings.hooks || {},
        mcpServers: settings.mcpServers || {},
        plugins: settings.plugins || {},
      });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- CALLERS ---
  } else if (path === "/api/config/callers" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      if (!body.phone) { json(req, res, { error: "phone required" }, 400); return; }
      const raw = readRawConfig();
      if (!raw.jarvis) raw.jarvis = {};
      if (!raw.jarvis.allowedCallers) raw.jarvis.allowedCallers = [];
      if (!raw.jarvis.allowedCallers.includes(body.phone)) {
        raw.jarvis.allowedCallers.push(body.phone);
      }
      await writeRawConfig(raw);
      invalidateHtmlCache();
      log.info("[dashboard] Added caller: %s", body.phone);
      json(req, res, { ok: true, callers: raw.jarvis.allowedCallers });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path.startsWith("/api/config/callers/") && req.method === "DELETE") {
    if (!requireConfirm(req, res)) return;
    try {
      const phone = decodeURIComponent(path.slice("/api/config/callers/".length));
      const raw = readRawConfig();
      if (raw.jarvis?.allowedCallers) {
        raw.jarvis.allowedCallers = raw.jarvis.allowedCallers.filter((c: string) => c !== phone);
      }
      await writeRawConfig(raw);
      invalidateHtmlCache();
      log.info("[dashboard] Removed caller: %s", phone);
      json(req, res, { ok: true, callers: raw.jarvis?.allowedCallers ?? [] });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- ALWAYS REPLY GROUPS ---
  } else if (path === "/api/config/always-reply" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      if (!body.group) { json(req, res, { error: "group required" }, 400); return; }
      const raw = readRawConfig();
      if (!raw.jarvis) raw.jarvis = {};
      if (!raw.jarvis.alwaysReplyGroups) raw.jarvis.alwaysReplyGroups = [];
      if (!raw.jarvis.alwaysReplyGroups.includes(body.group)) {
        raw.jarvis.alwaysReplyGroups.push(body.group);
      }
      await writeRawConfig(raw);
      invalidateHtmlCache();
      log.info("[dashboard] Added always-reply group: %s", body.group);
      json(req, res, { ok: true, groups: raw.jarvis.alwaysReplyGroups });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path.startsWith("/api/config/always-reply/") && req.method === "DELETE") {
    if (!requireConfirm(req, res)) return;
    try {
      const group = decodeURIComponent(path.slice("/api/config/always-reply/".length));
      const raw = readRawConfig();
      if (raw.jarvis?.alwaysReplyGroups) {
        raw.jarvis.alwaysReplyGroups = raw.jarvis.alwaysReplyGroups.filter((g: string) => g !== group);
      }
      await writeRawConfig(raw);
      invalidateHtmlCache();
      log.info("[dashboard] Removed always-reply group: %s", group);
      json(req, res, { ok: true, groups: raw.jarvis?.alwaysReplyGroups ?? [] });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- ROUTES POST (create thin route) ---
  } else if (path === "/api/routes/full" && req.method === "GET") {
    try {
      const routes = getRoutesData();
      json(req, res, routes);
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path === "/api/routes" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const raw = readRawConfig();
      const route: any = { match: { channel: body.channel || "whatsapp" } };
      if (body.from) route.match.from = body.from;
      if (body.group) route.match.group = body.group;
      if (body.jid) route.match.jid = body.jid;
      if (body.action === "ignore") {
        route.action = "ignore";
      } else {
        const use = String(body.use || "").trim();
        if (!use) { json(req, res, { error: "`use` (agent name) required" }, 400); return; }
        if (!getAgentRegistry()[use]) { json(req, res, { error: `agent not found: ${use}` }, 400); return; }
        route.use = use;
      }
      raw.routes.push(route);
      await writeRawConfig(raw);
      invalidateHtmlCache();
      log.info("[dashboard] Added route using agent %s", route.use || "(ignored)");
      json(req, res, { ok: true, routes: raw.routes.length });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- ROUTE PUT (edit match + use + action) ---
  } else if (path.match(/^\/api\/routes\/\d+$/) && req.method === "PUT") {
    try {
      const idx = parseInt(path.split("/").pop()!, 10);
      const body = await parseBody(req);
      const raw = readRawConfig();
      if (idx < 0 || idx >= raw.routes.length) { json(req, res, { error: "invalid index" }, 400); return; }
      const route = raw.routes[idx];
      if (body.channel) route.match.channel = body.channel;
      if (body.from !== undefined) {
        if (body.from === null || body.from === "") delete route.match.from;
        else route.match.from = body.from;
      }
      if (body.group !== undefined) {
        if (body.group === null || body.group === "") delete route.match.group;
        else route.match.group = body.group;
      }
      if (body.jid !== undefined) {
        if (body.jid === null || body.jid === "") delete route.match.jid;
        else route.match.jid = body.jid;
      }
      if (body.action === "ignore") {
        route.action = "ignore";
        delete route.use;
      } else if (body.use !== undefined) {
        const use = String(body.use || "").trim();
        if (!use) { json(req, res, { error: "`use` cannot be empty" }, 400); return; }
        if (!getAgentRegistry()[use]) { json(req, res, { error: `agent not found: ${use}` }, 400); return; }
        route.use = use;
        delete route.action;
      }
      await writeRawConfig(raw);
      invalidateHtmlCache();
      log.info("[dashboard] Updated route %d", idx);
      json(req, res, { ok: true });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path.match(/^\/api\/routes\/\d+$/) && req.method === "DELETE") {
    if (!requireConfirm(req, res)) return;
    try {
      const idx = parseInt(path.split("/").pop()!, 10);
      const raw = readRawConfig();
      if (idx < 0 || idx >= raw.routes.length) { json(req, res, { error: "invalid index" }, 400); return; }
      raw.routes.splice(idx, 1);
      await writeRawConfig(raw);
      invalidateHtmlCache();
      log.info("[dashboard] Deleted route %d", idx);
      json(req, res, { ok: true });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- AGENT REGISTRY (from agents/*/agent.yaml) ---
  } else if (path === "/api/agents" && req.method === "GET") {
    try {
      const registry = getAgentRegistry();
      const raw = readRawConfig();
      const usedBy: Record<string, string[]> = {};
      (raw.routes || []).forEach((r: any, i: number) => {
        if (!r.use) return;
        (usedBy[r.use] ||= []).push(
          `${r.match?.channel ?? "*"}:${r.match?.from ?? r.match?.group ?? r.match?.jid ?? "*"} (#${i})`,
        );
      });
      const agents = Object.values(registry).map(a => ({
        name: a.name,
        workspace: a.workspace,
        model: a.model ?? null,
        tools: a.tools ?? [],
        fallbacks: a.fallbacks ?? [],
        effort: a.effort ?? null,
        fullAccess: a.fullAccess === true,
        inheritUserScope: a.inheritUserScope !== false,
        usedBy: usedBy[a.name!] ?? [],
      }));
      json(req, res, agents);
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- AGENT YAML EDIT (model, tools, fallbacks, effort, fullAccess, inheritUserScope) ---
  } else if (path.match(/^\/api\/agents\/[^/]+\/config$/) && req.method === "PUT") {
    const agentName = decodeURIComponent(path.split("/")[3]);
    if (!validateAgentName(agentName)) { json(req, res, { error: "invalid agent name" }, 400); return; }
    try {
      const body = await parseBody(req);
      const yamlPath = join(HOME, ".claude/jarvis/agents", agentName, "agent.yaml");
      const existing = existsSync(yamlPath) ? (parseYaml(readFileSync(yamlPath, "utf-8")) ?? {}) : {};

      if (body.model !== undefined) existing.model = body.model || undefined;
      if (body.effort !== undefined) {
        if (body.effort) existing.effort = body.effort;
        else delete existing.effort;
      }
      if (body.fallbacks !== undefined) {
        const arr = Array.isArray(body.fallbacks)
          ? body.fallbacks
          : String(body.fallbacks).split(",").map((s: string) => s.trim()).filter(Boolean);
        if (arr.length) existing.fallbacks = arr;
        else delete existing.fallbacks;
      }
      if (body.fullAccess !== undefined) {
        if (body.fullAccess === true) {
          existing.fullAccess = true;
          delete existing.tools;
        } else {
          delete existing.fullAccess;
        }
      }
      if (body.tools !== undefined && existing.fullAccess !== true) {
        existing.tools = Array.isArray(body.tools) ? body.tools : [];
      }
      if (body.inheritUserScope !== undefined) {
        // Default is true; only persist when explicitly false.
        if (body.inheritUserScope === false) existing.inheritUserScope = false;
        else delete existing.inheritUserScope;
      }

      for (const k of Object.keys(existing)) if (existing[k] === undefined) delete existing[k];

      writeFileSync(yamlPath, stringifyYaml(existing, { lineWidth: 120 }), "utf-8");
      await reloadConfig();
      invalidateHtmlCache();
      log.info("[dashboard] Updated agent.yaml for %s", agentName);
      json(req, res, { ok: true });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- AGENT SCOPE TOGGLE (adds/removes an @import line in CLAUDE.md) ---
  } else if (path.match(/^\/api\/agents\/[^/]+\/scope$/) && req.method === "PATCH") {
    const agentName = decodeURIComponent(path.split("/")[3]);
    if (!validateAgentName(agentName)) { json(req, res, { error: "invalid agent name" }, 400); return; }
    try {
      const body = await parseBody(req);
      const importPath = String(body.import || "").trim();
      const enable = body.enable === true || body.enable === "true";
      if (!importPath) { json(req, res, { error: "`import` path required" }, 400); return; }
      if (!importPath.endsWith(".md")) { json(req, res, { error: "import must be a .md file" }, 400); return; }
      const allowedPrefixes = ["~/.claude/jarvis/agents/_shared/", `~/.claude/jarvis/agents/${agentName}/`, "~/.claude/jarvis/memory/"];
      if (!allowedPrefixes.some(p => importPath.startsWith(p))) {
        json(req, res, { error: "import path outside allowed roots" }, 400); return;
      }
      const claudePath = join(HOME, ".claude/jarvis/agents", agentName, "CLAUDE.md");
      if (!existsSync(claudePath)) { json(req, res, { error: "CLAUDE.md not found" }, 404); return; }
      const original = readFileSync(claudePath, "utf-8");

      const lines = original.split("\n");
      const importLines = new Set<string>();
      const rest: string[] = [];
      let headerLines: string[] = [];
      let seenNonImport = false;
      for (const ln of lines) {
        if (/^@/.test(ln.trim())) {
          importLines.add(ln.trim());
        } else if (!seenNonImport && /^#/.test(ln.trim())) {
          headerLines.push(ln);
        } else if (!seenNonImport && ln.trim() === "") {
          headerLines.push(ln);
        } else {
          seenNonImport = true;
          rest.push(ln);
        }
      }

      const importLine = `@${importPath}`;
      if (enable) importLines.add(importLine);
      else importLines.delete(importLine);

      const sharedOrder = ["SOUL.md", "AGENTS.md", "TOOLS.md"];
      const sorted = Array.from(importLines).sort((a, b) => {
        const rank = (s: string) => s.includes("_shared/") ? 0 : s.includes(`/${agentName}/`) ? 1 : 2;
        const ra = rank(a), rb = rank(b);
        if (ra !== rb) return ra - rb;
        if (ra === 0) {
          const sharedIdx = (s: string) => {
            for (let i = 0; i < sharedOrder.length; i++) if (s.endsWith("/" + sharedOrder[i])) return i;
            return 999;
          };
          return sharedIdx(a) - sharedIdx(b);
        }
        return a.localeCompare(b);
      });

      while (headerLines.length && headerLines[headerLines.length - 1].trim() === "") headerLines.pop();
      while (rest.length && rest[0].trim() === "") rest.shift();

      const pieces: string[] = [];
      if (headerLines.length) pieces.push(headerLines.join("\n"));
      if (sorted.length) pieces.push(sorted.join("\n"));
      if (rest.length) pieces.push(rest.join("\n"));
      const out = pieces.join("\n\n") + (original.endsWith("\n") ? "\n" : "");

      writeFileSync(claudePath, out, "utf-8");
      invalidateHtmlCache();
      log.info("[dashboard] Scope %s: %s @%s", enable ? "added" : "removed", agentName, importPath);
      json(req, res, { ok: true, imports: sorted });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- AGENT TOOLS PATCH (add/remove/replace granular tools) ---
  } else if (path.match(/^\/api\/agents\/[^/]+\/tools$/) && req.method === "PATCH") {
    const agentName = decodeURIComponent(path.split("/")[3]);
    if (!validateAgentName(agentName)) { json(req, res, { error: "invalid agent name" }, 400); return; }
    try {
      const body = await parseBody(req);
      const yamlPath = join(HOME, ".claude/jarvis/agents", agentName, "agent.yaml");
      if (!existsSync(yamlPath)) { json(req, res, { error: "agent.yaml not found" }, 404); return; }
      const existing = parseYaml(readFileSync(yamlPath, "utf-8")) ?? {};
      if (existing.fullAccess) { json(req, res, { error: "agent has fullAccess; tools list is ignored" }, 400); return; }
      existing.tools = Array.isArray(existing.tools) ? existing.tools : [];
      if (body.addTool && !existing.tools.includes(body.addTool)) existing.tools.push(body.addTool);
      if (body.removeTool) existing.tools = existing.tools.filter((t: string) => t !== body.removeTool);
      if (Array.isArray(body.tools)) existing.tools = body.tools;
      writeFileSync(yamlPath, stringifyYaml(existing, { lineWidth: 120 }), "utf-8");
      await reloadConfig();
      invalidateHtmlCache();
      log.info("[dashboard] Patched tools for agent %s", agentName);
      json(req, res, { ok: true, tools: existing.tools });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- AGENT CLAUDE.MD ---
  } else if (path.match(/^\/api\/agents\/[^/]+\/claude-md$/) && req.method === "PUT") {
    const agentName = decodeURIComponent(path.split("/")[3]);
    if (!validateAgentName(agentName)) { json(req, res, { error: "invalid agent name" }, 400); return; }
    try {
      const body = await parseBody(req);
      const claudePath = join(HOME, ".claude/jarvis/agents", agentName, "CLAUDE.md");
      writeFileSync(claudePath, body.content ?? "", "utf-8");
      invalidateHtmlCache();
      log.info("[dashboard] Saved CLAUDE.md for agent: %s", agentName);
      json(req, res, { ok: true });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path.match(/^\/api\/agents\/[^/]+\/claude-md$/) && req.method === "GET") {
    const agentName = decodeURIComponent(path.split("/")[3]);
    if (!validateAgentName(agentName)) { json(req, res, { error: "invalid agent name" }, 400); return; }
    try {
      const claudePath = join(HOME, ".claude/jarvis/agents", agentName, "CLAUDE.md");
      const content = safeReadFile(claudePath) ?? "";
      json(req, res, { content });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- GLOBAL CLAUDE.MD ---
  } else if (path === "/api/config/global-claude-md" && req.method === "PUT") {
    if (!requireConfirm(req, res)) return;
    try {
      const body = await parseBody(req);
      const claudePath = join(HOME, ".claude/CLAUDE.md");
      writeFileSync(claudePath, body.content ?? "", "utf-8");
      invalidateHtmlCache();
      log.info("[dashboard] Saved global CLAUDE.md");
      json(req, res, { ok: true });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path === "/api/config/yaml" && req.method === "PUT") {
    if (!requireConfirm(req, res)) return;
    try {
      const body = await parseBody(req);
      const content = String(body.content ?? "");
      parseYaml(content);
      writeFileSync(join(HOME, ".claude/jarvis/router/config.yaml"), content, "utf-8");
      await reloadConfig();
      invalidateHtmlCache();
      log.info("[dashboard] Saved config.yaml from editor");
      json(req, res, { ok: true });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path === "/api/config/global-claude-md" && req.method === "GET") {
    try {
      const content = safeReadFile(join(HOME, ".claude/CLAUDE.md")) ?? "";
      json(req, res, { content });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- MEMORY APIs ---
  } else if (path.startsWith("/api/memory/search") && req.method === "GET") {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    const q = reqUrl.searchParams.get("q") || "";
    const scope = reqUrl.searchParams.get("scope") || undefined;
    const limit = parseInt(reqUrl.searchParams.get("limit") || "5");
    if (!q) { json(req, res, { error: "q required" }, 400); return; }
    try {
      const [docRes, memRes] = await Promise.all([
        searchDocsDetailed(q, scope, limit),
        searchMemoriesDetailed(q, scope, limit),
      ]);
      const partial: string[] = [];
      if (docRes.timedOut) partial.push("docs");
      if (memRes.timedOut) partial.push("memories");
      json(req, res, {
        docs: docRes.results,
        memories: memRes.results,
        ...(partial.length ? { partial } : {}),
      });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path.startsWith("/api/memory/stats") && req.method === "GET") {
    try {
      const stats = await getMemoryStats();
      json(req, res, stats);
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path.startsWith("/api/memory/documents") && req.method === "GET") {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    const scope = reqUrl.searchParams.get("scope") || undefined;
    try {
      const docs = await getDocuments(scope);
      json(req, res, { documents: docs });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path.startsWith("/api/memory/memories") && req.method === "GET") {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    const scope = reqUrl.searchParams.get("scope") || undefined;
    try {
      const mems = await getMemories(scope);
      json(req, res, { memories: mems });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path === "/api/memory/reindex" && req.method === "POST") {
    try {
      const result = await reindexDocs();
      json(req, res, result);
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // -- Filesystem memory graph (~/.claude/jarvis/memory) --
  } else if (path === "/api/memory/files" && req.method === "GET") {
    try {
      const root = join(HOME, ".claude/jarvis/memory");
      const files = walkMemoryDir(root);
      json(req, res, { root, files });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path === "/api/memory/file" && req.method === "GET") {
    try {
      const reqUrl = new URL(req.url ?? "/", "http://localhost");
      const rel = reqUrl.searchParams.get("path") || "";
      const root = join(HOME, ".claude/jarvis/memory");
      const abs = join(root, rel);
      if (!abs.startsWith(root)) { json(req, res, { error: "invalid path" }, 400); return; }
      if (!existsSync(abs)) { json(req, res, { error: "not found" }, 404); return; }
      const content = readFileSync(abs, "utf-8");
      json(req, res, { path: rel, content, size: content.length });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path === "/api/memory/file" && req.method === "PUT") {
    if (!requireConfirm(req, res)) return;
    try {
      const body = await parseBody(req);
      const rel = String(body.path || "");
      const root = join(HOME, ".claude/jarvis/memory");
      const abs = join(root, rel);
      if (!abs.startsWith(root)) { json(req, res, { error: "invalid path" }, 400); return; }
      const dir = abs.split("/").slice(0, -1).join("/");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(abs, body.content ?? "", "utf-8");
      log.info("[dashboard] Saved memory file %s", rel);
      scheduleReindex(`PUT ${rel}`);
      invalidateGraphCache();
      json(req, res, { ok: true });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path === "/api/memory/doctor" && req.method === "GET") {
    try {
      const root = join(HOME, ".claude/jarvis/memory");
      const files = walkMemoryDir(root);
      const TINY_BYTES = 120;
      // Duplicate basenames across folders.
      // Skip legitimate per-project scaffolding files (e.g. projects/<slug>/overview.md)
      // — those are expected siblings inside different project folders.
      const byName = new Map<string, string[]>();
      for (const f of files) {
        const arr = byName.get(f.name) || [];
        arr.push(f.path); byName.set(f.name, arr);
      }
      const SCAFFOLD_NAMES = new Set(["overview.md", "README.md", "notes.md", "todo.md"]);
      const duplicateNames = [...byName.entries()]
        .filter(([name, paths]) => {
          if (paths.length < 2) return false;
          if (SCAFFOLD_NAMES.has(name)) {
            // Only flag if any two paths share the same parent (real collision, not per-project scaffolding)
            const parents = new Set(paths.map((p) => p.split("/").slice(0, -1).join("/")));
            return parents.size < paths.length;
          }
          return true;
        })
        .map(([name, paths]) => ({ name, paths }));
      // Tiny files: only flag if small AND lacking structure (no body beyond title).
      // Small-but-complete contact cards or lists stay clear.
      const tinyFiles = files.filter((f) => {
        if (f.size >= TINY_BYTES) return false;
        try {
          const content = readFileSync(join(root, f.path), "utf-8");
          const bodyLines = content.split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("#") && !l.startsWith("---") && !l.startsWith("*Ultimo"));
          return bodyLines.length < 2;
        } catch { return true; }
      }).map((f) => ({ path: f.path, size: f.size }));
      // Orphans: nodes with zero edges in the current graph
      let orphans: string[] = [];
      try {
        const graphRes = await fetch(`http://localhost:${process.env.JARVIS_PORT || 3340}/api/memory/graph`).then((r) => r.json()).catch(() => null);
        if (graphRes?.nodes && graphRes?.edges) {
          const linked = new Set<string>();
          for (const e of graphRes.edges) { linked.add(e.source); linked.add(e.target); }
          orphans = graphRes.nodes.filter((n: any) => !linked.has(n.id)).map((n: any) => n.id);
        }
      } catch { /* graph compute failure — non-fatal for doctor */ }
      // Daily-date collisions: same YYYY-MM-DD in root and daily/
      const dateRe = /^(\d{4}-\d{2}-\d{2})\.md$/;
      const dailyDates = new Map<string, string[]>();
      for (const f of files) {
        const m = f.name.match(dateRe);
        if (!m) continue;
        const d = m[1];
        const arr = dailyDates.get(d) || [];
        arr.push(f.path); dailyDates.set(d, arr);
      }
      const dailyCollisions = [...dailyDates.entries()]
        .filter(([, paths]) => paths.length > 1)
        .map(([date, paths]) => ({ date, paths }));
      const issueCount = duplicateNames.length + tinyFiles.length + orphans.length + dailyCollisions.length;
      json(req, res, {
        totalFiles: files.length,
        issueCount,
        duplicateNames,
        tinyFiles,
        orphans,
        dailyCollisions,
      });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path === "/api/memory/graph" && req.method === "GET") {
    try {
      const now = Date.now();
      if (_graphCache && now - _graphCache.at < GRAPH_CACHE_TTL_MS) {
        json(req, res, _graphCache.payload);
        return;
      }
      const root = join(HOME, ".claude/jarvis/memory");
      const files = walkMemoryDir(root);
      const nodes = files.map((f) => ({
        id: f.path,
        label: f.name.replace(/\.md$/, ""),
        category: f.category,
        size: f.size,
      }));
      const idSet = new Set(nodes.map((n) => n.id));
      const edges: Array<{ source: string; target: string }> = [];
      const patterns = [
        /\bmemory\/([\w\-./]+\.md)/g,
        /\]\(\.?\/?([\w\-./]+\.md)\)/g,
        /\[\[([\w\- .]+)\]\]/g,
        /~\/\.claude\/jarvis\/memory\/([\w\-./]+\.md)/g,
      ];
      // Index labels → all nodes sharing that label (for deterministic disambiguation)
      const labelIndex = new Map<string, typeof nodes>();
      for (const n of nodes) {
        const k = n.label.toLowerCase();
        const arr = labelIndex.get(k) || [];
        arr.push(n); labelIndex.set(k, arr);
      }
      for (const f of files) {
        try {
          const content = readFileSync(join(root, f.path), "utf-8");
          const sourceDir = f.path.includes("/") ? f.path.split("/").slice(0, -1).join("/") : "";
          const sourceCat = f.category;
          for (const re of patterns) {
            for (const match of content.matchAll(re)) {
              const target = match[1];
              // 1. Exact path hit
              if (idSet.has(target)) { edges.push({ source: f.path, target }); continue; }
              // 2. Same-dir relative
              const rel = (sourceDir ? sourceDir + "/" : "") + target;
              if (idSet.has(rel)) { edges.push({ source: f.path, target: rel }); continue; }
              // 3. Wikilink / label: resolve with precedence
              //    a) same sub-directory, b) same category, c) unique global, d) warn if ambiguous
              const candidates = labelIndex.get(target.toLowerCase()) || [];
              if (candidates.length === 0) continue;
              let chosen = candidates.find((n) => n.id.startsWith((sourceDir ? sourceDir + "/" : "")) && n.id !== f.path);
              if (!chosen) chosen = candidates.find((n) => n.category === sourceCat && n.id !== f.path);
              if (!chosen && candidates.length === 1) chosen = candidates[0];
              if (!chosen) {
                // Ambiguous: pick by stable sort (lexicographic path) to at least be deterministic
                chosen = candidates.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
                log.warn("[memory/graph] wikilink '%s' from %s is ambiguous: %o", target, f.path, candidates.map((c) => c.id));
              }
              if (chosen) edges.push({ source: f.path, target: chosen.id });
            }
          }
        } catch { /* skip unreadable files */ }
      }
      // ── Keyword edges: connect files that mention a project/person/tool by name ──
      const nameIndex = new Map<string, string>();
      for (const n of nodes) {
        if (n.category === "projects" || n.category === "people" || n.category === "tools") {
          const key = n.label.toLowerCase().replace(/[-_]/g, " ");
          if (key.length > 3) nameIndex.set(key, n.id);
        }
      }
      const edgeSet = new Set(edges.map(e => e.source + "\u2192" + e.target));
      for (const f of files) {
        try {
          const content = readFileSync(join(root, f.path), "utf-8").toLowerCase();
          for (const [keyword, targetId] of nameIndex) {
            if (targetId === f.path) continue;
            if (content.includes(keyword)) {
              const key = f.path + "\u2192" + targetId;
              const rev = targetId + "\u2192" + f.path;
              if (!edgeSet.has(key) && !edgeSet.has(rev)) {
                edges.push({ source: f.path, target: targetId });
                edgeSet.add(key);
              }
            }
          }
        } catch { /* skip */ }
      }

      // ── Sub-folder edges: connect files in same subfolder (e.g. projects/*.md, daily/*.md) ──
      for (const n of nodes) {
        const parts = n.id.split("/");
        if (parts.length >= 2) {
          const siblings = nodes.filter(o => o.id !== n.id && o.id.startsWith(parts.slice(0, -1).join("/") + "/"));
          for (const s of siblings) {
            const key = n.id + "\u2192" + s.id;
            const rev = s.id + "\u2192" + n.id;
            if (!edgeSet.has(key) && !edgeSet.has(rev)) {
              edges.push({ source: n.id, target: s.id });
              edgeSet.add(key);
            }
          }
        }
      }

      const payload = { nodes, edges };
      _graphCache = { at: Date.now(), payload };
      json(req, res, payload);
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path === "/api/memory/file" && req.method === "DELETE") {
    if (!requireConfirm(req, res)) return;
    try {
      const reqUrl = new URL(req.url ?? "/", "http://localhost");
      const rel = reqUrl.searchParams.get("path") || "";
      const root = join(HOME, ".claude/jarvis/memory");
      const abs = join(root, rel);
      if (!abs.startsWith(root) || !rel) { json(req, res, { error: "invalid path" }, 400); return; }
      if (!existsSync(abs)) { json(req, res, { error: "not found" }, 404); return; }
      const { unlinkSync } = await import("fs");
      unlinkSync(abs);
      log.info("[dashboard] Deleted memory file %s", rel);
      scheduleReindex(`DELETE ${rel}`);
      invalidateGraphCache();
      json(req, res, { ok: true, path: rel });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path.startsWith("/api/memory/") && req.method === "DELETE") {
    if (!requireConfirm(req, res)) return;
    const id = decodeURIComponent(path.slice("/api/memory/".length));
    try {
      const ok = await deleteMemory(id);
      json(req, res, { ok, id });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // -- Agent file CRUD (read/edit files inside ~/.claude/jarvis/agents/<name>/) --
  } else if (path === "/api/agents/file" && req.method === "GET") {
    try {
      const reqUrl = new URL(req.url ?? "/", "http://localhost");
      const agentName = (reqUrl.searchParams.get("name") || "").replace(/[^a-zA-Z0-9_-]/g, "");
      const fileName = (reqUrl.searchParams.get("file") || "").replace(/[^a-zA-Z0-9._-]/g, "");
      if (!agentName || !fileName) { json(req, res, { error: "name and file required" }, 400); return; }
      if (agentName.startsWith("_") || agentName.startsWith(".")) { json(req, res, { error: "invalid name" }, 400); return; }
      const abs = join(HOME, ".claude/jarvis/agents", agentName, fileName);
      if (!existsSync(abs)) { json(req, res, { error: "not found" }, 404); return; }
      json(req, res, { agent: agentName, file: fileName, content: readFileSync(abs, "utf-8") });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path === "/api/agents/file" && req.method === "PUT") {
    if (!requireConfirm(req, res)) return;
    try {
      const body = await parseBody(req);
      const agentName = String(body.name || "").replace(/[^a-zA-Z0-9_-]/g, "");
      const fileName = String(body.file || "").replace(/[^a-zA-Z0-9._-]/g, "");
      if (!agentName || !fileName) { json(req, res, { error: "name and file required" }, 400); return; }
      if (agentName.startsWith("_") || agentName.startsWith(".")) { json(req, res, { error: "invalid name" }, 400); return; }
      const abs = join(HOME, ".claude/jarvis/agents", agentName, fileName);
      writeFileSync(abs, body.content ?? "", "utf-8");
      invalidateHtmlCache();
      log.info("[dashboard] Saved agent file %s/%s", agentName, fileName);
      json(req, res, { ok: true });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // -- Shared files CRUD (~/.claude/jarvis/agents/_shared/) --
  } else if (path === "/api/shared/files" && req.method === "GET") {
    try {
      const dir = join(HOME, ".claude/jarvis/agents/_shared");
      const files: Array<{ name: string; size: number }> = [];
      if (existsSync(dir)) {
        for (const entry of readdirSync(dir)) {
          if (!entry.endsWith(".md")) continue;
          try {
            const st = statSync(join(dir, entry));
            if (st.isFile()) files.push({ name: entry, size: st.size });
          } catch { /* skip */ }
        }
      }
      files.sort((a, b) => a.name.localeCompare(b.name));
      json(req, res, { files });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path === "/api/shared/file" && req.method === "GET") {
    try {
      const reqUrl = new URL(req.url ?? "/", "http://localhost");
      const fileName = (reqUrl.searchParams.get("file") || "").replace(/[^a-zA-Z0-9._-]/g, "");
      if (!fileName) { json(req, res, { error: "file required" }, 400); return; }
      const abs = join(HOME, ".claude/jarvis/agents/_shared", fileName);
      if (!existsSync(abs)) { json(req, res, { error: "not found" }, 404); return; }
      json(req, res, { file: fileName, content: readFileSync(abs, "utf-8") });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path === "/api/shared/file" && req.method === "PUT") {
    if (!requireConfirm(req, res)) return;
    try {
      const body = await parseBody(req);
      const fileName = String(body.file || "").replace(/[^a-zA-Z0-9._-]/g, "");
      if (!fileName) { json(req, res, { error: "file required" }, 400); return; }
      const abs = join(HOME, ".claude/jarvis/agents/_shared", fileName);
      const dir = join(HOME, ".claude/jarvis/agents/_shared");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(abs, body.content ?? "", "utf-8");
      invalidateHtmlCache();
      log.info("[dashboard] Saved shared file %s", fileName);
      json(req, res, { ok: true });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path === "/api/services") {
    const services = getAllServices();
    const httpMod = await import("http");
    const httpsMod = await import("https");
    const results = await Promise.all(services.map(async (svc) => {
      try {
        const mod = svc.healthUrl.startsWith("https") ? httpsMod : httpMod;
        const ok = await new Promise<boolean>((resolve) => {
          const opts: any = { timeout: 2000 };
          if (svc.healthUrl.startsWith("https")) opts.rejectUnauthorized = false;
          const r = mod.get(svc.healthUrl, opts, (resp: any) => { resolve(resp.statusCode < 500); });
          r.on("error", () => resolve(false));
          r.on("timeout", () => { r.destroy(); resolve(false); });
        });
        return { name: svc.name, port: svc.port, linkUrl: svc.linkUrl, status: ok ? "ok" : "down" };
      } catch { return { name: svc.name, port: svc.port, linkUrl: svc.linkUrl, status: "down" }; }
    }));
    json(req, res, results);

  } else if (path === "/api/tray-services") {
    // Tray app fetches this on boot + polling. Returns only services with launchd
    // config (ones the tray can start/stop/restart), with plist content pre-generated.
    const services = getAllServices().filter(s => s.launchd);
    const result = services.map(svc => ({
      label: svc.launchd!.label,
      name: svc.name,
      port: svc.port,
      healthURL: svc.healthUrl,
      plistContent: generatePlist(svc),
    }));
    json(req, res, result);

  } else if (path === "/api/channels" && req.method === "GET") {
    try {
      const raw = readRawConfig();
      const channels = raw.channels || {};
      const config = getConfig();
      const routesList = config.routes || [];
      const httpMod = await import("http");

      const channelServiceMap: Record<string, { port: number; url: string }> = {
        whatsapp: { port: 3340, url: "http://localhost:3340/api/stats" },
        telegram: { port: 3340, url: "http://localhost:3340/api/stats" },
        discord: { port: 3340, url: "http://localhost:3340/api/stats" },
      };

      const result = await Promise.all(Object.entries(channels).map(async ([name, chCfg]: [string, any]) => {
        const routeCount = routesList.filter((r: any) => r.match?.channel === name).length;
        const svcInfo = channelServiceMap[name];
        let status = "unknown";
        if (svcInfo) {
          try {
            status = await new Promise<string>((resolve) => {
              const r = httpMod.get(svcInfo.url, { timeout: 2000 }, (resp: any) => {
                resolve(resp.statusCode < 500 ? "ok" : "down");
              });
              r.on("error", () => resolve("down"));
              r.on("timeout", () => { r.destroy(); resolve("down"); });
            });
          } catch { status = "down"; }
        }
        const safeConfig: Record<string, any> = {};
        for (const [k, v] of Object.entries(chCfg as Record<string, any>)) {
          if (k === "enabled") continue;
          if (typeof v === "string" && (v.startsWith("$") || k.toLowerCase().includes("token"))) {
            safeConfig[k] = "***set***";
          } else {
            safeConfig[k] = v;
          }
        }
        return {
          name,
          enabled: chCfg.enabled !== false,
          config: safeConfig,
          status: chCfg.enabled !== false ? status : "disabled",
          routeCount,
        };
      }));
      json(req, res, result);
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path.startsWith("/api/channels/") && req.method === "PUT") {
    try {
      const channelName = decodeURIComponent(path.slice("/api/channels/".length));
      const body = await parseBody(req);
      const raw = readRawConfig();
      if (!raw.channels) raw.channels = {};
      if (!raw.channels[channelName]) { json(req, res, { error: "channel not found" }, 404); return; }
      if (typeof body.enabled === "boolean") {
        raw.channels[channelName].enabled = body.enabled;
      }
      if (body.config && typeof body.config === "object") {
        for (const [k, v] of Object.entries(body.config)) {
          if (k.toLowerCase().includes("token")) continue;
          raw.channels[channelName][k] = v;
        }
      }
      await writeRawConfig(raw);
      invalidateHtmlCache();
      log.info("[dashboard] Updated channel %s", channelName);
      json(req, res, { ok: true });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }


  // --- EMAIL ACCOUNTS CRUD ---
  } else if (path === "/api/config/email-accounts" && req.method === "GET") {
    try {
      const accounts = getEmailAccounts();
      json(req, res, { accounts: Object.entries(accounts).map(([email, account]) => ({ email, account })) });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path === "/api/config/email-accounts" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      if (!body.email || !body.account) { json(req, res, { error: "email and account required" }, 400); return; }
      const raw = readRawConfig();
      if (!raw.jarvis) raw.jarvis = {};
      if (!raw.jarvis.emailAccounts) raw.jarvis.emailAccounts = [];
      const exists = raw.jarvis.emailAccounts.some((a: any) => a.email === body.email);
      if (exists) { json(req, res, { error: "email already exists" }, 409); return; }
      raw.jarvis.emailAccounts.push({ email: body.email, account: body.account });
      await writeRawConfig(raw);
      invalidateHtmlCache();
      log.info("[dashboard] Added email account: %s -> %s", body.email, body.account);
      json(req, res, { ok: true, accounts: raw.jarvis.emailAccounts });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path.startsWith("/api/config/email-accounts/") && req.method === "DELETE") {
    if (!requireConfirm(req, res)) return;
    try {
      const email = decodeURIComponent(path.slice("/api/config/email-accounts/".length));
      const raw = readRawConfig();
      if (raw.jarvis?.emailAccounts) {
        raw.jarvis.emailAccounts = raw.jarvis.emailAccounts.filter((a: any) => a.email !== email);
      }
      await writeRawConfig(raw);
      invalidateHtmlCache();
      log.info("[dashboard] Removed email account: %s", email);
      json(req, res, { ok: true, accounts: raw.jarvis?.emailAccounts ?? [] });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- AGENTS CRUD ---
  } else if (path === "/api/agents" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      if (!body.name || !validateAgentName(body.name)) { json(req, res, { error: "valid agent name required" }, 400); return; }
      const agentDir = join(HOME, ".claude/jarvis/agents", body.name);
      if (existsSync(agentDir)) { json(req, res, { error: "agent already exists" }, 409); return; }
      mkdirSync(agentDir, { recursive: true });
      const template = body.template || `# ${body.name}\n\n## Role\nDescribe this agent's role here.\n\n## Rules\n- Rule 1\n`;
      writeFileSync(join(agentDir, "CLAUDE.md"), template, "utf-8");
      invalidateHtmlCache();
      log.info("[dashboard] Created agent: %s", body.name);
      json(req, res, { ok: true, name: body.name });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path.match(/^\/api\/agents\/[^/]+$/) && req.method === "DELETE") {
    if (!requireConfirm(req, res)) return;
    try {
      const agentName = decodeURIComponent(path.split("/")[3]);
      if (!validateAgentName(agentName)) { json(req, res, { error: "invalid agent name" }, 400); return; }
      const agentDir = join(HOME, ".claude/jarvis/agents", agentName);
      if (!existsSync(agentDir)) { json(req, res, { error: "agent not found" }, 404); return; }
      const raw2 = readRawConfig();
      const inUse = (raw2.routes || []).some((r: any) => r.use === agentName);
      if (inUse) { json(req, res, { error: "agent is in use by a route, remove the route first" }, 409); return; }
      const raw = readRawConfig();
      const cronRef = (raw.crons || []).find((c: any) => c.workspace?.endsWith("/" + agentName));
      if (cronRef) { json(req, res, { error: `agent is referenced by cron job "${cronRef.name}", remove it first` }, 409); return; }
      rmSync(agentDir, { recursive: true });
      invalidateHtmlCache();
      log.info("[dashboard] Deleted agent: %s", agentName);
      json(req, res, { ok: true });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- ROUTE DUPLICATE ---
  } else if (path.match(/^\/api\/routes\/\d+\/duplicate$/) && req.method === "POST") {
    try {
      const idx = parseInt(path.split("/")[3], 10);
      const raw = readRawConfig();
      if (idx < 0 || idx >= raw.routes.length) { json(req, res, { error: "invalid index" }, 400); return; }
      const original = JSON.parse(JSON.stringify(raw.routes[idx]));
      if (original.match?.from && original.match.from !== "*" && original.match.from !== "self") {
        original.match.from = original.match.from + "-copy";
      }
      if (original.match?.group) {
        original.match.group = original.match.group + "-copy";
      }
      raw.routes.splice(idx + 1, 0, original);
      await writeRawConfig(raw);
      invalidateHtmlCache();
      log.info("[dashboard] Duplicated route %d", idx);
      json(req, res, { ok: true, newIndex: idx + 1 });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- CRON CRUD ---
  } else if (path === "/api/crons" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      if (!body.name || !body.schedule || !body.prompt) { json(req, res, { error: "name, schedule, and prompt required" }, 400); return; }
      const raw = readRawConfig();
      if (!raw.crons || !Array.isArray(raw.crons)) raw.crons = [];
      const exists = raw.crons.some((c: any) => c.name === body.name);
      if (exists) { json(req, res, { error: "cron job with this name already exists" }, 409); return; }
      const cronJob: any = {
        name: body.name,
        schedule: body.schedule,
        timezone: body.timezone || "Europe/Rome",
        workspace: body.workspace || "~/.claude/jarvis/agents/business",
        model: body.model || "opus",
        prompt: body.prompt,
        timeout: body.timeout || 300,
      };
      if (body.delivery?.channel && body.delivery?.target) {
        cronJob.delivery = { channel: body.delivery.channel, target: body.delivery.target };
      }
      raw.crons.push(cronJob);
      await writeRawConfig(raw);
      invalidateHtmlCache();
      log.info("[dashboard] Added cron job: %s", body.name);
      json(req, res, { ok: true, name: body.name });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path.match(/^\/api\/crons\/[^/]+$/) && !path.includes("/run") && req.method === "PUT") {
    try {
      const name = decodeURIComponent(path.split("/")[3]);
      const body = await parseBody(req);
      const raw = readRawConfig();
      if (!raw.crons || !Array.isArray(raw.crons)) { json(req, res, { error: "no crons configured" }, 404); return; }
      const idx = raw.crons.findIndex((c: any) => c.name === name);
      if (idx < 0) { json(req, res, { error: "cron not found" }, 404); return; }
      if (body.schedule !== undefined) raw.crons[idx].schedule = body.schedule;
      if (body.timezone !== undefined) raw.crons[idx].timezone = body.timezone;
      if (body.model !== undefined) raw.crons[idx].model = body.model;
      if (body.workspace !== undefined) raw.crons[idx].workspace = body.workspace;
      if (body.prompt !== undefined) raw.crons[idx].prompt = body.prompt;
      if (body.timeout !== undefined) raw.crons[idx].timeout = body.timeout;
      await writeRawConfig(raw);
      invalidateHtmlCache();
      log.info("[dashboard] Updated cron job: %s", name);
      json(req, res, { ok: true });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path.match(/^\/api\/crons\/[^/]+$/) && !path.includes("/run") && req.method === "DELETE") {
    if (!requireConfirm(req, res)) return;
    try {
      const name = decodeURIComponent(path.split("/")[3]);
      const raw = readRawConfig();
      if (!raw.crons || !Array.isArray(raw.crons)) { json(req, res, { error: "no crons configured" }, 404); return; }
      const idx = raw.crons.findIndex((c: any) => c.name === name);
      if (idx < 0) { json(req, res, { error: "cron not found" }, 404); return; }
      raw.crons.splice(idx, 1);
      if (raw.crons.length === 0) raw.crons = null;
      await writeRawConfig(raw);
      deleteCronRuns(name);
      invalidateHtmlCache();
      log.info("[dashboard] Deleted cron job: %s", name);
      json(req, res, { ok: true });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  // --- MEMORY SCOPES ---
  } else if (path === "/api/config/memory-scopes" && req.method === "GET") {
    try {
      const raw = readRawConfig();
      const scopes = raw.jarvis?.memoryScopes ?? Object.keys(SCOPE_HELP).filter(Boolean);
      json(req, res, { scopes });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path === "/api/config/memory-scopes" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      if (!body.scope) { json(req, res, { error: "scope required" }, 400); return; }
      const raw = readRawConfig();
      if (!raw.jarvis) raw.jarvis = {};
      if (!raw.jarvis.memoryScopes) raw.jarvis.memoryScopes = Object.keys(SCOPE_HELP).filter(Boolean);
      if (!raw.jarvis.memoryScopes.includes(body.scope)) {
        raw.jarvis.memoryScopes.push(body.scope);
      }
      await writeRawConfig(raw);
      invalidateHtmlCache();
      log.info("[dashboard] Added memory scope: %s", body.scope);
      json(req, res, { ok: true, scopes: raw.jarvis.memoryScopes });
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path === "/api/agents/full" && req.method === "GET") {
    try {
      const agents = getAgentsData();
      const routes = getRoutesData();
      const result = agents.map(a => {
        const agentRoutes = routes
          .filter((r: any) => r.workspace === a.name)
          .map((r: any, _i: number, _arr: any[]) => {
            const idx = routes.indexOf(r);
            return { index: idx, channel: r.channel, from: r.from, group: r.group, fullAccess: r.fullAccess };
          });
        return {
          ...a,
          routes: agentRoutes,
        };
      });
      json(req, res, result);
    } catch (e: any) { json(req, res, { error: e.message }, 500); }

  } else if (path === "/api/agents-list") {
    const agents = getAgentsData();
    const routes = getRoutesData();
    const list = agents.map(a => {
      const usedBy = routes
        .filter((r: any) => r.workspace === a.name)
        .map((r: any) => `${r.channel}${r.group ? " (group)" : r.from !== "*" ? ` (${r.from})` : ""}`);
      return { name: a.name, hasClaudeMd: a.size > 0, size: a.size, usedBy };
    });
    json(req, res, list);

  } else if (path === "/api/logs" && req.method === "DELETE") {
    clearLogEntries();
    json(req, res, { ok: true });

  } else if (path === "/api/whatsapp/status" && req.method === "GET") {
    const wa = WhatsAppConnector.getInstance();
    if (!wa) { json(req, res, { status: "idle", error: "whatsapp connector not running", updatedAt: Date.now() }); return; }
    json(req, res, wa.getStatus());

  } else if (path === "/api/whatsapp/relink" && req.method === "POST") {
    // Destructive: wipes wa-auth/ on disk. Gate behind X-Confirm: true header,
    // matching the convention used by every other destructive endpoint here.
    if (!requireConfirm(req, res)) return;
    const wa = WhatsAppConnector.getInstance();
    if (!wa) { json(req, res, { error: "whatsapp connector not running" }, 503); return; }
    let body: { phoneNumber?: string } = {};
    try { body = await parseBody(req); } catch {}
    const phone = body.phoneNumber?.toString().trim();
    // Fire-and-forget — the dashboard subscribes to /api/whatsapp/events for the
    // QR/code/connected transitions, so the HTTP call returns instantly.
    wa.relink({ phoneNumber: phone || undefined }).catch((err) => {
      log.error({ err }, "whatsapp relink failed");
    });
    json(req, res, { ok: true });

  } else if (path === "/api/whatsapp/events" && req.method === "GET") {
    const wa = WhatsAppConnector.getInstance();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": corsOrigin(req),
    });
    res.write(`: whatsapp stream open\n\n`);
    if (wa) {
      try { res.write(`data: ${JSON.stringify(wa.getStatus())}\n\n`); } catch {}
    } else {
      try { res.write(`data: ${JSON.stringify({ status: "idle", error: "connector not running", updatedAt: Date.now() })}\n\n`); } catch {}
    }
    const onStatus = (snap: unknown) => {
      try { res.write(`data: ${JSON.stringify(snap)}\n\n`); } catch {}
    };
    wa?.events.on("status", onStatus);
    const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 25_000);
    req.on("close", () => { clearInterval(ping); wa?.events.off("status", onStatus); });

  } else if (path === "/api/notch/stream" && req.method === "GET") {
    // SSE feed consumed by the notch.js orb (native WKWebView + dashboard
    // iframe mirror). Writes each NotchEvent as JSON on a single `data:` line,
    // per the EventSource protocol. Heartbeats every 25 s keep intermediate
    // proxies from killing the connection; the client re-subscribes on error
    // with a backoff so a dropped stream is self-healing.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": corsOrigin(req),
    });
    res.write(`: notch stream open\n\n`);
    const unsub = subscribeNotch((event) => {
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
    });
    const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 25_000);
    req.on("close", () => { clearInterval(ping); unsub(); });

  } else if (path === "/api/notch/send" && req.method === "POST") {
    let body: { text?: string; from?: string };
    try { body = await parseBody(req); } catch { json(req, res, { error: "bad body" }, 400); return; }
    const text = (body.text ?? "").toString().trim();
    if (!text) { json(req, res, { error: "missing text" }, 400); return; }
    const connector = NotchConnector.getInstance();
    if (!connector) { json(req, res, { error: "notch connector not running" }, 503); return; }
    // Fire-and-forget: the assistant reply flows back through `emitNotch`
    // (message.in), so we don't block the HTTP response on it.
    connector.inject(text, body.from ?? "notch").catch(() => {});
    json(req, res, { ok: true });

  } else if (path === "/api/notch/abort" && req.method === "POST") {
    // Hot-corner / dashboard "stop Jarvis". Cancels in-flight reply by
    // bumping the connector's generation counter; the running
    // handleMessage() finishes in the background but its reply() and
    // TTS effects are dropped.
    const connector = NotchConnector.getInstance();
    if (!connector) { json(req, res, { error: "notch connector not running" }, 503); return; }
    connector.abort();
    json(req, res, { ok: true });

  } else if (path === "/api/notch/barge" && req.method === "POST") {
    // Hard barge-in: chiamato dal native (NotchController) quando il Silero
    // VAD detecta voce dell'utente mentre il TTS sta playing. Stesso pattern
    // di abort() ma il connector emette `audio.stop` + state→`recording` così
    // l'UI non torna idle ma resta in posa "ti sto ascoltando".
    const connector = NotchConnector.getInstance();
    if (!connector) { json(req, res, { error: "notch connector not running" }, 503); return; }
    connector.barge();
    json(req, res, { ok: true });

  } else if (path === "/api/notch/history" && req.method === "GET") {
    // Persistent chat log — tail of the notch-history JSONL. The default 100
    // records is enough to rehydrate both the native WKWebView and the
    // dashboard iframe on reload without an explicit pagination cursor.
    const qs = new URLSearchParams(req.url?.split("?")[1] ?? "");
    const limitRaw = parseInt(qs.get("limit") ?? "100", 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 100;
    try {
      const items = await readHistory(limit);
      json(req, res, { items });
    } catch (err: unknown) {
      log.warn({ err }, "[notch] history read failed");
      json(req, res, { items: [] });
    }

  } else if (path === "/api/notch/history/clear" && req.method === "POST") {
    try {
      await clearHistory();
      json(req, res, { ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      json(req, res, { ok: false, error: msg }, 500);
    }

  } else if (path === "/api/notch/voice" && req.method === "POST") {
    // Streaming voice bridge — the tray app (or any WAV producer) POSTs raw
    // audio/wav bytes, we run whisper-cli on the tempfile, then inject the
    // transcript through the notch connector (which in turn emits message.out
    // and appends to history, exactly as if the user typed it).
    const ct = (req.headers["content-type"] ?? "").toString();
    if (!ct.includes("audio/wav") && !ct.includes("audio/x-wav") && !ct.includes("application/octet-stream")) {
      json(req, res, { ok: false, error: "expected Content-Type: audio/wav" }, 415);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BYTES = 16 * 1024 * 1024; // 16 MB — ~100s of 16kHz mono WAV
    let overflowed = false;
    await new Promise<void>((resolve) => {
      req.on("data", (c: Buffer) => {
        if (overflowed) return;
        size += c.length;
        if (size > MAX_BYTES) { overflowed = true; req.destroy(); resolve(); return; }
        chunks.push(c);
      });
      req.on("end", resolve);
      req.on("error", () => resolve());
    });
    if (overflowed) { json(req, res, { ok: false, error: "audio too large" }, 413); return; }
    if (size === 0) { json(req, res, { ok: false, error: "empty audio body" }, 400); return; }

    const { spawn } = await import("child_process");
    const { tmpdir } = await import("os");
    const { writeFile, unlink } = await import("fs/promises");
    const tmpPath = join(tmpdir(), `jarvis-notch-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    try {
      await writeFile(tmpPath, Buffer.concat(chunks));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      json(req, res, { ok: false, error: `tempfile write failed: ${msg}` }, 500);
      return;
    }

    const runWhisper = () => new Promise<{ text: string }>((resolve, reject) => {
      // whisper-cli default loads `models/ggml-base.en.bin` relative to
      // cwd and only transcribes English. We point at the Italian-capable
      // large-v3 model we ship under ~/whisper-models, enable auto
      // language detection, and suppress timestamps so stdout is already
      // clean plaintext.
      const homeDir = process.env.HOME ?? "";
      const model = join(homeDir, "whisper-models/ggml-large-v3.bin");
      const proc = spawn("/opt/homebrew/bin/whisper-cli", [
        "-m", model,
        "-l", "it",
        "-nt",
        tmpPath,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
      proc.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
      proc.on("error", (err) => reject(err));
      proc.on("close", (code) => {
        if (code !== 0) { reject(new Error(`whisper-cli exit ${code}: ${stderr.trim().slice(0, 500)}`)); return; }
        // Strip "[hh:mm:ss.xxx --> hh:mm:ss.xxx]" prefixes if present.
        const cleaned = stdout
          .split(/\r?\n/)
          .map((l) => l.replace(/^\s*\[[^\]]+\]\s*/, "").trim())
          .filter(Boolean)
          .join(" ")
          .trim();
        resolve({ text: cleaned });
      });
    });

    try {
      const { text } = await runWhisper();
      await unlink(tmpPath).catch(() => {});
      if (!text) { json(req, res, { ok: false, error: "empty transcript" }, 422); return; }
      const connector = NotchConnector.getInstance();
      if (connector) connector.inject(text, "voice").catch(() => {});
      json(req, res, { ok: true, text });
    } catch (err: unknown) {
      await unlink(tmpPath).catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err }, "[notch] voice transcription failed");
      json(req, res, { ok: false, error: msg }, 500);
    }

  } else if (path === "/api/notch/prefs" && req.method === "GET") {
    json(req, res, await getPrefs());

  } else if (path === "/api/notch/prefs" && req.method === "POST") {
    // Patch-style update — any key not present in the body is left untouched.
    // Unknown keys are silently ignored (forward-compatible with older apps).
    let body: Record<string, unknown>;
    try { body = await parseBody(req); } catch { json(req, res, { error: "bad body" }, 400); return; }
    const patch: Record<string, unknown> = {};
    for (const key of ["tts", "hoverRecord", "mute"] as const) {
      if (typeof body[key] === "boolean") patch[key] = body[key] as boolean;
    }
    if ("model" in body) {
      const m = body.model;
      if (m === null || m === "opus" || m === "sonnet" || m === "haiku") {
        patch.model = m;
      }
    }
    json(req, res, await setPrefs(patch as Partial<import("../notch/prefs").NotchPrefs>));

  } else if (path === "/api/notch/speak" && req.method === "POST") {
    // Synchronous synthesis — used by the dashboard "test voice" button and
    // any external caller that wants TTS without running the agent reply
    // pipeline. Returns audio bytes directly; no SSE needed.
    let body: { text?: string; voice?: string };
    try { body = await parseBody(req); } catch { json(req, res, { error: "bad body" }, 400); return; }
    const text = (body.text ?? "").toString().trim();
    if (!text) { json(req, res, { error: "missing text" }, 400); return; }
    const { tmpdir } = await import("os");
    const { readFile, unlink: unlinkFile } = await import("fs/promises");
    const out = join(tmpdir(), `jarvis-tts-speak-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp3`);
    try {
      const r = await speakToFile(text, out, { voice: body.voice });
      if (r.bytes === 0) { json(req, res, { error: "synthesis failed" }, 500); return; }
      const buf = await readFile(out);
      res.writeHead(200, {
        "Content-Type": r.mime,
        "Content-Length": buf.length.toString(),
        "X-TTS-Engine": r.engine,
        "Access-Control-Allow-Origin": corsOrigin(req),
      });
      res.end(buf);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      json(req, res, { error: msg }, 500);
    } finally {
      unlinkFile(out).catch(() => {});
    }

  } else if (path.startsWith("/api/notch/tts-stream/") && req.method === "GET") {
    // Live TTS proxy — pipes a streaming response (Cartesia SSE→MP3 via
    // ffmpeg, or ElevenLabs streaming endpoint) straight to the WebView
    // <audio> element as chunked audio/mpeg. Playback can start while
    // bytes are still arriving — Cartesia: ~100-200ms TTFA; ElevenLabs:
    // ~150-250ms TTFA. Single-consumer: the registered body is removed
    // from the map on take.
    const id = path.slice("/api/notch/tts-stream/".length);
    if (!/^[0-9a-fA-F-]{8,}$/.test(id)) {
      json(req, res, { error: "not found" }, 404); return;
    }
    const { takeTtsStream } = await import("../services/tts.js");
    const body = takeTtsStream(id);
    if (!body) { json(req, res, { error: "expired" }, 404); return; }
    const { Readable } = await import("stream");
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": corsOrigin(req),
    });
    const node = Readable.fromWeb(body as any);
    node.on("error", () => { try { res.end(); } catch {} });
    req.on("close", () => { try { node.destroy(); } catch {} });
    node.pipe(res);

  } else if (path.startsWith("/api/notch/tts-file/") && req.method === "GET") {
    // Serve temp TTS files referenced from `audio.play` SSE events. Path
    // traversal defence: allow ONLY basenames that match our generator
    // pattern AND live in os.tmpdir(). Anything else → 404.
    const name = path.slice("/api/notch/tts-file/".length);
    if (!/^jarvis-tts-[A-Za-z0-9_.-]+\.(mp3|wav|m4a)$/.test(name)) {
      json(req, res, { error: "not found" }, 404); return;
    }
    const { tmpdir } = await import("os");
    const { readFile } = await import("fs/promises");
    const filePath = join(tmpdir(), name);
    try {
      const buf = await readFile(filePath);
      const mime = name.endsWith(".wav") ? "audio/wav"
                 : name.endsWith(".m4a") ? "audio/mp4"
                 : "audio/mpeg";
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": buf.length.toString(),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": corsOrigin(req),
      });
      res.end(buf);
    } catch {
      json(req, res, { error: "not found" }, 404);
    }

  } else if (path === "/api/notch/transcript" && req.method === "POST") {
    // Wire the tray app's streaming recorder into the same pipeline the
    // synchronous /voice endpoint uses. `final=true` injects through the
    // connector (which emits message.out + appends to history); `final=false`
    // just broadcasts a voice.partial so the UI can show live interim text.
    let body: { text?: string; final?: boolean };
    try { body = await parseBody(req); } catch { json(req, res, { error: "bad body" }, 400); return; }
    const text = (body.text ?? "").toString().trim();
    if (!text) { json(req, res, { error: "missing text" }, 400); return; }
    if (body.final === false) {
      emitNotch({ type: "voice.partial", data: { text } });
      json(req, res, { ok: true });
    } else {
      const connector = NotchConnector.getInstance();
      if (connector) connector.inject(text, "voice").catch(() => {});
      json(req, res, { ok: true });
    }

  } else if (path === "/api/local-sessions" && req.method === "GET") {
    try {
      const sessions = await discoverLocalSessions();
      json(req, res, sessions);
    } catch (err: unknown) {
      log.warn({ err }, "[local-sessions] discovery failed");
      json(req, res, { error: "discovery failed" }, 500);
    }

  } else if (/^\/api\/local-sessions\/\d+\/targets$/.test(path) && req.method === "GET") {
    const pid = parseInt(path.split("/")[3], 10);
    const sessions = await discoverLocalSessions();
    const session = sessions.find((s) => s.pid === pid);
    if (!session) { json(req, res, { error: "session not found" }, 404); return; }
    json(req, res, await availableTargets(session));

  } else if (/^\/api\/local-sessions\/\d+\/open$/.test(path) && req.method === "POST") {
    const pid = parseInt(path.split("/")[3], 10);
    let body: { target?: OpenTargetId };
    try { body = await parseBody(req); } catch { json(req, res, { error: "bad body" }, 400); return; }
    const target = body.target;
    if (!target) { json(req, res, { error: "missing target" }, 400); return; }
    const sessions = await discoverLocalSessions();
    const session = sessions.find((s) => s.pid === pid);
    if (!session) { json(req, res, { error: "session not found" }, 404); return; }
    try {
      await dispatchOpenTarget(target, session);
      json(req, res, { ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      json(req, res, { error: msg }, 500);
    }

  } else {
    json(req, res, { error: "not found" }, 404);
  }
}
