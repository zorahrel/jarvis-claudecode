import { Client, GatewayIntentBits, Events, Partials } from "discord.js";
import type { Message } from "discord.js";
import type { Connector } from "./base";
import type { IncomingMessage, MediaAttachment, QuotedMessage, Config } from "../types";
import type { MessageTimings } from "../types/message";
import { findRoute } from "../services/router";
import { getConfig } from "../services/config-loader";
import { handleMessage } from "../services/handler";
import { chunkForDiscord } from "../services/discord-chunker";
import { canVoice, canVision } from "../services/capabilities";
import { setContactName } from "../services/contact-names";
import { logger } from "../services/logger";
import { processMedia, downloadMedia } from "../services/media";

const log = logger.child({ module: "discord" });

/**
 * Resolve Discord mention snowflakes to human-readable names.
 * Applied at the ingestion boundary so the rest of the system only sees clean text.
 *
 * Order matters: resolve user mentions before role mentions before channel mentions.
 *   <@ID> / <@!ID>  → @username   (fallback: @unknown)
 *   <@&ROLE_ID>     → @rolename   (fallback: @role)
 *   <#CHANNEL_ID>   → #channelname (fallback: #channel)
 */
function resolveDiscordMentions(text: string, msg: Message): string {
  // User mentions: <@123> or <@!123>
  let resolved = text.replace(/<@!?(\d+)>/g, (_, id: string) => {
    const username = msg.mentions.users.get(id)?.username;
    return `@${username ?? "unknown"}`;
  });

  // Role mentions: <@&123>
  resolved = resolved.replace(/<@&(\d+)>/g, (_, id: string) => {
    const roleName = msg.mentions.roles.get(id)?.name;
    return `@${roleName ?? "role"}`;
  });

  // Channel mentions: <#123>
  resolved = resolved.replace(/<#(\d+)>/g, (_, id: string) => {
    const ch = msg.mentions.channels.get(id);
    const channelName = ch && "name" in ch ? (ch as { name: string }).name : undefined;
    return `#${channelName ?? "channel"}`;
  });

  return resolved;
}

export class DiscordConnector implements Connector {
  readonly channel = "discord" as const;
  private static singleton: DiscordConnector | null = null;
  static getInstance(): DiscordConnector | null {
    return DiscordConnector.singleton;
  }

  private _client: Client | null = null;
  /** Read-only handle for in-process MCP tools (mcp/discord.ts). Null until start() succeeds. */
  get client(): Client | null { return this._client; }

  constructor(private config: Config) {
    DiscordConnector.singleton = this;
  }

  async start(): Promise<void> {
    const token = this.config.channels.discord?.botToken;
    if (!token) throw new Error("Discord bot token not configured");

    this._client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.User],
    });

    // Workaround: discord.js v14 sometimes doesn't emit MessageCreate for DMs
    // even with all required partials. Catch raw DM events and re-emit them.
    const dmProcessed = new Set<string>();
    this._client.on("raw" as any, async (event: any) => {
      if (event.t !== "MESSAGE_CREATE" || event.d?.guild_id) return;
      if (event.d?.author?.bot) return;
      const msgId = event.d?.id;
      if (!msgId) return;
      dmProcessed.add(msgId);
      // Give discord.js a tick to emit the normal event
      await new Promise(r => setTimeout(r, 500));
      if (!dmProcessed.has(msgId)) return; // already handled by normal event
      // discord.js didn't emit — fetch the channel & message manually
      try {
        const channel = await this._client!.channels.fetch(event.d.channel_id);
        if (!channel?.isTextBased()) return;
        const msg = await (channel as any).messages.fetch(msgId);
        if (msg) {
          log.debug({ authorId: msg.author?.id, isDM: true }, "DM recovered from raw event");
          this._client!.emit(Events.MessageCreate, msg);
        }
      } catch (err) {
        log.error({ err, msgId }, "Failed to recover DM from raw event");
      }
    });

    this._client.on(Events.MessageCreate, async (discordMsg) => {
      // Mark as handled so raw workaround doesn't double-process
      dmProcessed.delete(discordMsg.id);
      try {
      // Fetch full message if partial (required for DMs with Partials enabled)
      if (discordMsg.partial) {
        try { discordMsg = await discordMsg.fetch(); } catch { return; }
      }
      // Ignore bot messages
      if (discordMsg.author?.bot) return;
      // Ignore empty (unless has attachments or reference)
      if (!discordMsg.content && discordMsg.attachments.size === 0 && !discordMsg.reference) return;

      const botId = this._client?.user?.id;
      const isDM = !discordMsg.guildId;

      log.debug({ authorId: discordMsg.author?.id, guildId: discordMsg.guildId, isDM, content: discordMsg.content?.slice(0, 50) }, "Discord MessageCreate");

      // Route-based authorization: check if this message matches a configured route.
      // DMs match by `from` (user ID), guilds match by `guild` (guild ID).
      const previewMsg: any = {
        channel: "discord",
        from: discordMsg.author.id,
        group: discordMsg.guildId ?? undefined,
        text: "", timestamp: 0, reply: async () => {},
      };
      const matchedRoute = findRoute(previewMsg);
      if (!matchedRoute || matchedRoute.action === "ignore") {
        log.debug({ authorId: discordMsg.author?.id, isDM, matched: !!matchedRoute, action: matchedRoute?.action }, "Discord message not routed");
        return;
      }

      // In guilds: require @mention or reply-to-bot (don't respond to every message)
      if (!isDM) {
        const isMentioned = botId ? discordMsg.mentions.has(botId) : false;
        const isReplyToBot = discordMsg.reference?.messageId
          ? (await discordMsg.channel.messages.fetch(discordMsg.reference.messageId).catch(() => null))?.author?.id === botId
          : false;
        if (!isMentioned && !isReplyToBot) return;
      }

      // Strip bot mention from text, then resolve remaining mention snowflakes
      const strippedText = botId
        ? discordMsg.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim()
        : discordMsg.content;
      const cleanText = resolveDiscordMentions(strippedText, discordMsg);

      // Start pipeline timings
      const timings: MessageTimings = { received: Date.now() };

      // Cache guild/user names for dashboard
      if (discordMsg.guild) setContactName(discordMsg.guild.id, discordMsg.guild.name);
      if (discordMsg.author) setContactName(discordMsg.author.id, discordMsg.author.displayName ?? discordMsg.author.username);

      const agent = matchedRoute?.agent;
      const hasVoice = canVoice(agent);
      const hasVision = canVision(agent);

      // Process attachments
      const media: MediaAttachment[] = [];
      const hasAttachments = discordMsg.attachments.size > 0;
      if (hasAttachments) timings.mediaStart = Date.now();
      for (const [, att] of discordMsg.attachments) {
        try {
          const mime = att.contentType ?? "";
          let type: MediaAttachment["type"] = "document";
          if (mime.startsWith("audio/") || att.name?.endsWith(".ogg") || att.name?.endsWith(".mp3")) type = "voice";
          else if (mime.startsWith("image/")) type = "image";
          else if (mime.startsWith("video/")) type = "video";

          // Gate by tool authorization
          if ((type === "voice") && !hasVoice) {
            log.warn({ attName: att.name }, "Voice attachment but 'voice' tool not authorized — skipping");
            continue;
          }
          if ((type === "image" || type === "video") && !hasVision) {
            log.warn({ attName: att.name, type }, "Visual attachment but 'vision' tool not authorized — skipping");
            continue;
          }

          const localPath = await downloadMedia(att.url, att.name ?? "attachment");
          const processed = await processMedia(type, localPath, mime);
          media.push({ type, processedText: processed, localPath, fileName: att.name ?? undefined, mimeType: mime });
        } catch (err) {
          log.error({ err, attName: att.name }, "Error processing Discord attachment");
        }
      }
      if (hasAttachments) timings.mediaEnd = Date.now();

      // Process reply/reference
      let quotedMessage: QuotedMessage | undefined;
      if (discordMsg.reference?.messageId) {
        try {
          const refMsg = await discordMsg.channel.messages.fetch(discordMsg.reference.messageId);
          if (refMsg) {
            const rawQuotedText = refMsg.content || undefined;
            quotedMessage = {
              text: rawQuotedText ? resolveDiscordMentions(rawQuotedText, refMsg) : undefined,
              from: refMsg.author.username,
              timestampEpoch: Math.floor(refMsg.createdTimestamp / 1000),
            };
          }
        } catch { /* ignore */ }
      }

      // In guild contexts, prefix the speaker identity so multi-user threads are unambiguous.
      // DMs are single-speaker; no prefix needed there.
      // If cleanText came out empty (e.g. message was only the bot mention),
      // fall back to the ORIGINAL content with mentions resolved — never leak
      // raw `<@ID>` / `<@&ID>` snowflakes into the prompt by using the unresolved
      // discordMsg.content directly.
      const baseText = cleanText || resolveDiscordMentions(discordMsg.content, discordMsg);
      const finalText = discordMsg.guildId
        ? `[@${discordMsg.author.username}]: ${baseText}`
        : baseText;

      const channelName = "name" in discordMsg.channel
        ? (discordMsg.channel as { name: string }).name
        : undefined;
      const msg: IncomingMessage = {
        channel: "discord",
        from: discordMsg.author.id,
        group: discordMsg.guildId ?? undefined,
        replyTarget: discordMsg.channelId,
        text: finalText,
        timestamp: Math.floor(discordMsg.createdTimestamp / 1000),
        messageId: discordMsg.id,
        media: media.length > 0 ? media : undefined,
        quotedMessage,
        timings,
        channelContext: {
          discord: {
            guildId: discordMsg.guildId,
            guildName: discordMsg.guild?.name,
            channelId: discordMsg.channelId,
            channelName,
            authorId: discordMsg.author.id,
            authorName: discordMsg.author.displayName ?? discordMsg.author.username,
            messageId: discordMsg.id,
          },
        },
        reply: async (response: string) => {
          await discordMsg.reply(response);
        },
        sendFile: async (filePath: string, caption?: string) => {
          try {
            await discordMsg.reply({ content: caption || "", files: [filePath] });
          } catch (e) {
            log.error({ err: e, filePath }, "Failed to send file on Discord");
          }
        },
        startTyping: () => {
          const send = () => discordMsg.channel.sendTyping().catch(() => {});
          send();
          const interval = setInterval(send, 9000);
          return () => clearInterval(interval);
        },
        react: async (emoji: string) => {
          try {
            // Remove previous reaction emojis we may have set
            for (const r of discordMsg.reactions.cache.values()) {
              if (r.me) await r.users.remove().catch(() => {});
            }
            await discordMsg.react(emoji);
          } catch (e) {
            log.debug({ err: e, emoji }, "Failed to set Discord reaction");
          }
        },
        raw: discordMsg,
      };

      await handleMessage(msg);
      } catch (err) {
        log.error({ err, authorId: discordMsg?.author?.id }, "Unhandled error in Discord MessageCreate");
      }
    });


    this._client.on(Events.ClientReady, async (c) => {
      log.info({ user: c.user.tag }, "Discord bot ready");
      // Cache guild names for dashboard
      for (const [id, guild] of c.guilds.cache) {
        setContactName(id, guild.name);
      }
      // Cache names of users referenced in config routes (for DM display)
      try {
        const { routes } = getConfig();
        for (const r of routes) {
          if (r.match?.channel !== "discord" || !r.match?.from) continue;
          const userId = String(r.match.from);
          try {
            const user = await c.users.fetch(userId);
            if (user) setContactName(userId, user.displayName ?? user.globalName ?? user.username);
          } catch { /* user not fetchable */ }
        }
      } catch { /* ignore */ }
    });

    this._client.on(Events.Error, (err) => {
      log.error({ err }, "Discord client error");
    });

    await this._client.login(token);
  }

  async stop(): Promise<void> {
    await this._client?.destroy();
    this._client = null;
    log.info("Discord bot stopped");
  }

  /** Send a text message to a channel — used by cron delivery and crash recovery notices.
   *  `target` is a Discord channel.id (works for both DMs and guild channels). */
  async sendMessage(target: string, text: string): Promise<void> {
    if (!this._client) throw new Error("Discord client not started");
    const channel = await this._client.channels.fetch(target);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      throw new Error(`Discord channel ${target} not sendable`);
    }
    // Discord caps single messages at 2000 chars — chunker splits preserving code fences.
    const chunks = chunkForDiscord(text);
    for (const chunk of chunks) {
      await (channel as any).send(chunk);
    }
  }

  updateConfig(config: Config): void {
    this.config = config;
  }
}
