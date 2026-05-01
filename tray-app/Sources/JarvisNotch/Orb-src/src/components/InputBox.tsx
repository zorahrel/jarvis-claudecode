/**
 * Text input box. Sends to /api/notch/send on Enter. The user-bubble echo
 * arrives via SSE message.out — no need to push it locally before send.
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

export function InputBox() {
  const [value, setValue] = useState("");
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = value.trim();
    if (!t) return;
    setValue("");
    void send(t);
  };
  return (
    <form className="input-row" onSubmit={onSubmit}>
      <input
        type="text"
        autoFocus
        spellCheck={false}
        autoComplete="off"
        placeholder="Chiedi a Jarvis…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" aria-label="invia">↗</button>
    </form>
  );
}
