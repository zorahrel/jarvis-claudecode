import type { Connector } from "./base";
import type { IncomingMessage, Config } from "../types";
import { handleMessage } from "../services/handler";
import { logger } from "../services/logger";
import { emitNotch } from "../notch/events";
import { appendHistory } from "../notch/history";
import { getPrefs } from "../notch/prefs";
import { speakToFile, registerCartesiaStream, registerExternalStream } from "../services/tts";
import { extractSpoken, stripSpokenTags } from "../services/spoken-extractor";
import { CartesiaStreamSession } from "../services/cartesia-ws";
import { tmpdir } from "os";
import { join, basename } from "path";

const log = logger.child({ module: "notch" });

/**
 * Notch connector — bridges the in-process Noce surfaces (DynamicNotchKit
 * WKWebView and the dashboard iframe mirror) to the router's message
 * pipeline. Input arrives via `inject()` called from the /api/notch/send
 * HTTP endpoint or the /notch WebSocket; output fans out via `emitNotch()`
 * consumed by the SSE + WS endpoints.
 */
export class NotchConnector implements Connector {
  readonly channel = "notch" as const;
  private static instance: NotchConnector | null = null;

  /**
   * Generation counter used to fence in-flight inject() runs after an
   * abort(). Each new inject captures a snapshot at the start; reply()
   * and the TTS trigger drop their effects if the snapshot no longer
   * matches the current value. handleMessage() itself can't be aborted
   * mid-flight (no AbortSignal plumbing yet), so this is the realistic
   * "stop" — the agent finishes its turn but nothing reaches the user.
   */
  private activeGenId = 0;

  /**
   * Currently active LLM-streaming TTS session, if any. Set when inject()
   * decides to take the streaming path (JARVIS_TTS_LLM_STREAM=1 + tts pref on).
   * Read by barge() and abort() to cancel the in-flight Cartesia context so
   * the user doesn't hear the tail of an interrupted reply.
   */
  private currentStreamSession: CartesiaStreamSession | null = null;

  constructor(private _config: Config) {
    NotchConnector.instance = this;
  }

  static getInstance(): NotchConnector | null {
    return NotchConnector.instance;
  }

  /**
   * Hot-corner / dashboard "stop Jarvis". Bumps the generation so any
   * in-flight reply is suppressed; emits state.change → idle so the UI
   * returns to a ready posture even if handleMessage hasn't returned.
   */
  abort(): void {
    this.activeGenId++;
    log.info("Notch abort — suppressing in-flight reply");
    if (this.currentStreamSession) {
      this.currentStreamSession.cancel();
      this.currentStreamSession = null;
    }
    emitNotch({ type: "state.change", data: { state: "idle" } });
  }

  /**
   * Hard barge-in: chiamato dal native quando il VAD detecta voce mentre il
   * TTS sta parlando. Stessa logica di abort() (bumpa la gen, drop la reply
   * in-flight) ma stato finale diverso: l'utente sta GIÀ parlando, quindi
   * lo stato deve essere `recording` non `idle`. Inoltre emit `audio.stop`
   * così il WebView ferma il `<audio>` element subito.
   *
   * Non distingue tra TTS in pre-roll e TTS già playing — il client decide
   * cosa fermare (AVSpeech locale, audio HTML, o entrambi).
   */
  barge(): void {
    this.activeGenId++;
    log.info("Notch barge-in — suppressing TTS, user is speaking");
    // Hard cancel the streaming Cartesia context if active. Otherwise the
    // synthesized tail keeps arriving and the WebView would have to discard it.
    if (this.currentStreamSession) {
      this.currentStreamSession.cancel();
      this.currentStreamSession = null;
    }
    emitNotch({ type: "audio.stop", data: {} });
    emitNotch({ type: "state.change", data: { state: "recording" } });
  }

  async start(): Promise<void> {
    log.info("Notch connector ready (POST /api/notch/send, WS /notch, SSE /api/notch/stream)");
  }

  async stop(): Promise<void> {
    if (NotchConnector.instance === this) NotchConnector.instance = null;
    log.info("Notch connector stopped");
  }

  /**
   * Feed a message into the router as if it came from a local Notch user.
   * Emits `state.change` → `thinking` before processing, `message.in` with
   * the assistant reply, and `state.change` → `idle` at the end.
   */
  async inject(text: string, from = "notch"): Promise<void> {
    const myGen = ++this.activeGenId;
    const messageId = `notch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Defensively cancel any prior streaming session that's still alive.
    // Normal completion clears it; a quick second inject before audio
    // playback ends would leak audio without this guard.
    if (this.currentStreamSession) {
      try { this.currentStreamSession.cancel(); } catch {}
      this.currentStreamSession = null;
    }
    // Echo the user's line back to every notch subscriber so the chat log
    // fills in immediately (native WKWebView + dashboard iframe mirror), and
    // persist it so a restart/reload rehydrates the conversation.
    emitNotch({ type: "message.out", data: { text, from } });
    appendHistory({ role: "user", ts: Date.now(), from, text }).catch(() => {});
    emitNotch({ type: "state.change", data: { state: "thinking" } });

    // Read the toolbar model override here so the user's choice picks up on
    // the next inject without needing a router restart.
    const earlyPrefs = await getPrefs().catch(() => null);
    const modelOverride = earlyPrefs?.model ?? undefined;

    // ── LLM-STREAM-TO-TTS PATH ──
    // When `JARVIS_TTS_LLM_STREAM=1`, open a Cartesia WS streaming session
    // BEFORE the LLM call. Each LLM text delta gets pushed straight into the
    // session's spoken-tag parser → sentence buffer → Cartesia. Audio starts
    // playing on the user's machine roughly 400ms after the FIRST sentence
    // is complete — instead of waiting for the whole reply.
    //
    // Decision logic:
    //   - Only if pref `tts` is on AND not muted (user-controlled in toolbar)
    //   - Only if env enables it (gradual rollout / easy A/B vs file-mode)
    //   - Only if Cartesia API key is present
    // Otherwise: fall back to the original "wait for full reply, then synth"
    // path inside reply() below.
    const llmStreamEnabled =
      process.env.JARVIS_TTS_LLM_STREAM === "1" &&
      !!process.env.CARTESIA_API_KEY &&
      !!earlyPrefs?.tts &&
      !earlyPrefs?.mute;

    let streamSession: CartesiaStreamSession | null = null;
    let streamId: string | null = null;
    if (llmStreamEnabled) {
      try {
        streamSession = new CartesiaStreamSession({
          apiKey: process.env.CARTESIA_API_KEY!,
          voiceId: process.env.CARTESIA_VOICE_IT ?? "ee16f140-f6dc-490e-a1ed-c1d537ea0086",
          modelId: process.env.CARTESIA_MODEL_ID ?? "sonic-3",
          language: "it",
        });
        streamId = registerExternalStream(streamSession.getMP3Stream());
        this.currentStreamSession = streamSession;
        // Emit audio.play SUBITO. The WebView <audio> element pre-attaches
        // and waits on the chunked transfer; bytes start flowing only when
        // Cartesia has the first sentence ready. This lets the browser cut
        // its own decode latency to near-zero on first chunk arrival.
        emitNotch({
          type: "audio.play",
          data: { url: `/api/notch/tts-stream/${streamId}`, mime: "audio/mpeg" },
        });
        log.info({ engine: "cartesia-ws-llm-stream", streamId, ctx: streamSession.contextId }, "[tts] LLM-stream started");
      } catch (err) {
        log.warn({ err }, "[tts] LLM-stream open failed, falling back to post-reply synth");
        if (streamSession) { try { streamSession.cancel(); } catch {} }
        streamSession = null;
        streamId = null;
        this.currentStreamSession = null;
      }
    }

    const msg: IncomingMessage = {
      channel: "notch",
      from,
      text,
      timestamp: Math.floor(Date.now() / 1000),
      messageId,
      modelOverride,
      timings: { received: Date.now() },
      onChunk: (delta) => {
        // Drop deltas if the turn was aborted between LLM call and now.
        if (myGen !== this.activeGenId) return;
        // NOTE: message.chunk SSE emission tentato e ritirato 2026-05-01.
        // Causava duplicato visivo nel notch: bundle minified non riconosce
        // il pattern "chunk-then-in" e accodava la final bubble a quella
        // pending già creata dai chunks. Per un display in streaming token-
        // per-token serve un refactor del bundle (modificare il listener
        // SSE message.in del bundle perché sostituisca invece di appendere).
        // Per ora il display resta no-stream lato testo; lo streaming TTS
        // (Cartesia WS qui sotto) è quello che importa per latenza percepita.

        // Push to Cartesia WS if streaming session is open. The session
        // internally parses spoken tags + buffers to sentence boundaries.
        if (streamSession) {
          try { streamSession.pushChunk(delta); }
          catch (err) { log.warn({ err }, "stream pushChunk threw"); }
        }
      },
      reply: async (response: string) => {
        // Drop the reply entirely if abort() was called during the turn.
        if (myGen !== this.activeGenId) {
          log.info("Notch reply suppressed — generation aborted");
          return;
        }
        // Display: strippa SOLO i delimitatori <spoken>/</spoken>, mantieni
        // il contenuto. Chat log mostra testo cleaned, TTS estrae solo parti
        // dentro i tag (extractSpoken qui sotto). Coerenza: storage history
        // riceve lo stesso testo del display.
        const displayText = stripSpokenTags(response);
        emitNotch({
          type: "message.in",
          data: { text: displayText, from, agent: "notch" },
        });
        appendHistory({ role: "agent", ts: Date.now(), from: "notch", text: displayText }).catch(() => {});

        // ── LLM-STREAM PATH FINALIZE ──
        // If we opened a streaming session at the top of inject(), the LLM
        // text deltas have ALREADY been pushed to Cartesia turn-by-turn.
        // Here we just flush the trailing partial sentence and let Cartesia
        // emit `done`, which closes ffmpeg → WebView <audio> hits EOF.
        if (streamSession) {
          try { streamSession.finalize(); }
          catch (err) { log.warn({ err }, "stream finalize threw"); }
          // Don't null out this.currentStreamSession yet — barge() during
          // the audio tail still needs to cancel it. It's reaped below in
          // the finally block of inject() (after typical playback time).
          return;
        }
        // Fire-and-forget TTS. Router synthesizes MP3 via mlx-audio
        // (Voxtral 4B IT, SOTA open-source) and emits `audio.play`;
        // the native notch's <audio> element streams it back. If
        // mlx-audio is unavailable the `speakToFile` pipeline
        // degrades to Kokoro → `say`. AVSpeechSynthesizer inside the
        // native notch (tts.speak event) stays as a manual override
        // path, not the auto one.
        queueMicrotask(async () => {
          try {
            if (myGen !== this.activeGenId) return; // aborted before TTS
            const prefs = await getPrefs();
            if (!prefs.tts || prefs.mute) return;
            // Spoken-output contract: notch agent wraps the speakable parts
            // in `<spoken>...</spoken>`. extractSpoken handles the contract +
            // legacy fallback (first paragraph) + structured-content guard
            // (suppress TTS on raw JSON / huge replies). See agents/notch/CLAUDE.md
            // for the contract definition and services/spoken-extractor.ts for the rules.
            const speakable = extractSpoken(response);
            if (!speakable) return;

            // Top-only cascade (2026-04-30):
            //   1. Cartesia Sonic-3 SSE streaming (~100-200ms TTFA, voce IT
            //      Lorenzo) → /api/notch/tts-stream/{id} chunked MP3 al WebView
            //   2. Cartesia file-mode `/tts/bytes` come fallback se SSE fallisce
            //   3. ElevenLabs file-mode → say (catena legacy, gestita da speakToFile)
            // Serviamo lo streaming quando possibile perché elimina i 1-2s di
            // attesa percepita ("buco" tra fine reply e inizio voce).
            const useStreaming = process.env.CARTESIA_API_KEY && !process.env.JARVIS_TTS_FORCE_FILE;
            if (useStreaming) {
              try {
                const streamId = await registerCartesiaStream(speakable);
                if (myGen !== this.activeGenId) return; // aborted while opening
                log.info({ engine: "cartesia-sse", streamId }, "[tts] streaming");
                emitNotch({
                  type: "audio.play",
                  data: { url: `/api/notch/tts-stream/${streamId}`, mime: "audio/mpeg" },
                });
                return;
              } catch (err) {
                log.warn({ err }, "[tts] cartesia streaming failed, falling back to file mode");
                // Continua con il fallback file-mode sotto
              }
            }

            // File-mode fallback. speakToFile gestisce il cascade interno
            // (Cartesia /tts/bytes → ElevenLabs Flash → say).
            const filename = `jarvis-tts-${messageId}.mp3`;
            const outPath = join(tmpdir(), filename);
            const result = await speakToFile(speakable, outPath);
            if (result.bytes > 0 && myGen === this.activeGenId) {
              log.info({ engine: result.engine, bytes: result.bytes }, "[tts] synthesized");
              emitNotch({
                type: "audio.play",
                data: { url: `/api/notch/tts-file/${basename(outPath)}`, mime: result.mime },
              });
            }
          } catch (err) {
            log.warn({ err }, "tts auto-trigger failed");
          }
        });
      },
    };

    try {
      await handleMessage(msg);
    } catch (err) {
      log.error({ err }, "Notch inject failed");
      emitNotch({
        type: "message.in",
        data: { text: "› errore interno", from, agent: "notch" },
      });
      appendHistory({ role: "agent", ts: Date.now(), from: "notch", text: "› errore interno" }).catch(() => {});
    } finally {
      // Even if aborted, emit idle so any other surface that missed the
      // earlier emit (raced subscribers) still settles back to ready.
      emitNotch({ type: "state.change", data: { state: "idle" } });
    }
  }

  /** Surface a system notice (cron delivery, push) directly to the Notch. */
  async sendMessage(target: string, text: string): Promise<void> {
    emitNotch({ type: "message.in", data: { text, from: target, agent: "notch" } });
    appendHistory({ role: "agent", ts: Date.now(), from: target, text }).catch(() => {});
  }
}
