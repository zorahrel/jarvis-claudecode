/**
 * Install the window.* APIs that NotchController.swift calls into.
 *
 * The Swift side (lazy-loaded WKWebView in the notch panel) calls things
 * like `window.__notchPush(role, text)` after STT finalizes, or
 * `window.__notchPartialLevel(rms)` while the user is talking. Those
 * callbacks must exist before Swift starts emitting events — install
 * them on mount of the App component.
 *
 * Each Swift-bridge method maps to a Zustand mutator. Side effects
 * (audio element control, posting back to Swift) stay outside the store.
 */
import { useEffect } from "react";
import { useNotchStore } from "../store";

/** postMessage helper to the native side. No-op outside WKWebView. */
function toNative(type: string, extra: Record<string, unknown> = {}): void {
  const handler = (window as any).webkit?.messageHandlers?.jarvis;
  if (!handler) return;
  try { handler.postMessage({ type, ...extra }); } catch (_) { /* ignore */ }
}

export function useSwiftBridge(): void {
  useEffect(() => {
    const store = useNotchStore;

    // Bubble append (assistant final OR user). The bundle minified used to
    // own this; we replace its behavior. The legacy hook ordering trick
    // (origPush hook) is unnecessary because we are the only consumer.
    (window as any).__notchPush = (role: "user" | "assistant", text: string) => {
      if (role === "assistant") {
        store.getState().finalizeAssistant(text);
      } else {
        store.getState().appendUserBubble(text);
      }
    };

    // Live mic level from Swift: 0..1 already RMS-scaled. Mirror into a CSS
    // variable so styles.css's `--voice-level`-driven box-shadow on the
    // input row pulses with the user's voice without any React re-render.
    (window as any).__notchPartialLevel = (level: number) => {
      const v = Number(level) || 0;
      document.documentElement.style.setProperty("--voice-level", String(v));
      store.getState().setMicLevel(v);
    };

    // Voice state hints from Swift's RMS-based VAD (different from the
    // browser-side Silero VAD). Drive the body-level CSS classes that
    // styles.css uses to swap the aura colour ("listening" cyan vs
    // "voiced" gold) and trigger the voice-voiced-pulse keyframe.
    (window as any).__notchVoiceVoiced = () => {
      document.body.classList.remove("voice-listening");
      document.body.classList.add("voice-voiced");
    };
    (window as any).__notchVoiceSilent = () => {
      document.body.classList.remove("voice-voiced");
      document.body.classList.add("voice-listening");
    };

    // Live transcript bubble lifecycle (Swift opens before STT, closes
    // after, sends partials/finals in between).
    (window as any).__notchVoiceLiveStart = () => {
      document.body.classList.add("voice-listening");
      store.getState().setLivePartial("");
    };
    (window as any).__notchVoiceLiveEnd = () => {
      document.body.classList.remove("voice-listening", "voice-voiced");
      document.documentElement.style.removeProperty("--voice-level");
      store.getState().setLivePartial("");
    };
    (window as any).__notchVoicePartial = (text: string) => {
      store.getState().setLivePartial(String(text || ""));
    };
    (window as any).__notchVoiceFinal = (text: string) => {
      // Swift doesn't always trigger /api/notch/send (legacy WAV upload path).
      // If a final lands here without an SSE message.out, append the user
      // bubble to keep the chat in sync.
      const trimmed = String(text || "").trim();
      if (trimmed) store.getState().appendUserBubble(trimmed);
      store.getState().setLivePartial("");
    };

    // Mic state pulse from Swift. Two callsites:
    //   - pushMicState(on:) sends literal 'on' / 'off' strings
    //   - older callers send a boolean
    // Normalize and mirror into the store so the call button reflects the
    // actual recorder state (avoids click-out-of-sync after Swift refuses
    // to arm or auto-times-out).
    (window as any).__notchSetMicState = (raw: unknown) => {
      const on = raw === true || raw === "on" || raw === 1;
      store.getState().setInCall(on);
    };

    // Hover-record grace window. Swift fires Start when the user's mouse
    // leaves the hover zone but the recorder hasn't stopped yet — gives
    // the user `graceMs` to come back without losing the in-progress
    // recording. End/Cancel hide the affordance.
    (window as any).__notchVoiceGraceStart = (graceMs: number) => {
      document.getElementById("grace-aura")?.remove();
      const el = document.createElement("div");
      el.className = "grace-aura";
      el.id = "grace-aura";
      el.style.setProperty("--grace-ms", `${Number(graceMs) || 2500}ms`);
      document.body.appendChild(el);
    };
    (window as any).__notchVoiceGraceCancel = () => {
      document.getElementById("grace-aura")?.remove();
    };
    (window as any).__notchVoiceGraceEnd = () => {
      document.getElementById("grace-aura")?.remove();
    };
    // AbortWarn pulses the red ring around the panel when the cursor is
    // close enough to the bottom-right corner that releasing would abort.
    (window as any).__notchVoiceAbortWarn = (on: boolean) => {
      document.getElementById("abort-warn")?.remove();
      if (on) {
        const el = document.createElement("div");
        el.className = "abort-warn";
        el.id = "abort-warn";
        document.body.appendChild(el);
      }
    };

    // Bumps used by the legacy bundle to flush a streaming text bubble.
    // Replaced by Zustand reactivity → no-op.
    (window as any).__notchBumpStream = () => {};

    // Audio control from Swift (barge-in path triggers
    // window.jarvisAudio.stop() to halt playback synchronously).
    (window as any).jarvisAudio = {
      stop: () => {
        document.querySelectorAll("audio").forEach((el) => {
          try { (el as HTMLAudioElement).pause(); } catch {}
          (el as HTMLAudioElement).removeAttribute("src");
        });
      },
    };

    // Hint to Swift that the React app is initialized and ready to receive
    // bridge calls. The legacy bundle also sent something similar.
    toNative("ready");

    // ESC keyboard shortcut: stop any TTS audio + ask Swift to collapse.
    // The Swift bridge already supports `{type: "collapse"}` (see
    // NotchWebBridge.userContentController), it just had nobody to send it.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Stop any in-flight TTS playback locally first (instantaneous).
      try { (window as any).jarvisAudio?.stop?.(); } catch {}
      toNative("collapse");
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Cleanup: drop the global overrides on unmount. In practice the
      // notch app never unmounts, but keep the contract clean.
      delete (window as any).__notchPush;
      delete (window as any).__notchPartialLevel;
      delete (window as any).__notchVoiceVoiced;
      delete (window as any).__notchVoiceSilent;
      delete (window as any).__notchVoiceLiveStart;
      delete (window as any).__notchVoiceLiveEnd;
      delete (window as any).__notchVoicePartial;
      delete (window as any).__notchVoiceFinal;
      delete (window as any).__notchSetMicState;
      delete (window as any).__notchVoiceGraceStart;
      delete (window as any).__notchVoiceGraceCancel;
      delete (window as any).__notchVoiceGraceEnd;
      delete (window as any).__notchVoiceAbortWarn;
      delete (window as any).__notchBumpStream;
      delete (window as any).jarvisAudio;
    };
  }, []);
}
