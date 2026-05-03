import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers, downloadMediaMessage, proto } from "@whiskeysockets/baileys";
import pino from "pino";
type WASocket = ReturnType<typeof makeWASocket>;
import type { Connector } from "./base";
import type { IncomingMessage, MediaAttachment, QuotedMessage, Config } from "../types";
import type { MessageTimings } from "../types/message";
import { handleMessage, splitMessage } from "../services/handler";
import { findRoute, getFullAgent } from "../services/router";
import { canVoice, canVision } from "../services/capabilities";
import { setContactName } from "../services/contact-names";
import { getConfig } from "../services/config-loader";
import { logger } from "../services/logger";
import { processMedia, saveMedia, cleanupMedia } from "../services/media";
import { pushMessage as pushWaHistory, pushBulk as pushWaHistoryBulk, type WAStoredMessage } from "../services/whatsapp-history";
import { readFileSync, rmSync, existsSync } from "fs";
import { basename, extname } from "path";
import { EventEmitter } from "events";

const log = logger.child({ module: "whatsapp" });

// ============================================================
// PAIRING STATE — exposed to dashboard via getInstance()
// ============================================================

export type WAStatus =
  | "idle"
  | "connecting"
  | "qr"
  | "pairing-code"
  | "connected"
  | "logged-out"
  | "error";

export interface WAStatusSnapshot {
  status: WAStatus;
  qr?: string;
  pairingCode?: string;
  pairingPhone?: string;
  jid?: string;
  error?: string;
  updatedAt: number;
}

// ============================================================
// CONFIG
// ============================================================

/** Owner phone (can invoke @Jarvis anywhere) */
// Owner phone: first entry in jarvis.allowedCallers, stripped of "+" for WA JID matching
function getOwnerPhone(): string {
  const cfg = getConfig();
  const first: string = (cfg as any).jarvis?.allowedCallers?.[0] ?? "";
  return first.replace(/^\+/, "");
}

// ============================================================
// HELPERS
// ============================================================

/** Owner can invoke the full agent from any chat by mentioning @jarvis. One-shot (no session). */
function isJarvisInvocation(text: string): boolean {
  const l = text.toLowerCase();
  return l.includes("@jarvis") || l.startsWith("jarvis ");
}

function hasExplicitRoute(jid: string, isGroup: boolean): boolean {
  const { routes } = getConfig();
  if (routes.some((r) => r.match?.jid === jid)) return true;
  if (isGroup) return routes.some((r) => r.match?.group === jid);
  // Phone match: strip LID/whatsapp suffix
  const phone = "+" + jid.replace(/@(s\.whatsapp\.net|lid)$/, "").split(":")[0];
  return routes.some((r) => String(r.match?.from) === phone);
}

function isOwnerMessage(fromMe: boolean, senderPhone: string): boolean {
  return fromMe || senderPhone === getOwnerPhone();
}

/**
 * Extract a minimal `WAStoredMessage` from a Baileys `WAMessage`. Returns null
 * for status broadcasts and messages without a remoteJid (we can't index them).
 */
function toStoredMessage(waMsg: any): WAStoredMessage | null {
  const jid = waMsg?.key?.remoteJid;
  if (!jid || jid === "status@broadcast") return null;
  const m = waMsg.message ?? {};
  const text =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    "";
  let mediaType: WAStoredMessage["mediaType"] | undefined;
  if (m.imageMessage) mediaType = "image";
  else if (m.videoMessage) mediaType = "video";
  else if (m.audioMessage) mediaType = m.audioMessage.ptt ? "voice" : "audio";
  else if (m.documentMessage) mediaType = "document";
  else if (m.stickerMessage) mediaType = "sticker";
  const ts = typeof waMsg.messageTimestamp === "number"
    ? waMsg.messageTimestamp
    : Number(waMsg.messageTimestamp ?? 0);
  return {
    id: waMsg.key.id ?? "",
    chatJid: jid,
    fromJid: waMsg.key.participant ?? (waMsg.key.fromMe ? undefined : jid),
    fromName: waMsg.pushName,
    text: typeof text === "string" ? text : "",
    ts,
    fromMe: !!waMsg.key.fromMe,
    mediaType,
  };
}

// ============================================================
// CONNECTOR
// ============================================================

/** Simple in-memory cache implementing Baileys CacheStore interface */
function makeCache(): { get<T>(key: string): T | undefined; set<T>(key: string, value: T): void; del(key: string): void; flushAll(): void } {
  const store = new Map<string, any>();
  return {
    get: <T>(key: string) => store.get(key) as T | undefined,
    set: <T>(key: string, value: T) => { store.set(key, value); },
    del: (key: string) => { store.delete(key); },
    flushAll: () => { store.clear(); },
  };
}

export class WhatsAppConnector implements Connector {
  readonly channel = "whatsapp" as const;
  private static instance: WhatsAppConnector | null = null;
  static getInstance(): WhatsAppConnector | null {
    return WhatsAppConnector.instance;
  }

  private sock: WASocket | null = null;
  /** Read-only handle for in-process MCP tools (mcp/whatsapp.ts). Null until paired+connected. */
  get socket(): WASocket | null { return this.sock; }
  private authDir: string;
  private selfJid: string = "";
  private myLidBase: string = "";
  /** Store sent messages for retry handling */
  private msgStore = new Map<string, proto.IMessage>();
  /** Track message IDs sent by us to avoid self-loop */
  private sentMsgIds = new Set<string>();

  /** Phone number requested for next pairing-code start (E.164 digits, no +) */
  private pendingPairingPhone: string | null = null;
  private snapshot: WAStatusSnapshot = { status: "idle", updatedAt: Date.now() };
  readonly events = new EventEmitter();

  getStatus(): WAStatusSnapshot {
    return this.snapshot;
  }

  private setStatus(patch: Partial<WAStatusSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, updatedAt: Date.now() };
    this.events.emit("status", this.snapshot);
  }

  /**
   * Force a fresh pairing flow from the dashboard. Stops the current socket,
   * wipes the auth dir on disk, then re-runs `start()`. If `phoneNumber` is
   * provided (E.164 with or without +), Baileys will surface an 8-char pairing
   * code instead of a QR — easier to type into the WhatsApp mobile app.
   */
  async relink(opts?: { phoneNumber?: string }): Promise<void> {
    log.warn({ pairing: !!opts?.phoneNumber }, "WhatsApp relink requested");
    this.pendingPairingPhone = opts?.phoneNumber
      ? opts.phoneNumber.replace(/[^0-9]/g, "")
      : null;
    try {
      this.sock?.ev.removeAllListeners("connection.update");
      this.sock?.ev.removeAllListeners("messages.upsert");
      this.sock?.ev.removeAllListeners("creds.update");
      this.sock?.end(undefined);
    } catch {}
    this.sock = null;
    if (existsSync(this.authDir)) {
      try { rmSync(this.authDir, { recursive: true, force: true }); } catch (err) {
        log.error({ err }, "Failed to wipe wa-auth dir");
      }
    }
    this.setStatus({ status: "connecting", qr: undefined, pairingCode: undefined, error: undefined, jid: undefined });
    await this.start();
  }

  constructor(private config: Config) {
    this.authDir = config.channels.whatsapp?.authDir ?? "./auth_info";
    WhatsAppConnector.instance = this;
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();
    const silentLogger = pino({ level: "silent" });

    log.info({ version: version.join(".") }, "WhatsApp connecting...");
    this.setStatus({ status: "connecting", qr: undefined, pairingCode: undefined, error: undefined });

    const msgRetryCounterCache = makeCache();
    const userDevicesCache = makeCache();

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
      },
      version,
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome"),
      logger: silentLogger,
      msgRetryCounterCache,
      userDevicesCache,
      getMessage: async (key) => {
        const id = key.id;
        if (id && this.msgStore.has(id)) return this.msgStore.get(id)!;
        return undefined;
      },
    });

    this.sock.ev.on("creds.update", saveCreds);

    // If the dashboard requested pairing-code mode AND this is a fresh auth,
    // ask Baileys for an 8-char code instead of relying on the QR. Must be
    // called once after socket creation, before the first `connection.update`.
    if (this.pendingPairingPhone && !state.creds.registered) {
      const phone = this.pendingPairingPhone;
      this.pendingPairingPhone = null;
      // Baileys requires the request to fire after the socket is ready;
      // setTimeout(0) is enough — internally it waits for the noise handshake.
      setTimeout(async () => {
        try {
          const code = await this.sock!.requestPairingCode(phone);
          log.info({ phone, code }, "WhatsApp pairing code issued");
          this.setStatus({ status: "pairing-code", pairingCode: code, pairingPhone: phone });
        } catch (err: any) {
          log.error({ err: err?.message, phone }, "Failed to request pairing code");
          this.setStatus({ status: "error", error: err?.message ?? "pairing code failed" });
        }
      }, 0);
    }

    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update as any;
      if (qr) {
        log.info("=== SCAN QR CODE WITH WHATSAPP ===");
        log.info({ qr }, "QR code (use any QR renderer or WhatsApp > Linked Devices)");
        // Only flip to "qr" status if the user didn't request a pairing code.
        if (this.snapshot.status !== "pairing-code") {
          this.setStatus({ status: "qr", qr });
        } else {
          // Keep pairing-code status, but stash the QR as a fallback the UI can offer.
          this.setStatus({ qr });
        }
      }
      if (connection === "close") {
        const code = (lastDisconnect?.error as any)?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          log.warn({ code }, "WhatsApp disconnected, reconnecting...");
          this.setStatus({ status: "connecting", error: `disconnected (${code ?? "?"})` });
          this.start();
        } else {
          log.error("WhatsApp logged out — manual re-auth needed");
          this.setStatus({ status: "logged-out", qr: undefined, pairingCode: undefined });
        }
      } else if (connection === "open") {
        this.selfJid = this.sock?.user?.id ?? "";
        this.myLidBase = (this.sock?.user as any)?.lid?.split(":")[0]?.split("@")[0] || "";
        log.info({ selfJid: this.selfJid, myLidBase: this.myLidBase }, "WhatsApp connected");
        this.setStatus({ status: "connected", jid: this.selfJid, qr: undefined, pairingCode: undefined, error: undefined });
        // Fetch group names for all configured group routes
        this.cacheGroupNames();
      }
    });

    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      // Capture into the WhatsApp history store for the in-process MCP. We do
      // this for ALL upserts (live + backfill `notify` with requestId), so
      // mcp/whatsapp.ts can serve historical reads without needing a separate
      // CLI/auth/process. Bot's own outbound messages are also captured.
      for (const waMsg of messages) {
        const stored = toStoredMessage(waMsg);
        if (stored) pushWaHistory(stored);
      }

      if (type !== "notify" && type !== "append") return;
      for (const waMsg of messages) {
        try {
          await this.processMessage(waMsg);
        } catch (err) {
          log.error({ err, msgId: waMsg.key.id }, "Error processing WA message");
        }
      }
    });

    // Initial history sync after pair (and on reconnects when Baileys decides
    // to re-sync). Up to ~14 days of past messages arrive in one shot —
    // bulk-ingest into the store.
    this.sock.ev.on("messaging-history.set", ({ messages, isLatest, progress }) => {
      if (!messages || messages.length === 0) return;
      const stored = messages
        .map(toStoredMessage)
        .filter((m): m is WAStoredMessage => m !== null);
      pushWaHistoryBulk(stored);
      log.info(
        { count: stored.length, isLatest, progress },
        "WhatsApp history sync ingested",
      );
    });
  }

  /** Fetch and cache real group names from WhatsApp for all configured group routes */
  private async cacheGroupNames(): Promise<void> {
    try {
      const { routes } = getConfig();
      const groupJids = routes
        .filter(r => r.match?.group)
        .map(r => r.match.group!)
        .filter(g => g.endsWith("@g.us"));
      for (const jid of groupJids) {
        try {
          const meta = await this.sock?.groupMetadata(jid);
          if (meta?.subject) {
            setContactName(jid, meta.subject);
            log.debug({ jid, subject: meta.subject }, "Cached WA group name");
          }
        } catch { /* group not accessible or not joined */ }
      }
    } catch (err) {
      log.warn({ err }, "Failed to cache WA group names");
    }
  }

  /** Find matching route for this JID */
  private getRouteForJid(jid: string, isGroup: boolean): any | null {
    const { routes } = getConfig();
    for (const r of routes) {
      if (r.match?.jid === jid) return r;
      if (isGroup && r.match?.group === jid) return r;
      const phone = "+" + jid.replace(/@(s\.whatsapp\.net|lid)$/, "").split(":")[0];
      if (String(r.match?.from) === phone) return r;
    }
    return null;
  }

  /** Is this JID our self-chat? */
  private isSelfChat(jid: string): boolean {
    // Phone format: <phone>@s.whatsapp.net matches selfJid <phone>:XX@s.whatsapp.net
    const selfPhone = this.selfJid.split(":")[0].split("@")[0];
    const remotePhone = jid.split(":")[0].split("@")[0];
    if (selfPhone && selfPhone === remotePhone) return true;
    // LID format: our LID base matches remote LID base
    if (this.myLidBase && remotePhone === this.myLidBase) return true;
    return false;
  }

  /** Get the reply JID (convert LID to s.whatsapp.net for self-chat) */
  private getReplyJid(jid: string): string {
    if (this.isSelfChat(jid) && jid.endsWith("@lid")) {
      const selfPhone = this.selfJid.split(":")[0].split("@")[0];
      return selfPhone + "@s.whatsapp.net";
    }
    return jid;
  }

  private async processMessage(waMsg: any): Promise<void> {
    if (waMsg.key.remoteJid === "status@broadcast") return;

    // Skip messages we sent ourselves (prevents self-chat loop)
    const msgId = waMsg.key.id;
    if (msgId && this.sentMsgIds.has(msgId)) {
      this.sentMsgIds.delete(msgId);
      return;
    }

    // Start pipeline timings
    const timings: MessageTimings = { received: Date.now() };

    const text = waMsg.message?.conversation ?? waMsg.message?.extendedTextMessage?.text ?? "";

    // Pre-compute routing context
    const jid = waMsg.key.remoteJid ?? "";
    const isGroup = jid.endsWith("@g.us");
    const fromMe = waMsg.key.fromMe ?? false;
    const senderJid = isGroup ? waMsg.key.participant ?? "" : jid;
    const senderPhone = senderJid.split(":")[0].split("@")[0];

    // Cache sender pushName for dashboard friendly display
    if (waMsg.pushName && senderPhone) {
      setContactName("+" + senderPhone, waMsg.pushName);
    }
    const selfChat = this.isSelfChat(jid);
    const owner = isOwnerMessage(fromMe, senderPhone);

    // Quoted message + "reply to Jarvis" detection (needed for decision tree)
    let quotedMessage: QuotedMessage | undefined;
    const ctxInfo = waMsg.message?.extendedTextMessage?.contextInfo ?? waMsg.message?.imageMessage?.contextInfo ?? waMsg.message?.audioMessage?.contextInfo;
    if (ctxInfo?.quotedMessage) {
      quotedMessage = {
        text: ctxInfo.quotedMessage.conversation ?? ctxInfo.quotedMessage.extendedTextMessage?.text,
        from: ctxInfo.participant ? "+" + ctxInfo.participant.split(":")[0].split("@")[0] : undefined,
      };
    }
    const quotedParticipant = ctxInfo?.participant ?? "";
    const isReplyToJarvis = quotedParticipant === this.selfJid ||
      (!!this.myLidBase && quotedParticipant.split(":")[0]?.split("@")[0] === this.myLidBase);

    // ── DECISION TREE ──────────────────────────────────────
    //
    // 1. Self-chat + fromMe                          → route (from:self → full)
    // 2. alwaysReplyGroups                           → route
    // 3. @jarvis + owner (ONE-SHOT, no session)      → full agent override
    // 4. Reply to a Jarvis message (not fromMe)      → route
    // 5. Explicit route + alwaysReply                → route
    // 6. Everything else                             → skip (no eye, no download)
    //
    // Rationale: @jarvis is owner-only and one-shot — each invocation is
    // processed with the full agent regardless of chat; no 30-min session.
    // The decision is computed BEFORE touching media so we don't drop 👀
    // eyes on attachments that will be ignored.
    // ───────────────────────────────────────────────────────
    const config = getConfig();
    const alwaysReplyGroups: string[] = (config as any).jarvis?.alwaysReplyGroups ?? [];
    const isBotSent = fromMe && !!msgId && this.sentMsgIds.has(msgId);
    const jarvisInvoked = isJarvisInvocation(text);

    type Decision =
      | { kind: "skip" }
      | { kind: "self" }
      | { kind: "alwaysReplyGroup" }
      | { kind: "jarvisOneShot" }
      | { kind: "replyToJarvis" }
      | { kind: "explicitRoute" };

    let decision: Decision = { kind: "skip" };
    if (selfChat && fromMe) {
      decision = { kind: "self" };
    } else if (isGroup && alwaysReplyGroups.includes(jid)) {
      decision = { kind: "alwaysReplyGroup" };
    } else if (jarvisInvoked) {
      if (!owner) {
        log.debug({ jid, from: senderPhone }, "@jarvis invoked by non-owner — ignoring");
        return;
      }
      decision = { kind: "jarvisOneShot" };
    } else if (isReplyToJarvis && !fromMe) {
      decision = { kind: "replyToJarvis" };
    } else if (hasExplicitRoute(jid, isGroup) && !isBotSent) {
      const route = this.getRouteForJid(jid, isGroup);
      if (route?.agent?.alwaysReply !== false) {
        decision = { kind: "explicitRoute" };
      }
    }

    if (decision.kind === "skip") {
      if (isGroup) log.debug({ jid, from: senderPhone }, "Skipped group message (no route)");
      return;
    }

    // We WILL respond — now resolve the agent used for capability checks.
    // @jarvis one-shots use the full agent regardless of the chat's preview route.
    let agent: import("../types").AgentConfig | undefined;
    let previewRouteMatch: any;
    if (decision.kind === "jarvisOneShot") {
      agent = getFullAgent();
    } else {
      const previewFrom = (selfChat && fromMe) ? "self" : "+" + senderPhone;
      const previewMsg: any = {
        channel: "whatsapp",
        from: previewFrom,
        group: isGroup ? jid : undefined,
        rawJid: jid,
        text: "",
        timestamp: 0,
        reply: async () => {},
      };
      const previewRoute = findRoute(previewMsg);
      agent = previewRoute?.agent;
      previewRouteMatch = previewRoute?.match;
    }
    const hasVoice = canVoice(agent);
    const hasVision = canVision(agent);

    const wm = waMsg.message;
    const hasVoiceMsg = !!(wm?.audioMessage || wm?.pttMessage);
    const hasImageMsg = !!wm?.imageMessage;
    const hasDocMsg = !!wm?.documentMessage;
    const hasAnyMedia = hasVoiceMsg || hasImageMsg || hasDocMsg;
    const willProcessVoice = hasVoiceMsg && hasVoice;
    const willProcessImage = hasImageMsg && hasVision;
    const willProcessDoc = hasDocMsg; // documents always allowed when chat is routed
    const willProcess = willProcessVoice || willProcessImage || willProcessDoc;

    // 👀 reaction only once we've confirmed the chat is actually routed
    if (hasAnyMedia && willProcess) {
      this.sock?.sendMessage(jid, { react: { text: "👀", key: waMsg.key } }).catch(() => {});
    }

    // Process media (only authorized types, and only now that we'll respond)
    const media: MediaAttachment[] = [];
    if (willProcess) timings.mediaStart = Date.now();
    try {
      if (willProcessVoice) {
        const buffer = await downloadMediaMessage(waMsg, "buffer", {});
        const path = saveMedia(buffer as Buffer, "voice.ogg");
        const processed = await processMedia("voice", path);
        media.push({ type: "voice", processedText: processed, caption: wm!.audioMessage?.caption });
      } else if (hasVoiceMsg) {
        log.warn({ jid, route: previewRouteMatch }, "Voice received but 'voice' tool not authorized — skipping transcription");
      }
      if (willProcessImage) {
        const buffer = await downloadMediaMessage(waMsg, "buffer", {});
        const path = saveMedia(buffer as Buffer, "image.jpg");
        const processed = await processMedia("image", path);
        media.push({ type: "image", processedText: processed, localPath: path, caption: wm!.imageMessage!.caption || undefined });
      } else if (hasImageMsg) {
        log.warn({ jid, route: previewRouteMatch }, "Image received but 'vision' tool not authorized — skipping processing");
      }
      if (willProcessDoc) {
        const buffer = await downloadMediaMessage(waMsg, "buffer", {});
        const fname = wm!.documentMessage!.fileName || "document";
        const path = saveMedia(buffer as Buffer, fname);
        const processed = await processMedia("document", path, wm!.documentMessage!.mimetype || undefined);
        media.push({ type: "document", processedText: processed, fileName: fname, caption: wm!.documentMessage!.caption || undefined });
      }
    } catch (err) {
      log.error({ err }, "Error processing WhatsApp media");
    }

    // Quoted media — when the user replies to an audio/image/document with
    // something like "@jarvis trascrivi", we need the quoted attachment to be
    // processed too. Without this the agent only sees the reply text and has
    // no idea what to transcribe / look at.
    const quotedWm = ctxInfo?.quotedMessage;
    if (quotedWm && quotedMessage) {
      const qHasVoice = !!(quotedWm.audioMessage || quotedWm.pttMessage);
      const qHasImage = !!quotedWm.imageMessage;
      const qHasDoc = !!quotedWm.documentMessage;
      if (qHasVoice || qHasImage || qHasDoc) {
        const fakeMsg: any = {
          key: {
            remoteJid: jid,
            id: ctxInfo!.stanzaId ?? undefined,
            fromMe: ctxInfo!.participant === this.selfJid,
            participant: ctxInfo!.participant ?? undefined,
          },
          message: quotedWm,
        };
        const quotedMedia: MediaAttachment[] = [];
        try {
          if (qHasVoice && hasVoice) {
            const buffer = await downloadMediaMessage(fakeMsg, "buffer", {});
            const path = saveMedia(buffer as Buffer, "quoted-voice.ogg");
            const processed = await processMedia("voice", path);
            quotedMedia.push({ type: "voice", processedText: processed });
          }
          if (qHasImage && hasVision) {
            const buffer = await downloadMediaMessage(fakeMsg, "buffer", {});
            const path = saveMedia(buffer as Buffer, "quoted-image.jpg");
            const processed = await processMedia("image", path);
            quotedMedia.push({ type: "image", processedText: processed, localPath: path });
          }
          if (qHasDoc) {
            const buffer = await downloadMediaMessage(fakeMsg, "buffer", {});
            const fname = quotedWm.documentMessage!.fileName || "quoted-document";
            const path = saveMedia(buffer as Buffer, fname);
            const processed = await processMedia("document", path, quotedWm.documentMessage!.mimetype || undefined);
            quotedMedia.push({ type: "document", processedText: processed, fileName: fname });
          }
        } catch (err) {
          log.warn({ err }, "Failed to download/process quoted media");
        }
        if (quotedMedia.length > 0) quotedMessage.media = quotedMedia;
      }
    }
    if (willProcess) timings.mediaEnd = Date.now();

    // Attach timings to waMsg so dispatch can propagate them
    (waMsg as any)._timings = timings;

    // Skip if no text and no media and no quote (nothing to dispatch)
    if (!text && media.length === 0 && !quotedMessage) return;

    log.debug({ jid, fromMe, selfChat, isGroup, owner, text: text.slice(0, 50) }, "Processing WA message");

    switch (decision.kind) {
      case "self":
        return this.dispatch(waMsg, jid, isGroup, true, senderJid, text, media, quotedMessage);
      case "alwaysReplyGroup":
        return this.dispatch(waMsg, jid, isGroup, false, senderJid, text, media, quotedMessage);
      case "jarvisOneShot":
        log.info({ jid }, "@jarvis one-shot (owner, full agent)");
        return this.dispatch(waMsg, jid, isGroup, fromMe, senderJid, text, media, quotedMessage, getFullAgent());
      case "replyToJarvis":
        return this.dispatch(waMsg, jid, isGroup, false, senderJid, text, media, quotedMessage);
      case "explicitRoute":
        // In groups, never mark as "self" — it's the owner writing in the group
        return this.dispatch(waMsg, jid, isGroup, isGroup ? false : fromMe, senderJid, text, media, quotedMessage);
    }
  }

  private async dispatch(
    waMsg: any, jid: string, isGroup: boolean,
    isFromSelf: boolean, senderJid: string, text: string,
    media?: MediaAttachment[], quotedMessage?: QuotedMessage,
    agentOverride?: import("../types").AgentConfig,
  ): Promise<void> {
    const replyJid = this.getReplyJid(jid);
    const msgKey = waMsg.key;

    const groupName = isGroup ? (waMsg.pushName || waMsg.key?.participant || undefined) : undefined;
    const msg: IncomingMessage = {
      channel: "whatsapp",
      from: isFromSelf ? "self" : "+" + senderJid.split(":")[0].split("@")[0],
      group: isGroup ? jid : undefined,
      replyTarget: replyJid,
      rawJid: jid,
      text,
      timestamp: waMsg.messageTimestamp as number,
      messageId: waMsg.key.id ?? undefined,
      media: media && media.length > 0 ? media : undefined,
      quotedMessage,
      timings: (waMsg as any)._timings,
      agentOverride,
      channelContext: {
        whatsapp: {
          jid,
          isGroup,
          groupName,
          senderJid,
          senderName: waMsg.pushName,
          messageId: waMsg.key.id ?? undefined,
        },
      },
      reply: async (response: string) => {
        log.info({ replyJid, responseLen: response.length }, "Sending WhatsApp reply");
        const maxRetries = 3;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            const sent = await this.sock?.sendMessage(replyJid, { text: response });
            // Track sent message ID to prevent self-loop
            if (sent?.key?.id) {
              this.sentMsgIds.add(sent.key.id);
              // Evict old entries
              if (this.sentMsgIds.size > 200) {
                const first = this.sentMsgIds.values().next().value;
                if (first) this.sentMsgIds.delete(first);
              }
            }
            // Store sent message for retry handling
            if (sent?.key?.id && sent?.message) {
              this.msgStore.set(sent.key.id, sent.message);
              if (this.msgStore.size > 100) {
                const firstKey = this.msgStore.keys().next().value;
                if (firstKey) this.msgStore.delete(firstKey);
              }
            }
            return;
          } catch (err: any) {
            const isSessionErr = err?.message?.includes("No sessions") || err?.message?.includes("not-acceptable");
            if (isSessionErr && attempt < maxRetries - 1) {
              log.warn({ replyJid, attempt, err: err?.message }, "WhatsApp send failed (session), clearing stale session data...");
              // For groups: clear sender-key-memory so Baileys re-distributes sender keys
              try {
                if (replyJid.endsWith("@g.us")) {
                  // Clear sender-key-memory to force fresh key distribution
                  const { state: freshState } = await useMultiFileAuthState(this.authDir);
                  await freshState.keys.set({ "sender-key-memory": { [replyJid]: {} } });
                  log.info({ replyJid }, "Cleared sender-key-memory for group");

                  // Also clear sender-key files for this group from disk
                  const { readdirSync, unlinkSync } = await import("fs");
                  const { join } = await import("path");
                  const prefix = `sender-key-${replyJid.replace("@g.us", "")}`;
                  const files = readdirSync(this.authDir).filter(f => f.startsWith("sender-key-") && f.includes(replyJid.split("@")[0]));
                  for (const f of files) {
                    try { unlinkSync(join(this.authDir, f)); log.info({ file: f }, "Deleted stale sender-key file"); } catch {}
                  }
                }
              } catch (e: any) { log.warn({ err: e?.message }, "Session cleanup failed"); }
              await new Promise(r => setTimeout(r, 2000));
              continue;
            }
            log.error({ replyJid, err: err?.message, attempt }, "WhatsApp send failed");
            throw err;
          }
        }
      },
      sendFile: async (filePath: string, caption?: string) => {
        try {
          const buffer = readFileSync(filePath);
          const ext = extname(filePath).toLowerCase();
          const mimeMap: Record<string, string> = {
            ".pdf": "application/pdf", ".csv": "text/csv", ".json": "application/json",
            ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
            ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".ogg": "audio/ogg",
            ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ".zip": "application/zip", ".txt": "text/plain", ".html": "text/html", ".md": "text/markdown",
          };
          const mime = mimeMap[ext] || "application/octet-stream";
          const fileName = basename(filePath);
          const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

          if (imageExts.includes(ext as any)) {
            await this.sock?.sendMessage(replyJid, { image: buffer, caption, mimetype: mime });
          } else {
            await this.sock?.sendMessage(replyJid, { document: buffer, mimetype: mime, fileName, caption });
          }
        } catch (e) {
          log.error({ err: e, filePath }, "Failed to send file on WhatsApp");
        }
      },
      startTyping: () => {
        this.sock?.sendPresenceUpdate("composing", replyJid).catch(() => {});
        const iv = setInterval(() => {
          this.sock?.sendPresenceUpdate("composing", replyJid).catch(() => {});
        }, 2500);
        return () => { clearInterval(iv); this.sock?.sendPresenceUpdate("paused", replyJid).catch(() => {}); };
      },
      react: async (emoji: string) => {
        try {
          await this.sock?.sendMessage(jid, { react: { text: emoji, key: msgKey } });
          // Reaction resets presence — force composing back immediately
          this.sock?.sendPresenceUpdate("composing", replyJid).catch(() => {});
        } catch (e) { log.debug({ err: e }, "React failed"); }
      },
      raw: waMsg,
    };

    await handleMessage(msg);
  }

  async stop(): Promise<void> {
    this.sock?.end(undefined);
    this.sock = null;
    log.info("WhatsApp disconnected");
  }

  async sendMessage(target: string, text: string): Promise<void> {
    // WhatsApp tolerates long messages but readability drops past ~4k.
    // Chunking keeps cron deliveries in line with Telegram/Discord behavior.
    const chunks = splitMessage(text, 4000);
    for (const chunk of chunks) {
      const sent = await this.sock?.sendMessage(target, { text: chunk });
      // Track the id so the inbound echo is recognized as bot-sent and skipped,
      // preventing the routed agent from replying to its own cron delivery.
      if (sent?.key?.id) {
        this.sentMsgIds.add(sent.key.id);
        if (this.sentMsgIds.size > 200) {
          const first = this.sentMsgIds.values().next().value;
          if (first) this.sentMsgIds.delete(first);
        }
      }
    }
  }

  updateConfig(config: Config): void {
    this.config = config;
    if (config.channels.whatsapp?.authDir) this.authDir = config.channels.whatsapp.authDir;
  }
}
