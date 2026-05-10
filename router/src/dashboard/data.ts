import { readFileSync, statSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";
import { parse as parseYaml } from "yaml";
import { getProcesses } from "../services/claude";
import { getConfig, getToolRegistry, getToolRouteMap } from "../services/config-loader";
import { getAllContactNames } from "../services/contact-names";
import { formatUptime, safeReadFile, safeFileSize } from "./helpers";
import { getTotalMessages, getMessagesByChannel, getResponseTimes, ROUTER_START } from "./state";

const HOME = process.env.HOME!;

// ============================================================
// DATA GATHERERS
// ============================================================

/**
 * Build a human-friendly name map for JIDs, phone numbers, user IDs.
 */
export interface FriendlyEntry { name: string; rawId: string }
export function buildFriendlyNames(): Record<string, FriendlyEntry> {
  const map: Record<string, FriendlyEntry> = {};
  try {
    const config = getConfig();
    const connectorNames = getAllContactNames();

    // Layer 3: agent name as group fallback
    for (const r of config.routes) {
      if (!r.use) continue;
      const agentLabel = r.use.charAt(0).toUpperCase() + r.use.slice(1);
      const gid = r.match.group ?? r.match.guild;
      if (gid) map[gid] = { name: agentLabel, rawId: gid };
    }

    // Layer 2: config.yaml users
    const users = (config as any).users ?? {};
    for (const [name, user] of Object.entries(users) as [string, any][]) {
      const label = name.charAt(0).toUpperCase() + name.slice(1);
      if (user.ids?.whatsapp) map[String(user.ids.whatsapp)] = { name: label, rawId: String(user.ids.whatsapp) };
      if (user.ids?.telegram) map[String(user.ids.telegram)] = { name: label, rawId: String(user.ids.telegram) };
      if (user.ids?.discord) map[String(user.ids.discord)] = { name: label, rawId: String(user.ids.discord) };
    }

    // Layer 1: connector real names (overwrite with real group/user names)
    for (const [id, realName] of Object.entries(connectorNames)) {
      const existing = map[id];
      map[id] = { name: realName, rawId: existing?.rawId ?? id };
    }

    // Special
    const ownerPhone = String((config as any).jarvis?.allowedCallers?.[0] ?? "");
    const ownerName = map[ownerPhone]?.name ?? "owner";
    map["self"] = { name: `Self (${ownerName})`, rawId: ownerPhone };
  } catch { /* ignore */ }
  return map;
}

export function getRoutesData() {
  try {
    const config = getConfig();
    const names = buildFriendlyNames();
    return config.routes.map((r: any) => {
      const ws = r.agent?.workspace ? basename(r.agent.workspace) : "\u2014";
      const claudeMdPath = r.agent?.workspace ? join(r.agent.workspace, "CLAUDE.md") : null;
      let claudeMdPreview = "";
      let claudeMdSize = 0;
      if (claudeMdPath) {
        const content = safeReadFile(claudeMdPath);
        if (content) {
          claudeMdPreview = content.split("\n").slice(0, 2).join(" ").trim();
          claudeMdSize = content.length;
        }
      }
      const fromRaw = r.match.from ?? "*";
      const groupRaw = r.match.group ?? r.match.guild ?? null;
      const fromEntry = names[String(fromRaw)];
      const groupEntry = groupRaw ? names[String(groupRaw)] : null;
      return {
        channel: r.match.channel,
        from: fromRaw,
        fromLabel: fromEntry?.name ?? null,
        fromRawId: fromEntry?.rawId ?? String(fromRaw),
        group: groupRaw,
        groupLabel: groupEntry?.name ?? null,
        groupRawId: groupEntry?.rawId ?? (groupRaw ?? ""),
        workspace: ws,
        fullWorkspace: r.agent?.workspace ?? "",
        model: r.agent?.model ?? "default",
        fallbacks: r.agent?.fallbacks ?? [],
        alwaysReply: r.agent?.alwaysReply ?? false,
        action: r.action ?? "route",
        claudeMdPreview,
        claudeMdSize,
        tools: r.agent?.tools ?? [],
        fullAccess: r.agent?.fullAccess === true,
        inheritUserScope: r.agent?.inheritUserScope !== false,
      };
    });
  } catch { return []; }
}

/** Recursively walk ~/.claude/jarvis/memory and return .md files with category metadata */
export function walkMemoryDir(root: string): Array<{ path: string; name: string; category: string; size: number; mtime: number; preview: string; title: string }> {
  const out: Array<{ path: string; name: string; category: string; size: number; mtime: number; preview: string; title: string }> = [];
  if (!existsSync(root)) return out;
  function walk(dir: string, rel: string) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "archive") continue;
      const full = join(dir, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full, relPath);
      } else if (entry.endsWith(".md")) {
        const category = rel ? rel.split("/")[0] : "_root";
        let title = entry.replace(/\.md$/, "");
        let preview = "";
        try {
          const raw = readFileSync(full, "utf-8").slice(0, 800);
          const lines = raw.split("\n").filter((l) => l.trim());
          const h1 = lines.find((l) => l.startsWith("# "));
          if (h1) title = h1.slice(2).trim();
          preview = lines
            .filter((l) => !l.startsWith("#") && !l.startsWith("---"))
            .slice(0, 3)
            .join(" ")
            .replace(/[*_`\[\]]/g, "")
            .slice(0, 180);
        } catch { /* ignore */ }
        out.push({ path: relPath, name: entry, category, size: st.size, mtime: st.mtimeMs, preview, title });
      }
    }
  }
  walk(root, "");
  return out;
}

/** Parse a CLAUDE.md content and return which shared/agent/memory imports it declares. */
export function parseAgentScopes(content: string): { soul: boolean; agents: boolean; tools: boolean; user: boolean; memory: boolean; imports: string[] } {
  const imports: string[] = [];
  const importRe = /@([^\s]+\.md)/g;
  for (const match of content.matchAll(importRe)) imports.push(match[1]);
  const importsShared = (baseName: string) =>
    imports.some(i => i.toLowerCase().includes(`_shared/${baseName.toLowerCase()}`));
  const hasOwn = (baseName: string) =>
    imports.some(i => i.toLowerCase().endsWith(`/${baseName.toLowerCase()}`) && !i.toLowerCase().includes("_shared/"));
  return {
    soul: importsShared("SOUL.md"),
    agents: importsShared("AGENTS.md"),
    tools: importsShared("TOOLS.md"),
    user: hasOwn("USER.md"),
    memory: hasOwn("MEMORY.md") || imports.some(i => i.toLowerCase().includes("memory/people/") || i.toLowerCase().includes("memory/projects/")),
    imports,
  };
}

export function getAgentsData() {
  const agents: Array<{
    name: string; workspace: string; content: string; size: number;
    files: Array<{ name: string; size: number }>;
    scopes: ReturnType<typeof parseAgentScopes>;
    model: string | null; effort: string | null; fallbacks: string[];
    fullAccess: boolean; tools: string[]; inheritUserScope: boolean;
  }> = [];
  const agentsDir = join(HOME, ".claude/jarvis/agents");
  try {
    for (const name of readdirSync(agentsDir)) {
      if (name.startsWith("_") || name.startsWith(".")) continue;
      const ws = join(agentsDir, name);
      try { if (!statSync(ws).isDirectory()) continue; } catch { continue; }
      const claudeMd = join(ws, "CLAUDE.md");
      const content = safeReadFile(claudeMd) ?? "";
      const files: Array<{ name: string; size: number }> = [];
      try {
        for (const entry of readdirSync(ws)) {
          if (!entry.endsWith(".md")) continue;
          try {
            const st = statSync(join(ws, entry));
            if (st.isFile()) files.push({ name: entry, size: st.size });
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
      files.sort((a, b) => a.name.localeCompare(b.name));
      let model: string | null = null;
      let effort: string | null = null;
      let fallbacks: string[] = [];
      let fullAccess = false;
      let tools: string[] = [];
      let inheritUserScope = true;
      try {
        const yamlPath = join(ws, "agent.yaml");
        if (existsSync(yamlPath)) {
          const parsed = parseYaml(readFileSync(yamlPath, "utf-8")) ?? {};
          model = parsed.model ?? null;
          effort = parsed.effort ?? null;
          fallbacks = Array.isArray(parsed.fallbacks) ? parsed.fallbacks : [];
          fullAccess = parsed.fullAccess === true;
          tools = Array.isArray(parsed.tools) ? parsed.tools : [];
          inheritUserScope = parsed.inheritUserScope !== false;
        }
      } catch { /* skip */ }
      agents.push({
        name, workspace: ws, content, size: content.length,
        files, scopes: parseAgentScopes(content),
        model, effort, fallbacks, fullAccess, tools, inheritUserScope,
      });
    }
  } catch { /* no agents dir */ }
  return agents;
}

export function getStatsData() {
  const procs = getProcesses();
  return {
    totalMessages: getTotalMessages(),
    messagesByChannel: getMessagesByChannel(),
    uptimeMs: Date.now() - ROUTER_START,
    uptime: formatUptime(Date.now() - ROUTER_START),
    activeProcesses: procs.length,
  };
}

export function getResponseTimesData() {
  const responseTimes = getResponseTimes();
  const last20 = responseTimes.slice(-20);
  const oneHourAgo = Date.now() - 3600_000;
  const lastHour = responseTimes.filter(r => r.ts > oneHourAgo);
  const avgWall = lastHour.length ? Math.round(lastHour.reduce((s, r) => s + r.wallMs, 0) / lastHour.length) : 0;
  const avgApi = lastHour.length ? Math.round(lastHour.reduce((s, r) => s + r.apiMs, 0) / lastHour.length) : 0;
  const vals = last20.map(r => r.wallMs);
  let sparkline = "";
  if (vals.length > 1) {
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const chars = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
    sparkline = vals.map(v => {
      const idx = max === min ? 0 : Math.round(((v - min) / (max - min)) * (chars.length - 1));
      return chars[idx];
    }).join("");
  }
  return { recent: last20, avgWallMs: avgWall, avgApiMs: avgApi, count1h: lastHour.length, sparkline };
}

export function getProcessesWithContext() {
  const procs = getProcesses();
  const config = getConfig();
  const friendly = buildFriendlyNames();
  const now = Date.now();
  return procs.map(p => {
    // Parse session key `${channel}:${fromOrGroup}` to map back to a route + agent.
    const colonIdx = p.key.indexOf(":");
    const channel = colonIdx > 0 ? p.key.slice(0, colonIdx) : "";
    const target = colonIdx > 0 ? p.key.slice(colonIdx + 1) : "";
    const route = config.routes.find(r => {
      if (r.match.channel !== channel && r.match.channel !== "*") return false;
      const group = r.match.group ?? r.match.guild;
      if (group) return group === target;
      if (r.match.from !== undefined && r.match.from !== "*") return String(r.match.from) === target;
      return r.match.channel === "*";
    });
    const agent = route?.agent;
    const friendlyName = friendly[target]?.name ?? null;
    // Prefer real API-reported tokens; fall back to heuristic only when the process hasn't processed any message yet.
    const realTokens = p.inputTokens + p.outputTokens;
    const estimatedTokens = realTokens > 0 ? realTokens : p.messageCount * 2000;
    return {
      ...p,
      estimatedTokens,
      channel,
      target,
      targetLabel: friendlyName,
      agentName: agent?.name ?? null,
      agentModel: agent?.model ?? null,
      fullAccess: agent?.fullAccess === true,
      inheritUserScope: agent?.inheritUserScope !== false,
      uptime: now - p.createdAt,
      idleTime: now - p.lastMessageAt,
      timeToInactivityTimeout: Math.max(0, p.inactivityExpiresAt - now),
      timeToLifetimeTimeout: Math.max(0, p.lifetimeExpiresAt - now),
    };
  });
}
