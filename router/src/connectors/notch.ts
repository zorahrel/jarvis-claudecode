import type { Connector } from "./base";
import type { IncomingMessage, Config } from "../types";
import { handleMessage } from "../services/handler";
import { logger } from "../services/logger";
import { emitNotch } from "../notch/events";
import { appendHistory } from "../notch/history";
import { getPrefs } from "../notch/prefs";
import { speakToFile, registerCartesiaStream } from "../services/tts";
import { extractSpoken } from "../services/spoken-extractor";
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

    const msg: IncomingMessage = {
      channel: "notch",
      from,
      text,
      timestamp: Math.floor(Date.now() / 1000),
      messageId,
      modelOverride,
      timings: { received: Date.now() },
      reply: async (response: string) => {
        // Drop the reply entirely if abort() was called during the turn.
        if (myGen !== this.activeGenId) {
          log.info("Notch reply suppressed — generation aborted");
          return;
        }
        emitNotch({
          type: "message.in",
          data: { text: response, from, agent: "notch" },
        });
        appendHistory({ role: "agent", ts: Date.now(), from: "notch", text: response }).catch(() => {});
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
