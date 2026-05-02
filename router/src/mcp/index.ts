/**
 * Messaging MCP builder.
 *
 * Called from `services/claude.ts` at session-spawn time. Given the agent
 * config + sessionKey, returns the in-process MCP server records to attach
 * to the SDK options (alongside any external MCPs from `~/.claude.json`).
 *
 * Design:
 * - Each MCP server (discord/whatsapp/telegram/channels) is built only when
 *   the agent has the corresponding tool in `agent.tools` (or `fullAccess`).
 * - Tools close over `(agent, sessionKey)` and re-read the session-context
 *   on every call, so they always see the *current* conversation, not a
 *   stale snapshot from session creation.
 * - Returns `Record<serverName, McpSdkServerConfigWithInstance>` ready to be
 *   merged with external MCPs.
 */

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../types";
import {
  canDiscord, canDiscordWrite,
  canWhatsapp, canWhatsappWrite,
  canTelegram, canTelegramWrite,
  canChannels,
} from "../services/capabilities";
import { createDiscordMcp } from "./discord";
import { createWhatsappMcp } from "./whatsapp";
import { createTelegramMcp } from "./telegram";
import { createChannelsMcp } from "./channels";

export interface BuildMcpsOpts {
  agent: AgentConfig;
  sessionKey: string;
}

export type MessagingMcps = Record<string, McpSdkServerConfigWithInstance>;

export function buildMessagingMcps(opts: BuildMcpsOpts): MessagingMcps {
  const out: MessagingMcps = {};

  if (canDiscord(opts.agent)) {
    out.discord = createDiscordMcp({ ...opts, canWrite: canDiscordWrite(opts.agent) });
  }
  if (canWhatsapp(opts.agent)) {
    out.whatsapp = createWhatsappMcp({ ...opts, canWrite: canWhatsappWrite(opts.agent) });
  }
  if (canTelegram(opts.agent)) {
    out.telegram = createTelegramMcp({ ...opts, canWrite: canTelegramWrite(opts.agent) });
  }
  if (canChannels(opts.agent)) {
    out.channels = createChannelsMcp(opts);
  }

  return out;
}
