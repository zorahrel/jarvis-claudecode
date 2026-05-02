import { Bot, InputFile } from "grammy";
import type { Connector } from "./base";
import type { IncomingMessage, MediaAttachment, QuotedMessage, Config } from "../types";
import type { MessageTimings } from "../types/message";
import { findRoute } from "../services/router";
import { handleMessage, splitMessage } from "../services/handler";
import { canVoice, canVision } from "../services/capabilities";
import { setContactName } from "../services/contact-names";
import { logger } from "../services/logger";
import { processMedia, downloadMedia, saveMedia, cleanupMedia } from "../services/media";
import { pushTelegram } from "../services/message-buffer";
import { loadSlashCommands, pickMenuCommands, rewriteIncomingSlash, handleRouterCommand, type SlashCommand } from "../services/slash-commands";
import { basename } from "path";

const log = logger.child({ module: "telegram" });

export class TelegramConnector implements Connector {
  readonly channel = "telegram" as const;
  private static singleton: TelegramConnector | null = null;
  static getInstance(): TelegramConnector | null {
    return TelegramConnector.singleton;
  }

  private _bot: Bot | null = null;
  /** Read-only handle for in-process MCP tools (mcp/telegram.ts). Null until start() succeeds. */
  get bot(): Bot | null { return this._bot; }

  private slashCatalog: SlashCommand[] = [];

  constructor(private config: Config) {
    TelegramConnector.singleton = this;
  }

  async start(): Promise<void> {
    const token = this.config.channels.telegram?.botToken;
    if (!token) throw new Error("Telegram bot token not configured");

    this._bot = new Bot(token);

    // Handle ALL messages (text, voice, photo, document, video_note, audio)
    this._bot.on("message", async (ctx) => {
      const chatId = ctx.chat.id;
      const messageId = ctx.message.message_id;
      const m = ctx.message;

      // Start pipeline timings
      const timings: MessageTimings = { received: Date.now() };

      // Extract text — rewrite TG-safe slash names (e.g. /caveman_compress) back
      // to the CLI form (/caveman-compress) so Claude Code recognizes them.
      let text = m.text ?? m.caption ?? "";
      if (text && this.slashCatalog.length > 0) {
        text = rewriteIncomingSlash(text, this.slashCatalog);
      }

      // Router-native short-circuit (/help, /clear, /cost, /status) — reply
      // without spawning Claude.
      if (text && this.slashCatalog.length > 0) {
        const routerReply = handleRouterCommand(text, this.slashCatalog, {
          channel: "telegram",
          from: String(ctx.from?.id ?? ""),
          group: ctx.chat.type !== "private" ? String(chatId) : undefined,
        });
        if (routerReply) {
          try {
            await ctx.reply(routerReply, { parse_mode: "Markdown" });
          } catch {
            await ctx.reply(routerReply);
          }
          return;
        }
      }

      // Cache contact/group names for dashboard
      if (ctx.from) {
        const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
        if (name) setContactName(String(ctx.from.id), name);
      }
      if (ctx.chat.type !== "private" && (ctx.chat as any).title) {
        setContactName(String(chatId), (ctx.chat as any).title);
      }

      // Preview route to check tool authorization BEFORE downloading/processing media
      const previewMsg: any = {
        channel: "telegram",
        from: String(ctx.from?.id),
        group: ctx.chat.type !== "private" ? String(chatId) : undefined,
        text: "",
        timestamp: 0,
        reply: async () => {},
      };
      const previewRoute = findRoute(previewMsg);
      const agent = previewRoute?.agent;
      const hasVoice = canVoice(agent);
      const hasVision = canVision(agent);

      // Determine what will actually be processed (gated by tools)
      const willVoice = (!!(m.voice || m.audio)) && hasVoice;
      const willImage = !!(m.photo && m.photo.length > 0) && hasVision;
      const willVideo = (!!(m.video || m.video_note)) && hasVision;
      const willDoc = !!m.document;
      const willProcess = willVoice || willImage || willVideo || willDoc;

      // Process media
      const media: MediaAttachment[] = [];
      if (willProcess) timings.mediaStart = Date.now();

      try {
        if (m.voice && hasVoice) {
          const attachment = await this.downloadTgFile(token, m.voice.file_id, "voice.ogg");
          if (attachment) {
            attachment.type = "voice";
            attachment.mimeType = m.voice.mime_type;
            attachment.processedText = await processMedia("voice", attachment.localPath!);
            media.push(attachment);
          }
        } else if (m.voice) {
          log.warn({ from: previewMsg.from }, "Voice received but 'voice' tool not authorized — skipping");
        }

        if (m.audio && hasVoice) {
          const attachment = await this.downloadTgFile(token, m.audio.file_id, m.audio.file_name ?? "audio.ogg");
          if (attachment) {
            attachment.type = "audio";
            attachment.mimeType = m.audio.mime_type;
            attachment.processedText = await processMedia("audio", attachment.localPath!);
            media.push(attachment);
          }
        } else if (m.audio) {
          log.warn({ from: previewMsg.from }, "Audio received but 'voice' tool not authorized — skipping");
        }

        if (m.photo && m.photo.length > 0 && hasVision) {
          const largest = m.photo[m.photo.length - 1];
          const attachment = await this.downloadTgFile(token, largest.file_id, "photo.jpg");
          if (attachment) {
            attachment.type = "image";
            attachment.mimeType = "image/jpeg";
            attachment.processedText = await processMedia("image", attachment.localPath!);
            media.push(attachment);
          }
        } else if (m.photo && m.photo.length > 0) {
          log.warn({ from: previewMsg.from }, "Photo received but 'vision' tool not authorized — skipping");
        }

        if (m.document) {
          const attachment = await this.downloadTgFile(token, m.document.file_id, m.document.file_name ?? "document");
          if (attachment) {
            attachment.type = "document";
            attachment.mimeType = m.document.mime_type;
            attachment.fileName = m.document.file_name;
            attachment.processedText = await processMedia("document", attachment.localPath!, m.document.mime_type);
            media.push(attachment);
          }
        }

        if (m.video_note && hasVision) {
          const attachment = await this.downloadTgFile(token, m.video_note.file_id, "videonote.mp4");
          if (attachment) {
            attachment.type = "video";
            attachment.mimeType = "video/mp4";
            attachment.processedText = await processMedia("video", attachment.localPath!);
            media.push(attachment);
          }
        } else if (m.video_note) {
          log.warn({ from: previewMsg.from }, "Video note received but 'vision' tool not authorized — skipping");
        }

        if (m.video && hasVision) {
          const attachment = await this.downloadTgFile(token, m.video.file_id, m.video.file_name ?? "video.mp4");
          if (attachment) {
            attachment.type = "video";
            attachment.mimeType = m.video.mime_type;
            attachment.processedText = await processMedia("video", attachment.localPath!);
            media.push(attachment);
          }
        } else if (m.video) {
          log.warn({ from: previewMsg.from }, "Video received but 'vision' tool not authorized — skipping");
        }
      } catch (err) {
        log.error({ err }, "Error processing Telegram media");
      }
      if (willProcess) timings.mediaEnd = Date.now();

      // Process quoted/reply message
      let quotedMessage: QuotedMessage | undefined;
      if (m.reply_to_message) {
        const reply = m.reply_to_message;
        quotedMessage = {
          text: reply.text ?? reply.caption,
          from: reply.from?.first_name ?? reply.from?.username ?? String(reply.from?.id),
        };
      }

      // Skip if no text and no media
      if (!text && media.length === 0 && !quotedMessage) return;

      // Capture into the local Telegram ring buffer so MCP read tools can serve it.
      // We do this even when the message is *not* routed to an agent — the buffer
      // is the only history we have on Telegram.
      pushTelegram(String(chatId), {
        id: String(messageId),
        fromId: ctx.from ? String(ctx.from.id) : undefined,
        fromName: ctx.from
          ? [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || ctx.from.username
          : undefined,
        text,
        ts: m.date,
      });

      const chatTitle = ctx.chat.type !== "private" && (ctx.chat as { title?: string }).title
        ? (ctx.chat as { title: string }).title
        : undefined;
      const msg: IncomingMessage = {
        channel: "telegram",
        from: String(ctx.from?.id),
        group: ctx.chat.type !== "private" ? String(chatId) : undefined,
        replyTarget: String(chatId),
        text,
        timestamp: m.date,
        messageId: String(messageId),
        media: media.length > 0 ? media : undefined,
        quotedMessage,
        timings,
        channelContext: {
          telegram: {
            chatId: String(chatId),
            chatType: ctx.chat.type as "private" | "group" | "supergroup" | "channel",
            chatTitle,
            fromId: ctx.from ? String(ctx.from.id) : undefined,
            fromUsername: ctx.from?.username,
            messageId,
          },
        },
        reply: async (response: string) => {
          try {
            await ctx.reply(response, { parse_mode: "Markdown" });
          } catch {
            // Markdown parse can fail on unbalanced * or _ — fall back to plain text
            await ctx.reply(response);
          }
        },
        sendFile: async (filePath: string, caption?: string) => {
          try {
            const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
            const imageExts = ["jpg", "jpeg", "png", "gif", "webp"];
            if (imageExts.includes(ext)) {
              await ctx.replyWithPhoto(new InputFile(filePath), { caption });
            } else {
              await ctx.replyWithDocument(new InputFile(filePath), { caption });
            }
          } catch (e) {
            log.error({ err: e, filePath }, "Failed to send file on Telegram");
          }
        },
        startTyping: () => {
          const send = () => ctx.replyWithChatAction("typing").catch(() => {});
          send();
          const interval = setInterval(send, 5000);
          return () => clearInterval(interval);
        },
        react: async (emoji: string) => {
          try {
            await ctx.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji } as any]);
          } catch (e) {
            log.debug({ err: e, emoji }, "Failed to set Telegram reaction");
          }
        },
        raw: ctx,
      };

      await handleMessage(msg);
    });

    this._bot.catch((err) => {
      log.error({ err: err.error }, "Telegram bot error");
    });

    this._bot.start({
      onStart: () => log.info("Telegram bot started"),
    });

    // Publish slash commands to Telegram's native `/` menu. Runs after start
    // so failures don't block the bot — it's a UX polish, not critical path.
    this.syncSlashCommands().catch(err =>
      log.warn({ err }, "Failed to sync Telegram slash commands"),
    );
  }

  /** Register the user's Claude Code slash commands with Telegram's /-menu.
   *  Retries once after 60 s if the first attempt fails (handles DNS-not-ready
   *  at boot: bot.start() works via long-poll but setMyCommands hits the API). */
  private async syncSlashCommands(): Promise<void> {
    if (!this._bot) return;
    this.slashCatalog = loadSlashCommands();
    if (this.slashCatalog.length === 0) {
      log.debug("No slash commands to register");
      return;
    }
    const menu = pickMenuCommands(this.slashCatalog);
    const payload = menu.map(c => ({ command: c.tgName, description: c.description }));
    const trySync = async (): Promise<true | { err: unknown; menuSize: number }> => {
      try {
        await this._bot!.api.setMyCommands(payload);
        log.info(
          { menu: payload.length, catalog: this.slashCatalog.length },
          "Registered Telegram slash commands",
        );
        return true;
      } catch (err) {
        return { err, menuSize: payload.length };
      }
    };
    const first = await trySync();
    if (first !== true) {
      log.warn({ ...first }, "setMyCommands failed — retrying once in 60s");
      // Single retry after 60 s — covers the common case where DNS comes up
      // a few seconds after the bot long-poll already succeeded.
      await new Promise((r) => setTimeout(r, 60_000));
      const second = await trySync();
      if (second !== true) {
        log.warn({ ...second }, "setMyCommands failed on retry — giving up (menu will stay out of date until next boot)");
      }
    }
  }

  /** Download a Telegram file by file_id */
  private async downloadTgFile(token: string, fileId: string, filename: string): Promise<MediaAttachment | null> {
    try {
      const bot = this._bot!;
      const file = await bot.api.getFile(fileId);
      if (!file.file_path) return null;

      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const localPath = await downloadMedia(url, filename);

      return {
        type: "document", // caller will override
        localPath,
      };
    } catch (err) {
      log.error({ err, fileId }, "Failed to download Telegram file");
      return null;
    }
  }

  async stop(): Promise<void> {
    await this._bot?.stop();
    this._bot = null;
    log.info("Telegram bot stopped");
  }

  /** Send a text message to an arbitrary chat — used by cron delivery and crash recovery notices.
   *  Splits payloads above Telegram's 4096-char cap across sequential messages. */
  async sendMessage(target: string, text: string): Promise<void> {
    if (!this._bot) throw new Error("Telegram bot not started");
    const chunks = splitMessage(text, 4000);
    for (const chunk of chunks) {
      try {
        await this._bot.api.sendMessage(target, chunk, { parse_mode: "Markdown" });
      } catch {
        await this._bot.api.sendMessage(target, chunk);
      }
    }
  }

  updateConfig(config: Config): void {
    this.config = config;
  }
}
