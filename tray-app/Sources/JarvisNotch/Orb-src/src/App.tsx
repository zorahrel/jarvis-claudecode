/**
 * Root component. Composes the chat log, toolbar, input box, audio player,
 * and the orb visual. Hooks (useSSE, useSwiftBridge) wire up the side
 * effects exactly once.
 *
 * Dashboard mirror detection: when embedded via `?embed=dashboard`, audio
 * playback is suppressed (the main notch process owns the speakers).
 */
import { useEffect } from "react";
import { useSSE } from "./hooks/useSSE";
import { useSwiftBridge } from "./hooks/useSwiftBridge";
import { useNotchStore } from "./store";
import { ChatLog } from "./components/ChatLog";
import { Toolbar } from "./components/Toolbar";
import { InputBox } from "./components/InputBox";
import { AudioPlayer } from "./components/AudioPlayer";
import { Orb } from "./components/Orb";

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
  const { audioPlayUrl, consumeAudioUrl, audioStopRequested, consumeAudioStop } = useSSE({ isDashboardMirror });

  useEffect(() => { void loadHistory(); }, []);

  return (
    <div className={`notch-app ${isDashboardMirror ? "mirror" : "standalone"}`}>
      <Orb />
      <div className="content">
        <ChatLog />
        <Toolbar />
        <InputBox />
      </div>
      {!isDashboardMirror && (
        <AudioPlayer
          url={audioPlayUrl}
          onConsumed={consumeAudioUrl}
          stopRequested={audioStopRequested}
          onStopConsumed={consumeAudioStop}
        />
      )}
    </div>
  );
}
