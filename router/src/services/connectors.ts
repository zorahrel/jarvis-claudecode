/**
 * Typed accessors for live connector instances. Used by in-process messaging
 * MCPs (router/src/mcp/*) so they can reach the Discord client / WhatsApp socket
 * / Telegram bot without each importing the connector classes directly (which
 * would risk import cycles via handler/router/claude).
 *
 * The accessors are nullable on purpose: a connector may be disabled in config,
 * still pairing, or temporarily disconnected. MCP tools must handle null and
 * return a structured "service unavailable" error rather than crashing.
 */

import type { Client } from "discord.js";
import type { Bot } from "grammy";
import { DiscordConnector } from "../connectors/discord";
import { WhatsAppConnector } from "../connectors/whatsapp";
import { TelegramConnector } from "../connectors/telegram";

/** The WhatsApp socket handle. Type derived from the connector to avoid a direct baileys import. */
export type WhatsAppSocket = WhatsAppConnector["socket"];

/**
 * Minimal structural type for the WhatsApp socket methods used by the in-process
 * MCP. Centralizes the cast that used to be duplicated at every call site.
 * Mirrors the relevant parts of Baileys' `WASocket`; if a method signature
 * drifts, this is the single place to update.
 */
export interface WhatsAppSocketAPI {
  sendMessage: (
    jid: string,
    content:
      | { text: string }
      | { poll: { name: string; values: string[]; selectableCount: number } }
      | { react: { text: string; key: { id: string; fromMe?: boolean; remoteJid?: string } } },
  ) => Promise<{ key?: { id?: string } } | undefined>;
  groupMetadata: (jid: string) => Promise<{
    id: string;
    subject?: string;
    creation?: number;
    owner?: string;
    desc?: string;
    participants: Array<{ id: string; admin?: "admin" | "superadmin" | null; lid?: string }>;
  }>;
  groupFetchAllParticipating: () => Promise<Record<string, {
    id: string;
    subject?: string;
    participants?: Array<{ id: string }>;
    creation?: number;
    desc?: string;
  }>>;
  fetchMessageHistory: (
    count: number,
    oldestKey: { id: string; remoteJid: string; fromMe: boolean },
    oldestTs: number,
  ) => Promise<string>;
  onWhatsApp: (...phoneNumbers: string[]) => Promise<Array<{ jid: string; exists: boolean }> | undefined>;
  signalRepository?: { lidMapping?: { getPNForLID: (lid: string) => Promise<string | null> } };
}

/**
 * Like `whatsappSocket()` but typed to the structural API the MCP tools use.
 * Returns null when WhatsApp isn't paired/connected — callers must handle that
 * with a structured error.
 */
export function whatsappSocketApi(): WhatsAppSocketAPI | null {
  return whatsappSocket() as unknown as WhatsAppSocketAPI | null;
}

export function discordClient(): Client | null {
  return DiscordConnector.getInstance()?.client ?? null;
}

export function whatsappSocket(): WhatsAppSocket {
  return WhatsAppConnector.getInstance()?.socket ?? null;
}

export function telegramBot(): Bot | null {
  return TelegramConnector.getInstance()?.bot ?? null;
}
