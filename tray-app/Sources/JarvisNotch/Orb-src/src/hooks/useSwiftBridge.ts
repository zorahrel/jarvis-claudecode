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

    // Live mic level from Swift: 0..1 already RMS-scaled.
    (window as any).__notchPartialLevel = (level: number) => {
      const v = Number(level) || 0;
      store.getState().setMicLevel(v);
    };

    // Voice state hints from Swift's RMS-based VAD (different from the
    // browser-side Silero VAD). Used for chip color in the toolbar.
    (window as any).__notchVoiceVoiced = () => { /* could trigger UI flag */ };
    (window as any).__notchVoiceSilent = () => { /* idem */ };

    // Live transcript bubble lifecycle (Swift opens before STT, closes
    // after, sends partials/finals in between).
    (window as any).__notchVoiceLiveStart = () => store.getState().setLivePartial("");
    (window as any).__notchVoiceLiveEnd = () => store.getState().setLivePartial("");
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

    // Hover-record grace window (Swift signals it's about to abort if user
    // doesn't return). For now, no-op — was only used for an explicit
    // "annulla" affordance overlay.
    (window as any).__notchVoiceGraceStart = () => {};
    (window as any).__notchVoiceGraceCancel = () => {};
    (window as any).__notchVoiceGraceEnd = () => {};
    (window as any).__notchVoiceAbortWarn = () => {};

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

    return () => {
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
