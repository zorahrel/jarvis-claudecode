/**
 * Notch React shell. Replicates the legacy notch.html DOM structure
 * verbatim so all the original CSS works unchanged. The Three.js orb
 * bundle (notch-BpndmdBM.js, opaque dist) is loaded in index.html and
 * injects into #three-container — we just provide the empty container.
 *
 * State management (chat log, bubbles, timers, prefs, audio playback) is
 * the only thing React owns. Hot-corner cancel, peek panels, three.js
 * orb, audio-aura, VAD remain vanilla in their own files/bundles.
 */
import { useEffect } from "react";
import { useSSE } from "./hooks/useSSE";
import { useSwiftBridge } from "./hooks/useSwiftBridge";
import { useExternalAssets } from "./hooks/useExternalAssets";
import { useNotchStore } from "./store";
import { ChatLog } from "./components/ChatLog";
import { Toolbar } from "./components/Toolbar";
import { InputRow } from "./components/InputRow";
import { AudioPlayer } from "./components/AudioPlayer";
import { ActivityPane } from "./components/ActivityPane";

const HOST = ((window as any).__notchHost ?? window.location.origin).replace(/\/+$/, "");
const isDashboardMirror = /[?&]embed=dashboard\b/.test(window.location.search);

async function loadHistory() {
  try {
    const resp = await fetch(`${HOST}/api/notch/history?limit=50`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (Array.isArray(data?.items)) {
      useNotchStore.getState().hydrateHistory(data.items);
    }
  } catch (_) { /* ignore */ }
}

export function App() {
  useSwiftBridge();
  useExternalAssets();
  const { audioPlayUrl, consumeAudioUrl, audioStopRequested, consumeAudioStop } = useSSE({ isDashboardMirror });

  useEffect(() => { void loadHistory(); }, []);

  return (
    <>
      {/* Three.js orb stage. The notch-BpndmdBM.js bundle (loaded in
          index.html <head>) finds #three-container and injects its scene. */}
      <div className="stage">
        <div id="three-container"></div>
      </div>

      <div className="content">
        {/* Chat pane (default focus) */}
        <div className="chat-pane">
          <ChatLog />
          <Toolbar />
          <InputRow />
        </div>

        {/* Activity pane (toggled by hot-corner / right-icon) */}
        <ActivityPane />
      </div>

      {/* Hidden audio element for TTS playback. */}
      {!isDashboardMirror && (
        <AudioPlayer
          url={audioPlayUrl}
          onConsumed={consumeAudioUrl}
          stopRequested={audioStopRequested}
          onStopConsumed={consumeAudioStop}
        />
      )}
    </>
  );
}
