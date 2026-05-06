/**
 * Cross-channel registry MCP. Exposes a curated list of known channels/chats
 * pulled from `~/.claude/jarvis/memory/channels.md` so the agent can resolve
 * names like "Moonstone Ops group" or "armonia-board—zenda" → JID/channel ID
 * without guessing.
 *
 * The file is human-curated. Reload happens at every tool call (cheap — small
 * markdown file). Format is YAML-in-fenced-block so humans can edit either
 * the markdown text or the YAML data.
 */

import { z } from "zod";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import * as YAML from "yaml";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../types";
import { ok, okJson, fail, auditTool } from "./_helpers";
import { logger } from "../services/logger";

const log = logger.child({ module: "mcp.channels" });
const SERVER = "channels";

const HOME = process.env.HOME ?? "";
const CHANNELS_FILE = join(HOME, ".claude/jarvis/memory/channels.md");

interface Entry {
  name: string;
  channel: "discord" | "whatsapp" | "telegram";
  id: string; // channelId / jid / chatId
  guildId?: string;
  description?: string;
  tags?: string[];
}

let cache: { mtime: number; entries: Entry[] } | null = null;

function loadEntries(): Entry[] {
  if (!existsSync(CHANNELS_FILE)) return [];
  try {
    const stat = statSync(CHANNELS_FILE);
    if (cache && cache.mtime === stat.mtimeMs) return cache.entries;
    const raw = readFileSync(CHANNELS_FILE, "utf8");
    // Extract first ```yaml fenced block.
    const match = raw.match(/```ya?ml\s*\n([\s\S]*?)```/);
    if (!match) return [];
    const parsed = YAML.parse(match[1]!) as { channels?: Entry[] } | Entry[] | null;
    const entries = Array.isArray(parsed) ? parsed : parsed?.channels ?? [];
    const sane = entries.filter((e): e is Entry =>
      !!e && typeof e === "object" && typeof e.name === "string" && typeof e.id === "string" &&
      ["discord", "whatsapp", "telegram"].includes(e.channel),
    );
    cache = { mtime: stat.mtimeMs, entries: sane };
    return sane;
  } catch (err) {
    log.warn({ err: String(err) }, "failed to parse channels.md");
    return [];
  }
}

interface CreateOpts {
  agent: AgentConfig;
  sessionKey: string;
}

export function createChannelsMcp(opts: CreateOpts): McpSdkServerConfigWithInstance {
  const { sessionKey } = opts;

  const listKnown = tool(
    "channels_list_known",
    "List known channels/chats curated in ~/.claude/jarvis/memory/channels.md. Use this to resolve a human name (e.g. 'Moonstone Ops') to a channel/JID/chatId before calling discord/whatsapp/telegram tools.",
    {
      channel: z.enum(["discord", "whatsapp", "telegram"]).optional().describe("Filter by channel."),
      query: z.string().optional().describe("Substring filter on name/description/tags."),
    },
    async (args) => {
      const start = Date.now();
      const all = loadEntries();
      let filtered = all;
      if (args.channel) filtered = filtered.filter(e => e.channel === args.channel);
      if (args.query) {
        const q = args.query.toLowerCase();
        filtered = filtered.filter(e =>
          e.name.toLowerCase().includes(q) ||
          (e.description?.toLowerCase().includes(q) ?? false) ||
          (e.tags?.some(t => t.toLowerCase().includes(q)) ?? false),
        );
      }
      auditTool({ server: SERVER, tool: "channels_list_known", sessionKey, args, ok: true, durationMs: Date.now() - start, resultSummary: `${filtered.length}/${all.length}` });
      return okJson({ count: filtered.length, channels: filtered });
    },
  );

  const resolveName = tool(
    "channels_resolve",
    "Resolve a human-friendly name to its channel ID / JID / chat ID. Returns the best match (or matches if ambiguous).",
    {
      name: z.string().min(1).describe("Name or partial name to resolve."),
      channel: z.enum(["discord", "whatsapp", "telegram"]).optional(),
    },
    async (args) => {
      const start = Date.now();
      const all = loadEntries();
      const q = args.name.toLowerCase();
      const filtered = all
        .filter(e => !args.channel || e.channel === args.channel)
        .map(e => {
          const name = e.name.toLowerCase();
          let score = 0;
          if (name === q) score = 100;
          else if (name.startsWith(q)) score = 50;
          else if (name.includes(q)) score = 30;
          else if (e.tags?.some(t => t.toLowerCase().includes(q))) score = 10;
          return { entry: e, score };
        })
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      if (filtered.length === 0) {
        auditTool({ server: SERVER, tool: "channels_resolve", sessionKey, args, ok: false, durationMs: Date.now() - start, errorReason: "no match" });
        return fail(`no match for "${args.name}". Run channels_list_known to see what's curated.`);
      }
      auditTool({ server: SERVER, tool: "channels_resolve", sessionKey, args, ok: true, durationMs: Date.now() - start, resultSummary: filtered[0]!.entry.name });
      return okJson({ matches: filtered.map(f => f.entry) });
    },
  );

  return createSdkMcpServer({
    name: SERVER,
    version: "0.1.0",
    tools: [listKnown, resolveName],
  });
}
