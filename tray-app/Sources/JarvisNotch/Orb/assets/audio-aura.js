/**
 * Audio aura — reactive visual feedback per il notch.
 *
 * Drive l'orb three.js (#three-container) con due segnali audio:
 *
 *   1. Mic level durante recording (Swift → JS via window.__notchPartialLevel).
 *      Il valore è 0..1 già scalato dalla RMS dell'AVAudioEngine tap.
 *
 *   2. TTS playback — AnalyserNode collegato all'<audio> element creato da
 *      playAudio() in notch.html. Estraiamo frequencyData a 60Hz e usiamo
 *      la media RMS dello spettro come ampiezza.
 *
 * Output: scale + opacity dell'orb container animati via GSAP. Niente
 * modifiche al bundle three.js minified — solo CSS transform/opacity sul
 * wrapper. Il bundle continua a renderizzare la scena 3D, noi aggiungiamo
 * un layer di breathing.
 *
 * Performance budget: idle 0% CPU, durante audio < 1% (un AnalyserNode +
 * un requestAnimationFrame loop).
 */

(function () {
  "use strict";

  // Deferred init: il bundle three.js crea #three-container in parallelo,
  // potrebbe non essere ancora nel DOM quando questo script viene parsed.
  // Polling leggero (max 2s) per attendere — niente warning se l'orb non
  // appare (es. embed mirror senza three).
  let ORB = document.getElementById("three-container");
  if (!ORB) {
    let attempts = 0;
    const tryFindOrb = () => {
      ORB = document.getElementById("three-container");
      if (ORB) return; // proceed to setup below (handled by re-trigger)
      if (++attempts < 20) setTimeout(tryFindOrb, 100);
      // After 2s give up silently — orb not in this page (e.g. degraded mode)
    };
    tryFindOrb();
    // Setup the rest of the script anyway: callbacks/aura state still
    // exposed; ORB just won't be animated. setIntensity becomes a no-op.
  }

  // Stato dell'animazione — un'unica sorgente di "intensità" 0..1 a cui
  // applicare scale/opacity. Viene aggiornata da entrambe le sorgenti
  // (mic + TTS) con un easing decadente per evitare flickering quando i
  // sample audio scendono a zero per un frame.
  let intensity = 0;
  let targetIntensity = 0;
  const DECAY = 0.85; // ogni frame: intensity = max(target, intensity * DECAY)
  let rafId = null;
  let active = false;

  function startAnimationLoop() {
    if (active) return;
    active = true;
    function tick() {
      // Smooth: target sale subito, scende con decay
      if (targetIntensity > intensity) {
        intensity = targetIntensity;
      } else {
        intensity = Math.max(targetIntensity, intensity * DECAY);
      }
      // Mappa intensity → trasformazioni dell'orb
      // - scale: 1.0 (idle) → 1.18 (massimo), curva quadratica per dare "punch"
      // - opacity: 0.85 (idle) → 1.0 (massimo)
      const scale = 1 + 0.18 * Math.pow(intensity, 1.5);
      const opacity = 0.85 + 0.15 * intensity;
      // Guard: ORB might not exist yet during boot or in stripped-down
      // embed contexts (dashboard mirror without three.js bundle).
      if (ORB && ORB.style) {
        ORB.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
        ORB.style.opacity = opacity.toFixed(3);
      }

      // Stop il loop quando siamo tornati piatti per evitare drain CPU
      if (intensity < 0.001 && targetIntensity < 0.001) {
        if (ORB && ORB.style) {
          ORB.style.transform = "translate(-50%, -50%)";
          ORB.style.opacity = "";
        }
        intensity = 0;
        active = false;
        rafId = null;
        return;
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------
  // 1. MIC LEVEL bridge (Swift → JS)
  //
  // Il NotchController.swift chiama:
  //   window.__notchPartialLevel(0..1)         ~10Hz mentre l'utente parla
  //   window.__notchVoiceVoiced() / Silent()   ai bordi dell'utterance
  //
  // Conserviamo eventuali handler già installati (es. dal bundle notch.js)
  // per non rompere l'UI esistente — chainiamo prima il nostro update poi
  // delego all'handler precedente se c'era.
  // ---------------------------------------------------------------------
  const prevPartial = window.__notchPartialLevel;
  window.__notchPartialLevel = function (level) {
    const clamped = Math.max(0, Math.min(1, +level || 0));
    targetIntensity = Math.max(targetIntensity, clamped);
    startAnimationLoop();
    if (typeof prevPartial === "function") {
      try { prevPartial(level); } catch (_) {}
    }
  };

  const prevVoiced = window.__notchVoiceVoiced;
  window.__notchVoiceVoiced = function () {
    if (typeof prevVoiced === "function") { try { prevVoiced(); } catch (_) {} }
  };

  const prevSilent = window.__notchVoiceSilent;
  window.__notchVoiceSilent = function () {
    targetIntensity = 0; // decay naturale
    if (typeof prevSilent === "function") { try { prevSilent(); } catch (_) {} }
  };

  // ---------------------------------------------------------------------
  // 2. TTS PLAYBACK ANALYSER
  //
  // Quando playAudio() in notch.html crea un <audio> element con TTS, lo
  // hookiamo a un AudioContext + AnalyserNode (FFT 256 → 128 bins).
  //
  // Ogni audio playback richiede una NUOVA MediaElementSource — lo stesso
  // node collegato al contesto può andare in stato "media element already
  // connected" se l'<audio> viene riusato. Per sicurezza creiamo un
  // contesto on-demand al primo play e tracciamo il source per cleanup.
  // ---------------------------------------------------------------------
  let audioCtx = null;
  let analyser = null;
  let analyserSource = null;
  let analyserBuffer = null;
  let lastHookedAudio = null;

  function ensureAnalyser() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        console.warn("[aura] AudioContext not available");
        return null;
      }
      audioCtx = new Ctx();
    }
    if (!analyser) {
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      analyserBuffer = new Uint8Array(analyser.frequencyBinCount);
    }
    return analyser;
  }

  function hookAudioElement(audioEl) {
    if (!audioEl || audioEl === lastHookedAudio) return;
    if (!ensureAnalyser()) return;

    // Disconnect il precedente source — un MediaElementSource non si può
    // riusare e tenerlo attaccato leak memoria. Best-effort: l'API non
    // documenta un disconnect-by-source pulito, ma chiamare disconnect()
    // sul nodo basta in pratica.
    if (analyserSource) {
      try { analyserSource.disconnect(); } catch (_) {}
      analyserSource = null;
    }

    try {
      analyserSource = audioCtx.createMediaElementSource(audioEl);
      analyserSource.connect(analyser);
      analyser.connect(audioCtx.destination);
      lastHookedAudio = audioEl;
    } catch (err) {
      console.warn("[aura] createMediaElementSource failed:", err);
    }
  }

  function pollTTSAura() {
    if (!analyser || !analyserBuffer) return;
    analyser.getByteFrequencyData(analyserBuffer);
    // Media solo sui bin bassi-medi (voce umana 80Hz-2kHz ≈ bin 1..30 a 44.1kHz/256)
    let sum = 0;
    const N = Math.min(30, analyserBuffer.length);
    for (let i = 1; i < N; i++) sum += analyserBuffer[i];
    const avg = sum / (N - 1) / 255; // normalizza a 0..1
    targetIntensity = Math.max(targetIntensity, avg);
    startAnimationLoop();
  }
  let ttsPollHandle = null;
  function startTTSAuraPoll() {
    if (ttsPollHandle) return;
    function loop() {
      pollTTSAura();
      ttsPollHandle = requestAnimationFrame(loop);
    }
    ttsPollHandle = requestAnimationFrame(loop);
  }
  function stopTTSAuraPoll() {
    if (ttsPollHandle) cancelAnimationFrame(ttsPollHandle);
    ttsPollHandle = null;
    targetIntensity = 0;
  }

  // Detect <audio> element creation (notch.html crea/riusa un singolo
  // elemento via ensureAudio()). Polling DOM è ok perché succede una sola
  // volta. Hookiamo anche `audio.play` event globalmente per resume cases.
  function discoverAudioElement() {
    const els = document.querySelectorAll("audio");
    for (const el of els) {
      if (el !== lastHookedAudio) {
        // Wait for first play before hooking — Safari/WebKit on macOS
        // deny createMediaElementSource if the element has no real source
        // yet (CORS check). The 'play' event fires only after src + load.
        el.addEventListener("play", function onPlay() {
          el.removeEventListener("play", onPlay);
          hookAudioElement(el);
          // Resume audioCtx if it was suspended (autoplay policy)
          if (audioCtx && audioCtx.state === "suspended") {
            audioCtx.resume().catch(() => {});
          }
          startTTSAuraPoll();
        });
        el.addEventListener("ended", () => stopTTSAuraPoll());
        el.addEventListener("error", () => stopTTSAuraPoll());
        el.addEventListener("pause", () => stopTTSAuraPoll());
        // Mark to skip on next discovery pass
        el.__auraWired = true;
      }
    }
    // Re-scan periodically — ensureAudio() in notch.html non ci notifica
    setTimeout(discoverAudioElement, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", discoverAudioElement);
  } else {
    discoverAudioElement();
  }

  // Espongo per debug / dashboard mirror
  window.__notchAura = {
    setIntensity(v) { targetIntensity = Math.max(0, Math.min(1, +v || 0)); startAnimationLoop(); },
    getIntensity() { return intensity; },
    isActive() { return active; },
  };
})();
