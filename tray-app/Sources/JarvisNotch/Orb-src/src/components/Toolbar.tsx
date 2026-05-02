/**
 * Toolbar replicates the legacy DOM verbatim — same data-pref attributes
 * and class names as before, so legacy CSS rules (e.g. `.toggle input`)
 * apply directly. Functional behavior:
 *   - tts/hoverRecord/mute checkboxes PATCH /api/notch/prefs on toggle
 *   - model-cycle button rotates opus → sonnet → haiku
 */
import { useEffect } from "react";
import { useNotchStore } from "../store";

const HOST = ((window as any).__notchHost ?? window.location.origin).replace(/\/+$/, "");
const MODELS = ["opus", "sonnet", "haiku"];

async function loadPrefs() {
  try {
    const resp = await fetch(`${HOST}/api/notch/prefs`);
    if (!resp.ok) return;
    const prefs = await resp.json();
    useNotchStore.getState().setPrefs(prefs);
  } catch { /* ignore */ }
}

async function patchPrefs(patch: Record<string, unknown>) {
  try {
    await fetch(`${HOST}/api/notch/prefs`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
  } catch { /* ignore */ }
}

export function Toolbar() {
  const prefs = useNotchStore((s) => s.prefs);
  const setPrefs = useNotchStore((s) => s.setPrefs);

  useEffect(() => { void loadPrefs(); }, []);

  const togglePref = (key: keyof typeof prefs) => {
    const next = !prefs[key];
    setPrefs({ [key]: next });
    void patchPrefs({ [key]: next });
  };

  const cycleModel = () => {
    const cur = prefs.model ?? "opus";
    const idx = MODELS.indexOf(cur);
    const next = MODELS[(idx + 1) % MODELS.length];
    setPrefs({ model: next });
    void patchPrefs({ model: next });
  };

  return (
    <div className="toolbar" id="notch-toolbar">
      <label className="toggle" title="Risposte parlate con TTS on-device">
        <input type="checkbox" data-pref="tts" checked={!!prefs.tts} onChange={() => togglePref("tts")} />
        <span>Voce</span>
      </label>
      <label className="toggle" title="Modalità chiamata — apri il microfono al passaggio del mouse e parla con Jarvis">
        <input type="checkbox" data-pref="hoverRecord" checked={!!prefs.hoverRecord} onChange={() => togglePref("hoverRecord")} />
        <span>Call on hover</span>
      </label>
      <label className="toggle" title="Silenzia tutto l'audio del notch">
        <input type="checkbox" data-pref="mute" checked={!!prefs.mute} onChange={() => togglePref("mute")} />
        <span>Muto</span>
      </label>
      <button
        className="toggle model-cycle"
        id="notch-model-cycle"
        title="Modello LLM — clicca per ciclare opus / sonnet / haiku"
        onClick={cycleModel}
      >
        <span id="model-label">{prefs.model ?? "opus"}</span>
      </button>
    </div>
  );
}
