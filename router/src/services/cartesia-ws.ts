import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";

const log = logger.child({ module: "cartesia-ws" });

const CARTESIA_WS_URL_BASE = "wss://api.cartesia.ai/tts/websocket";
const CARTESIA_VERSION = "2024-11-13";
const SAMPLE_RATE = 44100;

/**
 * Streaming TTS pipeline: LLM chunks → spoken-tag streaming parser →
 * sentence boundary buffer → Cartesia WebSocket (sticky context) →
 * PCM Float32 → ffmpeg pipe → MP3 ReadableStream → WebView <audio>.
 *
 * Subprocess hardening: uses spawn() with args ARRAY (no shell). All input
 * to ffmpeg is binary PCM via stdin pipe (no command-line interpolation),
 * and Cartesia URL params are runtime-encoded with encodeURIComponent.
 *
 * Lifetime model:
 *   1. `new CartesiaStreamSession({...})` — spawns ffmpeg, opens WS
 *   2. `pushChunk(text)` — feed LLM tokens incrementally; spoken-only
 *      content past sentence boundaries is flushed to Cartesia
 *   3. `finalize()` — flush remaining buffer, send `continue:false`,
 *      close WS gracefully when Cartesia signals done
 *   4. `cancel()` — barge-in path; sends cancel to Cartesia, kills ffmpeg
 *
 * The `getMP3Stream()` ReadableStream is registered in `pendingStreams`
 * (services/tts.ts) by the caller, then served at /api/notch/tts-stream/{id}.
 *
 * Spoken-tag parser state machine:
 *
 *   OUTSIDE → see '<' → READING_OPEN_TAG (buffer "<")
 *   READING_OPEN_TAG → match "<spoken>" → INSIDE (emit "")
 *                    → mismatch (e.g. "<thinking") → OUTSIDE (drop buffer)
 *   INSIDE → see '<' → READING_CLOSE_TAG (buffer "<")
 *          → other char → INSIDE (emit char)
 *   READING_CLOSE_TAG → match "</spoken>" → OUTSIDE (emit "")
 *                     → mismatch (e.g. "<em>") → INSIDE (emit buffered)
 *
 * Handles tags split across chunks ("<spo" + "ken>OK" works as expected).
 */

type ParserState = "OUTSIDE" | "INSIDE" | "READING_OPEN" | "READING_CLOSE";

const OPEN_TAG = "<spoken>";
const CLOSE_TAG = "</spoken>";

/**
 * Streaming parser that yields ONLY the content inside <spoken>...</spoken>
 * tags, character-by-character, even when tags are split across feed() calls.
 *
 * Case-insensitive (matches `<SPOKEN>`, `<Spoken>`, `<spoken>`).
 */
export class SpokenTagStreamParser {
  private state: ParserState = "OUTSIDE";
  private partialTag = ""; // accumulated chars while reading a potential tag

  /**
   * Feed a chunk of text from the LLM. Returns the substring that should be
   * forwarded to TTS (i.e., content inside <spoken> tags only).
   */
  feed(text: string): string {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const lower = ch.toLowerCase();

      switch (this.state) {
        case "OUTSIDE":
          if (ch === "<") {
            this.state = "READING_OPEN";
            this.partialTag = "<";
          }
          // else: drop (outside spoken tags = not pronounced)
          break;

        case "READING_OPEN": {
          this.partialTag += lower;
          if (OPEN_TAG.startsWith(this.partialTag)) {
            // still on track to match "<spoken>"
            if (this.partialTag === OPEN_TAG) {
              // matched fully → enter INSIDE
              this.state = "INSIDE";
              this.partialTag = "";
            }
            // else: keep accumulating
          } else {
            // mismatch (e.g. "<thinking") → not a spoken tag, drop everything
            this.state = "OUTSIDE";
            this.partialTag = "";
          }
          break;
        }

        case "INSIDE":
          if (ch === "<") {
            this.state = "READING_CLOSE";
            this.partialTag = "<";
          } else {
            out += ch;
          }
          break;

        case "READING_CLOSE": {
          this.partialTag += lower;
          if (CLOSE_TAG.startsWith(this.partialTag)) {
            if (this.partialTag === CLOSE_TAG) {
              this.state = "OUTSIDE";
              this.partialTag = "";
            }
            // else: keep accumulating, don't emit yet
          } else {
            // it was a stray '<' inside spoken text (e.g. inline <em>) →
            // emit the buffered chars verbatim and stay INSIDE
            out += this.partialTag;
            this.state = "INSIDE";
            this.partialTag = "";
          }
          break;
        }
      }
    }
    return out;
  }

  /**
   * Called when the LLM is done. If we ended mid-tag, anything buffered is
   * dropped (incomplete tag = unsafe to pronounce).
   */
  flush(): void {
    this.state = "OUTSIDE";
    this.partialTag = "";
  }
}

/**
 * Buffer that accumulates characters and flushes complete sentences to TTS.
 *
 * Why: Cartesia WS accepts continuation chunks but the audio quality
 * degrades if you flush half-words ("il dep" then "loy" sounds like
 * "il dep loy" with weird gap + bad prosody). Sentence-level chunking
 * (boundaries on `. ! ? \n` plus a min length) preserves natural prosody
 * with minimal extra latency on the FIRST sentence.
 *
 * Boundary chars: `. ! ? \n` (the comma `,` is excluded — too aggressive,
 * cuts mid-thought).
 *
 * Min sentence length: 12 chars. Below that we keep accumulating to avoid
 * flushing "OK." on its own → tiny audio chunk + restart latency.
 */
export class SentenceBoundaryBuffer {
  private buf = "";
  private static readonly BOUNDARY_RE = /[.!?\n]/;
  private static readonly MIN_FLUSH_LEN = 12;

  /**
   * Add text. Returns sentences ready to flush. The current incomplete
   * sentence stays buffered for next call.
   */
  feed(text: string): string[] {
    if (!text) return [];
    this.buf += text;
    const out: string[] = [];

    while (true) {
      const m = SentenceBoundaryBuffer.BOUNDARY_RE.exec(this.buf);
      if (!m) break;
      const cut = m.index + 1;
      const sentence = this.buf.slice(0, cut).trim();
      if (sentence.length < SentenceBoundaryBuffer.MIN_FLUSH_LEN) {
        // Sentence too short to flush on its own (would create micro-chunks
        // at TTS = bad prosody + restart latency). Two cases:
        if (cut < this.buf.length) {
          // There's more text — try to combine with the next sentence.
          const remainder = this.buf.slice(cut);
          const next = SentenceBoundaryBuffer.BOUNDARY_RE.exec(remainder);
          if (!next) break; // no second boundary yet, keep buffering
          const combinedCut = cut + next.index + 1;
          out.push(this.buf.slice(0, combinedCut).trim());
          this.buf = this.buf.slice(combinedCut);
        } else {
          // Short sentence is ALL we have — keep it buffered, wait for next
          // feed() to give us more context. flush() will pull it out at LLM end.
          break;
        }
      } else {
        if (sentence) out.push(sentence);
        this.buf = this.buf.slice(cut);
      }
    }

    return out.filter(Boolean);
  }

  /** Returns whatever is left in the buffer (called at LLM finalize). */
  flush(): string {
    const tail = this.buf.trim();
    this.buf = "";
    return tail;
  }
}

// ---------------------------------------------------------------------------

interface CartesiaStreamOpts {
  apiKey: string;
  voiceId: string;
  modelId: string; // e.g. "sonic-3"
  language: string; // e.g. "it"
}

/**
 * One per voice turn. Owns the Cartesia WS connection, the ffmpeg child, and
 * the parsed/buffered LLM text pipeline.
 */
export class CartesiaStreamSession {
  readonly contextId: string;
  private ws: WebSocket | null = null;
  private wsReady: Promise<void>;
  private resolveWsReady!: () => void;
  private rejectWsReady!: (err: Error) => void;
  private wsClosed = false;
  private cancelled = false;

  private ffmpeg: ChildProcess;
  private mp3Stream: ReadableStream<Uint8Array>;
  private mp3Controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  private parser = new SpokenTagStreamParser();
  private buffer = new SentenceBoundaryBuffer();

  /** Counts to track what we've sent vs what Cartesia has replied to. */
  private chunksSent = 0;
  private finalSent = false;

  constructor(private opts: CartesiaStreamOpts) {
    this.contextId = randomUUID();

    // 1. Spawn ffmpeg PCM Float32 → MP3 (low-latency flags as registerCartesiaStream).
    //    spawn() with args ARRAY → no shell, no injection.
    this.ffmpeg = spawn(
      "ffmpeg",
      [
        "-loglevel", "error",
        "-fflags", "+nobuffer",
        "-flags", "low_delay",
        "-probesize", "32",
        "-analyzeduration", "0",
        "-f", "f32le",
        "-ar", String(SAMPLE_RATE),
        "-ac", "1",
        "-i", "pipe:0",
        "-f", "mp3",
        "-b:a", "128k",
        "-ac", "1",
        "-flush_packets", "1",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.ffmpeg.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString("utf-8").trim();
      if (msg) log.debug({ msg, ctx: this.contextId }, "ffmpeg stderr");
    });
    this.ffmpeg.on("error", (err) => {
      log.warn({ err, ctx: this.contextId }, "ffmpeg spawn error");
    });

    // 2. Build the MP3 ReadableStream the consumer endpoint will pipe.
    this.mp3Stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.mp3Controller = controller;
        this.ffmpeg.stdout?.on("data", (chunk: Buffer) => {
          try { controller.enqueue(new Uint8Array(chunk)); } catch {}
        });
        this.ffmpeg.stdout?.on("end", () => {
          try { controller.close(); } catch {}
        });
        this.ffmpeg.stdout?.on("error", (err) => {
          log.warn({ err, ctx: this.contextId }, "ffmpeg stdout error");
          try { controller.error(err); } catch {}
        });
        this.ffmpeg.on("close", (code) => {
          if (code !== 0 && code !== null && !this.cancelled) {
            log.warn({ code, ctx: this.contextId }, "ffmpeg exited non-zero");
          }
        });
      },
      cancel: () => {
        this.cancel();
      },
    });

    // 3. Open the Cartesia WebSocket.
    this.wsReady = new Promise((resolve, reject) => {
      this.resolveWsReady = resolve;
      this.rejectWsReady = reject;
    });
    this.openWs();
  }

  private openWs(): void {
    const url =
      `${CARTESIA_WS_URL_BASE}` +
      `?api_key=${encodeURIComponent(this.opts.apiKey)}` +
      `&cartesia_version=${encodeURIComponent(CARTESIA_VERSION)}`;
    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      log.warn({ err, ctx: this.contextId }, "WebSocket constructor failed");
      this.rejectWsReady(err as Error);
      return;
    }

    this.ws.addEventListener("open", () => {
      log.info({ ctx: this.contextId }, "[ws] open");
      this.resolveWsReady();
    });

    this.ws.addEventListener("error", (ev) => {
      log.warn({ ctx: this.contextId, ev: String(ev) }, "[ws] error");
      this.rejectWsReady(new Error("Cartesia WS error"));
      this.closePipeline();
    });

    this.ws.addEventListener("close", (ev) => {
      this.wsClosed = true;
      log.info({ ctx: this.contextId, code: ev.code }, "[ws] close");
      // Close ffmpeg stdin so MP3 stdout flushes the tail.
      try { this.ffmpeg.stdin?.end(); } catch {}
    });

    this.ws.addEventListener("message", (ev) => {
      this.handleWsMessage(ev.data);
    });
  }

  private handleWsMessage(raw: unknown): void {
    let data: string;
    if (typeof raw === "string") {
      data = raw;
    } else if (raw instanceof ArrayBuffer) {
      data = new TextDecoder().decode(raw);
    } else if (raw instanceof Uint8Array) {
      data = new TextDecoder().decode(raw);
    } else {
      return;
    }

    let evt: { type?: string; data?: string; done?: boolean; context_id?: string; error?: string };
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }

    if (evt.error) {
      log.warn({ err: evt.error, ctx: this.contextId }, "[ws] cartesia error");
      this.cancel();
      return;
    }

    if (evt.type === "chunk" && typeof evt.data === "string" && evt.data.length > 0) {
      // Decode base64 PCM Float32 LE → push to ffmpeg stdin
      const pcm = Buffer.from(evt.data, "base64");
      const stdin = this.ffmpeg.stdin;
      if (stdin && !stdin.destroyed) {
        try { stdin.write(pcm); } catch (err) {
          log.warn({ err, ctx: this.contextId }, "ffmpeg stdin write failed");
        }
      }
    }

    if (evt.done === true) {
      // Cartesia signals end-of-context. Close ffmpeg stdin → MP3 finalizes.
      log.info({ ctx: this.contextId }, "[ws] cartesia done — closing ffmpeg stdin");
      try { this.ffmpeg.stdin?.end(); } catch {}
    }
  }

  /**
   * Push a chunk of LLM text into the pipeline. Parses spoken tags, buffers
   * to sentence boundary, sends complete sentences to Cartesia.
   *
   * Idempotent on cancel — silently drops if already cancelled.
   */
  pushChunk(text: string): void {
    if (this.cancelled || this.finalSent) return;
    const spoken = this.parser.feed(text);
    if (!spoken) return;
    const sentences = this.buffer.feed(spoken);
    for (const s of sentences) this.sendToCartesia(s, /*isFinal=*/ false);
  }

  /**
   * Mark LLM done. Flushes the remaining buffered text (last partial sentence
   * if any) and tells Cartesia no more chunks are coming.
   */
  finalize(): void {
    if (this.cancelled || this.finalSent) return;
    this.finalSent = true;
    const tail = this.buffer.flush();
    this.parser.flush();
    if (tail) {
      this.sendToCartesia(tail, /*isFinal=*/ true);
    } else if (this.chunksSent === 0) {
      // No spoken content was ever sent (all reply was outside <spoken>).
      log.info({ ctx: this.contextId }, "[ws] finalize with zero chunks — closing");
      this.cancel();
    } else {
      this.sendToCartesia("", /*isFinal=*/ true);
    }
  }

  /**
   * Hard barge-in. Tells Cartesia to stop, kills ffmpeg, closes WS.
   */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    log.info({ ctx: this.contextId }, "[ws] cancel");

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ context_id: this.contextId, cancel: true }));
      } catch {}
      try { this.ws.close(); } catch {}
    }
    this.closePipeline();
  }

  private closePipeline(): void {
    try { this.ffmpeg.stdin?.end(); } catch {}
    try { this.ffmpeg.kill("SIGTERM"); } catch {}
    if (this.mp3Controller) {
      try { this.mp3Controller.close(); } catch {}
    }
  }

  /**
   * Build and send a Cartesia WS request for one transcript chunk.
   * Awaits ws-ready (so we can call sendToCartesia from sync code).
   */
  private async sendToCartesia(transcript: string, isFinal: boolean): Promise<void> {
    try {
      await this.wsReady;
    } catch (err) {
      log.warn({ err, ctx: this.contextId }, "WS never opened, skipping send");
      return;
    }
    if (this.cancelled || this.wsClosed) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const payload = {
      context_id: this.contextId,
      model_id: this.opts.modelId,
      transcript,
      voice: { mode: "id", id: this.opts.voiceId },
      language: this.opts.language,
      output_format: {
        container: "raw",
        encoding: "pcm_f32le",
        sample_rate: SAMPLE_RATE,
      },
      continue: !isFinal,
    };
    try {
      this.ws.send(JSON.stringify(payload));
      this.chunksSent++;
      log.debug({ ctx: this.contextId, len: transcript.length, isFinal, n: this.chunksSent }, "[ws] sent");
    } catch (err) {
      log.warn({ err, ctx: this.contextId }, "ws send failed");
    }
  }

  /**
   * The MP3 ReadableStream to register in pendingStreams. The consumer
   * endpoint (/api/notch/tts-stream/{id}) pipes this to the WebView.
   */
  getMP3Stream(): ReadableStream<Uint8Array> {
    return this.mp3Stream;
  }
}
