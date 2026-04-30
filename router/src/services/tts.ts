import { spawn } from "child_process";
import { writeFile, stat, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { logger } from "./logger";

const log = logger.child({ module: "tts" });

const JARVIS_ROOT = join(process.env.HOME ?? "", ".claude/jarvis");
// Legacy script paths kept for env-gated opt-in only. The TOP-ONLY decision
// (2026-04-30) drops MLX and Kokoro from the cascade — set
// JARVIS_TTS_ALLOW_LEGACY=1 to re-enable them as last-resort fallbacks
// during e.g. an outage of both Cartesia and ElevenLabs. Default behavior:
// Cartesia → ElevenLabs Flash → say. Niente Voxtral, niente Kokoro.
const MLX_SCRIPT = join(JARVIS_ROOT, "router/scripts/tts-mlx.py");
const KOKORO_SCRIPT = join(JARVIS_ROOT, "router/scripts/tts-kokoro.py");
const KOKORO_TIMEOUT_MS = 6_000;
const MLX_TIMEOUT_MS = 30_000;
const ALLOW_LEGACY_TTS = process.env.JARVIS_TTS_ALLOW_LEGACY === "1";

// Cartesia Sonic-3: 40ms TTFA streaming, 12 voci IT native disponibili gratis.
// File-buffered API endpoint (`/tts/bytes`) ritorna l'MP3 completo in ~1-2s
// per risposte brevi — lo streaming pattern `/tts/sse` resta scope futuro.
const CARTESIA_TIMEOUT_MS = 8_000;

function cartesiaEnv() {
  return {
    apiKey: process.env.CARTESIA_API_KEY ?? "",
    // Default: Lorenzo - Hospitable Host (vedi commento .env per alternative)
    voiceId: process.env.CARTESIA_VOICE_IT ?? "ee16f140-f6dc-490e-a1ed-c1d537ea0086",
    // sonic-3 = SOTA latenza+qualità a 2026-04. sonic-2 disponibile come override
    // se sonic-3 dovesse mai degradare su un edge case specifico.
    modelId: process.env.CARTESIA_MODEL_ID ?? "sonic-3",
  };
}

export type TtsEngine = "cartesia" | "elevenlabs" | "mlx" | "kokoro" | "say";

// Read env lazily — `dotenv.config()` runs in index.ts at runtime,
// AFTER static imports finish evaluating, so capturing these at module
// top-level would freeze them to "" / defaults before .env is loaded.
function elevenEnv() {
  return {
    apiKey: process.env.ELEVENLABS_API_KEY ?? "",
    voiceId: process.env.ELEVENLABS_VOICE_ID ?? "iP95p4xoKVk53GoZ742B",
    // Flash v2.5: ~75ms TTFA vs ~250ms del multilingual_v2. Stessa voce IT,
    // stessa API surface, drop-in. La voce italiana resta `iP95p4xoKVk53GoZ742B`
    // (configurabile via ELEVENLABS_VOICE_ID). Override possibile via env per
    // tornare a multilingual_v2 se Flash dovesse degradare la qualità su un
    // workload specifico.
    modelId: process.env.ELEVENLABS_MODEL_ID ?? "eleven_flash_v2_5",
  };
}
// Streaming endpoint with optimize_streaming_latency=4 returns first audio
// bytes in ~150-250 ms vs 500-800 ms for the non-streaming REST endpoint.
const ELEVENLABS_TIMEOUT_MS = 10_000;

/**
 * In-flight ElevenLabs streams indexed by short ID. The notch /
 * dashboard player fetches `/api/notch/tts-stream/{id}`; the router endpoint
 * pulls the entry from this map and pipes the live response body via chunked
 * transfer-encoding, so audio plays as bytes arrive (true streaming, not
 * "fast file then play"). Entries are removed on take or after a TTL sweep.
 */
interface PendingTtsStream {
  body: ReadableStream<Uint8Array>;
  createdAt: number;
  /** Best-effort byte counter, populated as the stream is consumed. */
  bytes: number;
}
const pendingStreams = new Map<string, PendingTtsStream>();
const STREAM_TTL_MS = 60_000;

function gcStreams() {
  const now = Date.now();
  for (const [k, v] of pendingStreams) {
    if (now - v.createdAt > STREAM_TTL_MS) {
      try { v.body.cancel().catch(() => {}); } catch {}
      pendingStreams.delete(k);
    }
  }
}

/**
 * Open an ElevenLabs streaming connection for `text` and register the response
 * body in `pendingStreams`. Returns the stream ID immediately after the HTTP
 * status is known (so the caller can fall back to file-mode TTS when the
 * provider is down BEFORE telling the player about a URL that won't work).
 *
 * The caller is responsible for emitting `audio.play` with
 * `/api/notch/tts-stream/{id}`. The endpoint takes ownership of the body.
 */
export async function registerElevenLabsStream(text: string): Promise<string> {
  const env = elevenEnv();
  if (!env.apiKey) throw new Error("ELEVENLABS_API_KEY not set");
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty text");

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(env.voiceId)}` +
    `/stream?optimize_streaming_latency=4&output_format=mp3_44100_128`;

  // We don't abort on ELEVENLABS_TIMEOUT_MS here — the stream may legitimately
  // run longer than the timeout for long replies. The endpoint's chunked
  // transfer is the only timeout that matters once the body is flowing.
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": env.apiKey,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text: trimmed,
      model_id: env.modelId,
      voice_settings: { stability: 0.45, similarity_boost: 0.8 },
    }),
    signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
  });
  if (!resp.ok || !resp.body) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`elevenlabs ${resp.status}: ${detail.slice(0, 200)}`);
  }

  gcStreams();
  const id = randomUUID();
  pendingStreams.set(id, { body: resp.body, createdAt: Date.now(), bytes: 0 });
  return id;
}

/**
 * Cartesia Sonic-3 streaming via SSE → MP3.
 *
 * Cartesia `/tts/sse` ritorna eventi `chunk` con audio raw PCM Float32 LE
 * base64-encoded. Il container MP3 non è supportato lato Cartesia per SSE
 * (testato 2026-04-30: API risponde "only 'raw' container is supported").
 * Quindi convertiamo in pipe: SSE → decode base64 → PCM bytes → ffmpeg stdin
 * (`-f f32le -ar 44100 -ac 1`) → MP3 stdout → ReadableStream chunked al
 * consumer del WebView.
 *
 * Risultato: TTFA ~100-200ms (vs 1-2s del file-mode `/tts/bytes`). Lo speak
 * inizia a uscire dall'altoparlante prima ancora che Cartesia abbia finito
 * la sintesi del messaggio intero.
 *
 * Pattern identico a registerElevenLabsStream: ritorna un ID, il consumer
 * (HTTP endpoint /api/notch/tts-stream/{id}) prende il body via takeTtsStream.
 *
 * Errori: se Cartesia 4xx/5xx oppure ffmpeg non disponibile, throw —
 * il caller (notch.ts) cade su file-mode `speakToFile` automaticamente.
 */
export async function registerCartesiaStream(text: string): Promise<string> {
  const env = cartesiaEnv();
  if (!env.apiKey) throw new Error("CARTESIA_API_KEY not set");
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty text");

  // 1+2. Apri SSE con Cartesia E spawna ffmpeg IN PARALLELO. Il fetch SSE
  //      ha TTFB ~324ms (rete + Cartesia generation), ffmpeg ha cold-start
  //      ~50-100ms. Sequenziale: 324+100 = 424ms. Parallelo: max(324, 100) =
  //      324ms. Risparmio diretto sul TTFA.

  // 2. Spawna ffmpeg per convertire PCM Float32 → MP3 streaming.
  //    Flag low-latency critici (testato 2026-04-30: senza questi il TTFA
  //    cresce da ~400ms a ~1200ms perché ffmpeg di default bufferizza
  //    ~30 frame MP3 prima di emettere il primo packet):
  //      -fflags +nobuffer    no input analysis buffer
  //      -flags low_delay     prefer immediate output over efficiency
  //      -probesize 32        minimal stream probe
  //      -analyzeduration 0   skip stream analysis
  //      -flush_packets 1     flush ogni packet (no muxer queue)
  const ffmpeg = spawn("ffmpeg", [
    "-loglevel", "error",
    "-fflags", "+nobuffer",
    "-flags", "low_delay",
    "-probesize", "32",
    "-analyzeduration", "0",
    "-f", "f32le",
    "-ar", "44100",
    "-ac", "1",
    "-i", "pipe:0",
    "-f", "mp3",
    "-b:a", "128k",
    "-ac", "1",
    "-flush_packets", "1",
    "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"] });

  ffmpeg.stderr.on("data", (chunk: Buffer) => {
    const msg = chunk.toString("utf-8").trim();
    if (msg) log.debug({ msg }, "[cartesia] ffmpeg stderr");
  });
  ffmpeg.on("error", (err) => {
    log.warn({ err }, "[cartesia] ffmpeg spawn error");
  });

  // 1. Apri SSE con Cartesia (in parallelo con ffmpeg che è già spawnato sopra)
  const resp = await fetch("https://api.cartesia.ai/tts/sse", {
    method: "POST",
    headers: {
      "X-API-Key": env.apiKey,
      "Cartesia-Version": "2024-11-13",
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    body: JSON.stringify({
      model_id: env.modelId,
      transcript: trimmed,
      voice: { mode: "id", id: env.voiceId },
      language: "it",
      output_format: {
        container: "raw",
        encoding: "pcm_f32le",
        sample_rate: 44100,
      },
    }),
    signal: AbortSignal.timeout(CARTESIA_TIMEOUT_MS),
  });
  if (!resp.ok || !resp.body) {
    // Cartesia rifiutato — kill ffmpeg che abbiamo già spawnato
    try { ffmpeg.kill("SIGTERM"); } catch {}
    const detail = await resp.text().catch(() => "");
    throw new Error(`cartesia sse ${resp.status}: ${detail.slice(0, 200)}`);
  }

  // 3. Pump SSE → ffmpeg stdin (decode base64 ad ogni chunk).
  //    SSE format: lines like `event: chunk\ndata: {...}\n\n`. Parsiamo
  //    line-by-line per estrarre i payload `data:` e decodificare il base64.
  const sseReader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let leftover = "";

  (async () => {
    try {
      while (true) {
        const { value, done } = await sseReader.read();
        if (done) break;
        const text = leftover + decoder.decode(value, { stream: true });
        const lines = text.split("\n");
        leftover = lines.pop() ?? ""; // ultima linea può essere parziale

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          try {
            const evt = JSON.parse(json) as { type?: string; data?: string; done?: boolean };
            if (evt.type === "chunk" && typeof evt.data === "string" && evt.data.length > 0) {
              const pcm = Buffer.from(evt.data, "base64");
              if (!ffmpeg.stdin.write(pcm)) {
                // Backpressure: aspetta il drain prima di continuare a scrivere
                await new Promise<void>((resolve) => ffmpeg.stdin.once("drain", resolve));
              }
            }
            if (evt.done === true) {
              // Cartesia ha mandato l'ultimo chunk → chiudi stdin di ffmpeg
              // così termina il MP3 e EOF allo stdout.
              ffmpeg.stdin.end();
            }
          } catch (err) {
            log.warn({ err, line: line.slice(0, 120) }, "[cartesia] sse parse error");
          }
        }
      }
      // SSE stream finito senza event done → close ffmpeg stdin comunque
      if (!ffmpeg.stdin.destroyed) ffmpeg.stdin.end();
    } catch (err) {
      log.warn({ err }, "[cartesia] sse pump error");
      if (!ffmpeg.stdin.destroyed) ffmpeg.stdin.end();
    }
  })();

  // 4. Wrap ffmpeg stdout in ReadableStream<Uint8Array> — il consumer
  //    HTTP endpoint piperà i chunk al WebView via chunked transfer.
  const mp3Stream = new ReadableStream<Uint8Array>({
    start(controller) {
      ffmpeg.stdout.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      ffmpeg.stdout.on("end", () => {
        controller.close();
      });
      ffmpeg.stdout.on("error", (err) => {
        log.warn({ err }, "[cartesia] ffmpeg stdout error");
        controller.error(err);
      });
      ffmpeg.on("close", (code) => {
        if (code !== 0 && code !== null) {
          log.warn({ code }, "[cartesia] ffmpeg exited non-zero");
        }
      });
    },
    cancel() {
      try { ffmpeg.kill("SIGTERM"); } catch {}
      try { sseReader.cancel(); } catch {}
    },
  });

  gcStreams();
  const id = randomUUID();
  pendingStreams.set(id, { body: mp3Stream, createdAt: Date.now(), bytes: 0 });
  return id;
}

/**
 * Hand off the registered body to the HTTP endpoint. Returns null if the ID
 * is unknown or the entry already expired. Removes the entry — a stream is
 * single-consumer.
 */
export function takeTtsStream(id: string): ReadableStream<Uint8Array> | null {
  const entry = pendingStreams.get(id);
  log.info({ id, found: !!entry, registry: pendingStreams.size }, "[tts] take stream");
  if (!entry) return null;
  pendingStreams.delete(id);
  return entry.body;
}

export interface SpeakResult {
  engine: TtsEngine;
  /** IANA media type of the bytes now written at `outPath`. */
  mime: string;
  bytes: number;
}

/**
 * Synthesise `text` to `outPath`. Tries Kokoro (on-device ONNX, better voice)
 * first; falls back to macOS `say` when Kokoro is unavailable, times out, or
 * errors. Never throws — on total failure returns `{ bytes: 0 }` so callers
 * can skip playback without a try/catch on every site.
 */
export async function speakToFile(
  text: string,
  outPath: string,
  opts: { voice?: string } = {},
): Promise<SpeakResult> {
  const trimmed = text.trim();
  if (!trimmed) return { engine: "say", mime: "audio/mpeg", bytes: 0 };

  // TOP-ONLY cascade (2026-04-30):
  //   1. Cartesia Sonic-3 IT (40ms TTFA streaming, voce italiana native)
  //   2. ElevenLabs Flash v2.5 (75ms TTFA, voce IT già consolidata)
  //   3. macOS `say` (last-resort emergency, robotico ma sempre disponibile)
  // MLX Voxtral e Kokoro sono RIMOSSI dal cascade primario — restano
  // accessibili solo con JARVIS_TTS_ALLOW_LEGACY=1 (opt-in dev/debug).
  if (process.env.CARTESIA_API_KEY) {
    try {
      const bytes = await runCartesia(trimmed, outPath);
      if (bytes > 0) return { engine: "cartesia", mime: "audio/mpeg", bytes };
    } catch (err) {
      log.debug({ err }, "cartesia unavailable, trying elevenlabs");
    }
  }

  if (process.env.ELEVENLABS_API_KEY) {
    try {
      const bytes = await runElevenLabs(trimmed, outPath);
      if (bytes > 0) return { engine: "elevenlabs", mime: "audio/mpeg", bytes };
    } catch (err) {
      log.debug({ err }, "elevenlabs unavailable, trying next");
    }
  }

  if (ALLOW_LEGACY_TTS) {
    try {
      const bytes = await runMlx(trimmed, opts.voice ?? "it_male", outPath);
      if (bytes > 0) return { engine: "mlx", mime: "audio/mpeg", bytes };
    } catch (err) {
      log.debug({ err }, "mlx unavailable (legacy opt-in), trying kokoro");
    }
    try {
      const bytes = await runKokoro(trimmed, "af_sky", outPath);
      if (bytes > 0) return { engine: "kokoro", mime: "audio/mpeg", bytes };
    } catch (err) {
      log.debug({ err }, "kokoro unavailable (legacy opt-in), falling back to say");
    }
  }

  try {
    const sayVoice = "Alice";
    const bytes = await runSay(trimmed, outPath, sayVoice);
    return { engine: "say", mime: "audio/mpeg", bytes };
  } catch (err) {
    log.warn({ err }, "say fallback failed");
    return { engine: "say", mime: "audio/mpeg", bytes: 0 };
  }
}

/**
 * Cartesia Sonic-3 file-buffered TTS.
 *
 * POST /tts/bytes ritorna l'MP3 completo in un singolo response body. Usato
 * dal cascade `speakToFile` per il path attuale (notch.ts emette `audio.play`
 * con URL al file). Lo streaming pattern via `/tts/sse` con AnalyserNode
 * resta lavoro futuro (Fase 3.2 — reactive aura).
 *
 * Voce default: Lorenzo - Hospitable Host (configurabile via CARTESIA_VOICE_IT).
 */
async function runCartesia(text: string, outPath: string): Promise<number> {
  const env = cartesiaEnv();
  if (!env.apiKey) throw new Error("CARTESIA_API_KEY not set");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CARTESIA_TIMEOUT_MS);
  try {
    const resp = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: {
        "X-API-Key": env.apiKey,
        "Cartesia-Version": "2024-11-13",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: env.modelId,
        transcript: text,
        voice: { mode: "id", id: env.voiceId },
        language: "it",
        output_format: {
          container: "mp3",
          sample_rate: 44100,
          bit_rate: 128000,
        },
      }),
      signal: ac.signal,
    });
    if (!resp.ok || !resp.body) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`cartesia ${resp.status}: ${detail.slice(0, 200)}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) throw new Error("cartesia empty body");
    await writeFile(outPath, buf);
    return buf.length;
  } finally {
    clearTimeout(timer);
  }
}

async function runElevenLabs(text: string, outPath: string): Promise<number> {
  const env = elevenEnv();
  if (!env.apiKey) throw new Error("ELEVENLABS_API_KEY not set");
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(env.voiceId)}` +
    `/stream?optimize_streaming_latency=4&output_format=mp3_44100_128`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ELEVENLABS_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": env.apiKey,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: env.modelId,
        voice_settings: { stability: 0.45, similarity_boost: 0.8 },
      }),
      signal: ac.signal,
    });
    if (!resp.ok || !resp.body) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`elevenlabs ${resp.status}: ${detail.slice(0, 200)}`);
    }
    const chunks: Buffer[] = [];
    const reader = resp.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    const body = Buffer.concat(chunks);
    if (body.length === 0) throw new Error("elevenlabs empty stream");
    await writeFile(outPath, body);
    return body.length;
  } finally {
    clearTimeout(timer);
  }
}

function runMlx(text: string, voice: string, outPath: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const proc = spawn("python3", [MLX_SCRIPT, "--voice", voice, "--format", "mp3"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    proc.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    const killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, MLX_TIMEOUT_MS);
    proc.on("error", (err) => { clearTimeout(killTimer); reject(err); });
    proc.on("close", async (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim().slice(0, 400);
        reject(new Error(`mlx exit ${code}: ${stderr}`));
        return;
      }
      const body = Buffer.concat(stdoutChunks);
      if (body.length === 0) { reject(new Error("mlx produced empty stream")); return; }
      try {
        await writeFile(outPath, body);
        resolve(body.length);
      } catch (err) { reject(err); }
    });
    proc.stdin.write(text, "utf-8");
    proc.stdin.end();
  });
}

function runKokoro(text: string, voice: string, outPath: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const proc = spawn("python3", [KOKORO_SCRIPT, "--voice", voice, "--format", "mp3"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    proc.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    const killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, KOKORO_TIMEOUT_MS);
    proc.on("error", (err) => { clearTimeout(killTimer); reject(err); });
    proc.on("close", async (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim().slice(0, 400);
        reject(new Error(`kokoro exit ${code}: ${stderr}`));
        return;
      }
      const body = Buffer.concat(stdoutChunks);
      if (body.length === 0) { reject(new Error("kokoro produced empty stream")); return; }
      try {
        await writeFile(outPath, body);
        resolve(body.length);
      } catch (err) { reject(err); }
    });
    proc.stdin.write(text, "utf-8");
    proc.stdin.end();
  });
}

/**
 * macOS `say` → AIFF, then ffmpeg → MP3. Two-step because `say --data-format`
 * flags are version-dependent and fragile; writing AIFF + converting is
 * reliable on every macOS release we care about.
 */
async function runSay(text: string, outPath: string, voice: string = "Eddy"): Promise<number> {
  const aiff = join(tmpdir(), `jarvis-say-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.aiff`);
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn("say", ["-v", voice, "-o", aiff, text], { stdio: ["ignore", "ignore", "pipe"] });
      const err: Buffer[] = [];
      p.stderr.on("data", (c: Buffer) => err.push(c));
      p.on("error", reject);
      p.on("close", (code) => code === 0
        ? resolve()
        : reject(new Error(`say exit ${code}: ${Buffer.concat(err).toString("utf-8").slice(0, 200)}`)));
    });
    await new Promise<void>((resolve, reject) => {
      const p = spawn("ffmpeg", [
        "-y", "-loglevel", "error",
        "-i", aiff,
        "-f", "mp3", "-b:a", "48k", "-ac", "1",
        outPath,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      const err: Buffer[] = [];
      p.stderr.on("data", (c: Buffer) => err.push(c));
      p.on("error", reject);
      p.on("close", (code) => code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(err).toString("utf-8").slice(0, 200)}`)));
    });
    const s = await stat(outPath);
    return s.size;
  } finally {
    try { await unlink(aiff); } catch {}
  }
}
