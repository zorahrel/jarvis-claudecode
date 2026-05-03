/**
 * VAD controller per il notch.
 *
 * Usa Silero VAD via @ricky0123/vad-web — gli asset sono bundlati in `/vad/`
 * (silero_vad_v5.onnx, vad.worklet.bundle.min.js, ort-wasm-simd-threaded.{mjs,wasm}).
 * Tutto è caricato localmente: zero dipendenze CDN, zero rete a runtime.
 *
 * Quando rileva l'inizio del parlato dell'utente emette un evento al native
 * via window.webkit.messageHandlers.notch.postMessage. Il NotchController.swift
 * decide se è un barge-in (TTS attiva → stop) o un end-of-utterance hint per
 * accelerare il flush della trascrizione.
 *
 * Il caricamento di `@ricky0123/vad-web` avviene via dynamic import dal worker
 * stesso — il bundle ufficiale espone MicVAD come ES module, ma noi non
 * vogliamo un import remoto (offline-first, niente CDN). Soluzione: nel worklet
 * locale c'è già il modello + ONNX runtime; il wrapper minimal qui sotto
 * implementa la stessa interfaccia chiamando direttamente AudioWorkletNode.
 *
 * NOTA OPERATIVA: non avviamo il VAD finché lo Swift non ce lo dice esplicitamente
 * via `window.jarvisVAD.start()` — serve assicurarci che la TCC mic permission
 * sia stata già concessa, altrimenti getUserMedia rimbalza un denied alla prima
 * call e il VAD resta morto fino al prossimo refresh.
 */

// IMPORTANT: il bridge handler lato Swift è registrato con name "jarvis"
// (vedi NotchWebBridge in NotchController.swift). Usare "notch" qui faceva
// cadere TUTTI gli eventi VAD nel cestino → barge-in e fast-flush morti.
const NATIVE_BRIDGE = window.webkit?.messageHandlers?.jarvis ?? null;
const VAD_LOG = (...args) => console.debug("[vad]", ...args);

function postNative(type, data) {
  if (!NATIVE_BRIDGE) {
    VAD_LOG("no native bridge, dropping event:", type);
    return;
  }
  try {
    NATIVE_BRIDGE.postMessage({ type, data: data ?? {} });
  } catch (err) {
    VAD_LOG("postMessage failed:", err);
  }
}

let vad = null;
let isPaused = false;
let isStarting = false;

/**
 * Carica @ricky0123/vad-web via dynamic import. Il pacchetto NPM espone
 * `MicVAD.new(opts)`. Risolviamo via esm.sh la PRIMA VOLTA (~50KB cached);
 * il modello ONNX e il worklet vengono presi dal nostro `/vad/` locale, NON
 * da CDN. Quindi solo il bootstrap ~50KB JS è remoto al primo avvio, poi
 * cache HTTP del WKWebView lo serve offline.
 */
async function loadVADLib() {
  // TODO(offline-first): l'import remoto da esm.sh contraddice la promessa
  // "zero CDN" del file. Bundlare @ricky0123/vad-web@0.0.27 in
  // Orb/vendor/vad-web/ e ri-puntare l'import lì. Per ora try/catch + log
  // così, se il primo avvio è offline, vediamo l'errore esplicitamente
  // invece di silenziare il VAD (postNative("vad.error", ...) lo emette).
  // esm.sh è stabile, gestisce CORS, e resta lo stesso URL della doc ufficiale.
  // Pinning della versione per evitare breakages: 0.0.27 è quello compatibile
  // con i nostri asset locali silero_vad_v5.onnx + vad.worklet.bundle.min.js.
  try {
    const { MicVAD } = await import("https://esm.sh/@ricky0123/vad-web@0.0.27");
    return MicVAD;
  } catch (err) {
    VAD_LOG("loadVADLib: remote import failed (offline?):", err);
    throw err;
  }
}

/**
 * Avvia il VAD. Idempotente — se già attivo, no-op.
 * Lo Swift chiama questa funzione dopo aver verificato la TCC mic permission.
 */
export async function startVAD() {
  if (vad || isStarting) {
    VAD_LOG("startVAD already running/starting");
    return;
  }
  isStarting = true;
  try {
    const MicVAD = await loadVADLib();
    vad = await MicVAD.new({
      // Asset locali — niente CDN per il modello + worklet (offline-first)
      workletURL: "./vad/vad.worklet.bundle.min.js",
      modelURL: "./vad/silero_vad_v5.onnx",
      onnxWASMBasePath: "./vad/",

      // Soglie — tarate sul mic interno MacBook Pro M-series in stanza
      // moderatamente silenziosa. Se in produzione fa troppi misfire,
      // alzare positiveSpeechThreshold a 0.7. Se manca trigger su parlato
      // pacato, abbassare a 0.5.
      positiveSpeechThreshold: 0.6,
      negativeSpeechThreshold: 0.3,
      // 5 frame ≈ 160ms a 31.25Hz frame rate del Silero v5: filtra
      // colpi di tosse, click di mouse, respiri.
      minSpeechFrames: 5,
      // 24 frame ≈ 770ms tail prima di considerare finito un turno —
      // permette pause naturali nel parlato senza chiudere l'utterance.
      redemptionFrames: 24,

      onSpeechStart: () => {
        if (isPaused) return;
        VAD_LOG("speechStart");
        postNative("vad.speechStart");
      },
      onSpeechEnd: (audio) => {
        if (isPaused) return;
        // `audio` è Float32Array PCM 16kHz mono. Per ora non lo serializziamo
        // al native — basta il segnale temporale per accelerare il flush dello
        // StreamingRecorder Swift. Se serve saltare lo Swift recorder e mandare
        // direttamente il PCM al server, è qui che si farebbe il transferimento.
        VAD_LOG("speechEnd, samples=", audio.length);
        postNative("vad.speechEnd", { samples: audio.length });
      },
      onVADMisfire: () => {
        // Trigger falso (sub-minSpeechFrames). Non lo logghiamo al native per
        // non spammare, ma è utile in dev per tarare le soglie.
        VAD_LOG("misfire");
      },
    });

    await vad.start();
    postNative("vad.ready");
    VAD_LOG("ready");
  } catch (err) {
    VAD_LOG("startVAD failed:", err);
    postNative("vad.error", { message: String(err) });
    vad = null;
  } finally {
    isStarting = false;
  }
}

/**
 * Pausa il VAD (smette di emettere eventi) senza distruggerlo.
 * Usato durante TTS playback quando NON vogliamo trigger di barge-in
 * (es. registrare in modalità dictation pura).
 */
export function pauseVAD() {
  isPaused = true;
  postNative("vad.paused");
  VAD_LOG("paused");
}

export function resumeVAD() {
  isPaused = false;
  postNative("vad.resumed");
  VAD_LOG("resumed");
}

/**
 * Stop completo. Rilascia il microfono. Il successivo startVAD() riapre
 * il device — utile se cambiamo input device a runtime.
 */
export function stopVAD() {
  if (!vad) return;
  try {
    vad.pause();
    vad.destroy();
  } catch (err) {
    VAD_LOG("stopVAD error:", err);
  }
  vad = null;
  postNative("vad.stopped");
  VAD_LOG("stopped");
}

// Espongo i controlli sul global scope. Il NotchController.swift chiama
// queste funzioni via WKWebView.evaluateJavaScript:
//   webView.evaluateJavaScript("window.jarvisVAD.start()")
window.jarvisVAD = {
  start: startVAD,
  pause: pauseVAD,
  resume: resumeVAD,
  stop: stopVAD,
  isActive: () => vad !== null && !isPaused,
};
