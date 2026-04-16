import type { IncomingMessage, Server as HttpServer } from "http";
import type { Duplex } from "stream";
import { createHash, randomBytes } from "crypto";
import { logger } from "../services/logger";
import type { LogEntry, ResponseTime } from "./state";

const log = logger.child({ module: "dashboard-ws" });

// ---- Protocol ----

export const WS_PROTOCOL_VERSION = 1;

/**
 * Event union broadcast over /ws.
 * Each event has a `type` discriminator and a `data` payload.
 * The frontend mirrors this shape in `hooks/usePolling.ts` (see `RouterEvent`).
 */
export type RouterEvent =
  | { type: "hello"; data: { serverTime: number; protocolVersion: number } }
  | { type: "ping"; data: { ts: number } }
  | { type: "session.created"; data: SessionEventData }
  | { type: "session.updated"; data: SessionEventData }
  | { type: "session.killed"; data: SessionEventData }
  | { type: "log"; data: LogEntry }
  | { type: "stats"; data: Record<string, unknown> }
  | { type: "exchange.new"; data: ExchangeEventData }
  | { type: "response.timing"; data: ResponseTime };

export interface SessionEventData {
  key: string;
  channel?: string;
  target?: string;
  agent?: string | null;
  model?: string | null;
  alive?: boolean;
  pending?: boolean;
  messageCount?: number;
  reason?: "created" | "message-start" | "message-end" | "killed" | "timeout" | "lifetime";
  ts: number;
}

export interface ExchangeEventData {
  key: string;
  user: string;
  assistant: string;
  timestamp: number;
  agent?: string | null;
  channel?: string;
  model?: string | null;
  wallMs?: number;
  apiMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

// ---- Frame encoding (RFC 6455, server → client, unmasked) ----

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

function encodeText(text: string): Buffer {
  return encodeFrame(OP_TEXT, Buffer.from(text, "utf8"));
}

function encodeClose(code = 1000, reason = ""): Buffer {
  const r = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + r.length);
  payload.writeUInt16BE(code, 0);
  r.copy(payload, 2);
  return encodeFrame(OP_CLOSE, payload);
}

function encodePing(): Buffer {
  return encodeFrame(OP_PING, Buffer.alloc(0));
}

// ---- Frame decoding (client → server, masked) ----

interface DecodedFrame {
  opcode: number;
  payload: Buffer;
  fin: boolean;
}

/** Parse as many complete frames as possible from a buffer. Returns parsed frames + remaining bytes. */
function decodeFrames(buf: Buffer): { frames: DecodedFrame[]; rest: Buffer } {
  const frames: DecodedFrame[] = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let headerLen = 2;
    if (len === 126) {
      if (off + 4 > buf.length) break;
      len = buf.readUInt16BE(off + 2);
      headerLen = 4;
    } else if (len === 127) {
      if (off + 10 > buf.length) break;
      const hi = buf.readUInt32BE(off + 2);
      const lo = buf.readUInt32BE(off + 6);
      if (hi !== 0) {
        // payload too large; drop
        return { frames, rest: Buffer.alloc(0) };
      }
      len = lo;
      headerLen = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (off + headerLen + maskLen + len > buf.length) break;
    let mask: Buffer | null = null;
    if (masked) {
      mask = buf.slice(off + headerLen, off + headerLen + 4);
    }
    const payloadStart = off + headerLen + maskLen;
    const payloadEnd = payloadStart + len;
    const raw = buf.slice(payloadStart, payloadEnd);
    let payload: Buffer;
    if (mask) {
      payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = raw[i] ^ mask[i & 3];
    } else {
      payload = Buffer.from(raw);
    }
    frames.push({ opcode, payload, fin });
    off = payloadEnd;
  }
  return { frames, rest: buf.slice(off) };
}

// ---- Handshake ----

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function acceptKey(clientKey: string): string {
  return createHash("sha1").update(clientKey + WS_GUID).digest("base64");
}

// ---- Client registry ----

interface WsClient {
  id: string;
  socket: Duplex;
  alive: boolean;
  buffer: Buffer;
  closed: boolean;
}

const clients = new Map<string, WsClient>();
const MAX_CLIENTS = 32;
const MAX_BUFFERED = 2 * 1024 * 1024; // 2MB send buffer before we drop

export function clientCount(): number {
  return clients.size;
}

function sendRaw(client: WsClient, frame: Buffer): void {
  if (client.closed) return;
  const sock = client.socket as Duplex & { writableLength?: number };
  if ((sock.writableLength ?? 0) > MAX_BUFFERED) {
    // Slow consumer — drop and close.
    destroyClient(client, 1009, "slow consumer");
    return;
  }
  try {
    client.socket.write(frame);
  } catch {
    destroyClient(client, 1011, "write-failed");
  }
}

function destroyClient(client: WsClient, code = 1000, reason = ""): void {
  if (client.closed) return;
  client.closed = true;
  try {
    client.socket.write(encodeClose(code, reason));
  } catch {}
  try {
    client.socket.end();
  } catch {}
  try {
    client.socket.destroy();
  } catch {}
  clients.delete(client.id);
}

/** Broadcast an event to every connected client. Cheap when no clients are connected. */
export function broadcast(event: RouterEvent): void {
  if (clients.size === 0) return;
  let text: string;
  try {
    text = JSON.stringify(event);
  } catch (err: any) {
    log.warn({ err: err?.message, type: event.type }, "Failed to serialise event");
    return;
  }
  const frame = encodeText(text);
  for (const client of clients.values()) {
    sendRaw(client, frame);
  }
}

// ---- Upgrade handler ----

/**
 * Attach a WebSocket upgrade handler to an existing HTTP(S) server.
 * Only requests to `/ws` are upgraded; everything else is rejected so other
 * upgrade handlers can still handle their own endpoints.
 */
export function attachWebSocket(server: HttpServer): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    try {
      const url = req.url ?? "/";
      const pathname = url.split("?")[0];
      if (pathname !== "/ws") return;

      const key = req.headers["sec-websocket-key"];
      const version = req.headers["sec-websocket-version"];
      const upgrade = String(req.headers["upgrade"] ?? "").toLowerCase();
      if (upgrade !== "websocket" || typeof key !== "string" || version !== "13") {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      if (clients.size >= MAX_CLIENTS) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }

      const accept = acceptKey(key);
      const headers = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ];
      socket.write(headers.join("\r\n"));

      const client: WsClient = {
        id: randomBytes(8).toString("hex"),
        socket,
        alive: true,
        buffer: head && head.length ? Buffer.from(head) : Buffer.alloc(0),
        closed: false,
      };
      clients.set(client.id, client);

      socket.on("data", (chunk: Buffer) => {
        client.buffer = client.buffer.length === 0 ? chunk : Buffer.concat([client.buffer, chunk]);
        const { frames, rest } = decodeFrames(client.buffer);
        client.buffer = rest;
        for (const frame of frames) {
          if (frame.opcode === OP_CLOSE) {
            destroyClient(client, 1000, "peer-close");
            return;
          }
          if (frame.opcode === OP_PING) {
            sendRaw(client, encodeFrame(OP_PONG, frame.payload));
            continue;
          }
          if (frame.opcode === OP_PONG) {
            client.alive = true;
            continue;
          }
          // Ignore text/binary frames from clients (this layer is server → client only).
          if (frame.opcode === OP_TEXT || frame.opcode === OP_BIN || frame.opcode === OP_CONT) {
            continue;
          }
        }
      });

      const cleanup = () => destroyClient(client, 1001, "socket-closed");
      socket.on("error", cleanup);
      socket.on("close", cleanup);
      socket.on("end", cleanup);

      // Initial hello
      const hello: RouterEvent = {
        type: "hello",
        data: { serverTime: Date.now(), protocolVersion: WS_PROTOCOL_VERSION },
      };
      sendRaw(client, encodeText(JSON.stringify(hello)));
    } catch (err: any) {
      log.warn({ err: err?.message }, "Upgrade handler error");
      try { socket.destroy(); } catch {}
    }
  });
}

// ---- Keep-alive ping every 20s ----

const PING_INTERVAL_MS = 20_000;
const pingTimer = setInterval(() => {
  if (clients.size === 0) return;
  const pingFrame = encodePing();
  for (const client of clients.values()) {
    if (!client.alive) {
      destroyClient(client, 1001, "ping-timeout");
      continue;
    }
    client.alive = false;
    sendRaw(client, pingFrame);
  }
}, PING_INTERVAL_MS);
// Don't keep the event loop alive just for pings
if (typeof pingTimer.unref === "function") pingTimer.unref();
