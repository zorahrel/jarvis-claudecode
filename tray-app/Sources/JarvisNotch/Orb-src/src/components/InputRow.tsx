/**
 * Input row: call button (toggles sticky continuous-call mode), text input,
 * send button.
 *
 * Same DOM/classes as legacy notch.html so CSS rules apply unchanged
 * (.input-row, .mic, .input, .send, [disabled] state, .mic.recording for
 * the active call indicator).
 *
 * The call button posts `voiceStart` / `voiceStop` to the Swift bridge.
 * Swift's `NotchController.startVoice/stopVoice` arms the StreamingRecorder
 * in sticky mode (survives mouse-out / collapse). Swift mirrors the actual
 * recorder state back via `window.__notchSetMicState`, which lands in the
 * store via useSwiftBridge — so the button reflects the truth even if the
 * recorder refuses (e.g. permission revoked, already running).
 *
 * Outside WKWebView (browser test, dashboard mirror) there's no bridge, so
 * the click is a UI no-op besides the optimistic flip.
 */
import { useState } from "react";
import { useNotchStore } from "../store";

const HOST = ((window as any).__notchHost ?? window.location.origin).replace(/\/+$/, "");

function postToNative(type: string, extra?: Record<string, unknown>): boolean {
  const handler = (window as any).webkit?.messageHandlers?.jarvis;
  if (!handler) return false;
  try {
    handler.postMessage(extra ? { type, ...extra } : { type });
    return true;
  } catch (err) {
    console.warn("[input] postToNative failed", err);
    return false;
  }
}

async function send(text: string) {
  if (!text.trim()) return;
  try {
    await fetch(`${HOST}/api/notch/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.warn("[input] send failed", err);
  }
}

export function InputRow() {
  const [value, setValue] = useState("");
  const inCall = useNotchStore((s) => s.inCall);
  const setInCall = useNotchStore((s) => s.setInCall);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = value.trim();
    if (!t) return;
    setValue("");
    void send(t);
  };
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSubmit(e as unknown as React.FormEvent);
    }
  };
  const onMicClick = () => {
    const next = !inCall;
    // Optimistic flip — Swift's __notchSetMicState callback corrects us
    // if the recorder refuses to arm.
    setInCall(next);
    const sent = postToNative(next ? "voiceStart" : "voiceStop");
    if (!sent) {
      // Browser context: no Swift bridge. Keep the optimistic flip so the
      // affordance gives feedback during dev/dashboard testing.
      console.info("[input] mic toggle (no native bridge)", next);
    }
  };
  return (
    <form className="input-row" onSubmit={onSubmit}>
      <button
        type="button"
        className={`mic${inCall ? " recording" : ""}`}
        id="notch-mic"
        aria-label={inCall ? "Termina chiamata" : "Avvia chiamata"}
        aria-pressed={inCall}
        onClick={onMicClick}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.33 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
        </svg>
      </button>
      <input
        type="text"
        className="input"
        id="notch-input"
        placeholder="Chiedi a Jarvis…"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          // Tell Swift the input has text. Swift uses this to set the
          // "sticky" flag so a mouse-out doesn't auto-collapse the panel
          // and lose what the user just typed. Without this, leaning the
          // mouse 40px above the compact zone wipes the in-progress message.
          postToNative("inputChange", { hasText: v.length > 0 });
        }}
        onKeyDown={onKey}
      />
      <button
        type="submit"
        className="send"
        id="notch-send"
        disabled={!value.trim()}
        aria-label="Invia"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 2L11 13" />
          <path d="M22 2L15 22L11 13L2 9L22 2Z" />
        </svg>
      </button>
    </form>
  );
}
