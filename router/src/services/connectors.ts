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

export function discordClient(): Client | null {
  return DiscordConnector.getInstance()?.client ?? null;
}

export function whatsappSocket(): WhatsAppSocket {
  return WhatsAppConnector.getInstance()?.socket ?? null;
}

export function telegramBot(): Bot | null {
  return TelegramConnector.getInstance()?.bot ?? null;
}
