/**
 * Bottom toolbar: voice toggle, mute, hover-record, model picker.
 * Each toggle persists immediately via PATCH /api/notch/prefs so the same
 * setting is visible in the dashboard mirror and survives notch reloads.
 */
import { useEffect } from "react";
import { useNotchStore } from "../store";

const HOST = ((window as any).__notchHost ?? window.location.origin).replace(/\/+$/, "");

async function loadPrefs() {
  try {
    const resp = await fetch(`${HOST}/api/notch/prefs`);
    if (!resp.ok) return;
    const prefs = await resp.json();
    useNotchStore.getState().setPrefs(prefs);
  } catch (_) { /* ignore */ }
}

async function patchPrefs(patch: Record<string, unknown>) {
  try {
    await fetch(`${HOST}/api/notch/prefs`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
  } catch (_) { /* ignore */ }
}

export function Toolbar() {
  const prefs = useNotchStore((s) => s.prefs);
  const setPrefs = useNotchStore((s) => s.setPrefs);

  useEffect(() => { loadPrefs(); }, []);

  const toggle = (key: keyof typeof prefs) => {
    const next = !prefs[key];
    setPrefs({ [key]: next });
    void patchPrefs({ [key]: next });
  };

  return (
    <div className="toolbar">
      <label className="toggle" title="Risposte parlate con TTS Cartesia">
        <input type="checkbox" checked={!!prefs.tts} onChange={() => toggle("tts")} />
        <span>Voce</span>
      </label>
      <label className="toggle" title="Apri il microfono al passaggio del mouse">
        <input type="checkbox" checked={!!prefs.hoverRecord} onChange={() => toggle("hoverRecord")} />
        <span>Call on hover</span>
      </label>
      <label className="toggle" title="Disattiva audio in uscita">
        <input type="checkbox" checked={!!prefs.mute} onChange={() => toggle("mute")} />
        <span>Muto</span>
      </label>
      <span className="model-tag">{prefs.model ?? "auto"}</span>
    </div>
  );
}
