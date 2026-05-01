/**
 * Input row: mic button (currently a UI affordance only — recording is
 * driven by Swift's hover-record), text input, send button.
 *
 * Same DOM/classes as legacy notch.html so CSS rules apply unchanged
 * (.input-row, .mic, .input, .send, [disabled] state).
 */
import { useState } from "react";

const HOST = ((window as any).__notchHost ?? window.location.origin).replace(/\/+$/, "");

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
  return (
    <form className="input-row" onSubmit={onSubmit}>
      <button type="button" className="mic" id="notch-mic" aria-label="Voice call">
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
        onChange={(e) => setValue(e.target.value)}
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
