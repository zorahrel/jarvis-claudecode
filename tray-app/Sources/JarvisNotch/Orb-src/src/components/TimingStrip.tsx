/**
 * Timing strip below an assistant bubble — uses legacy classes
 * (.timing-strip, .seg-label, .seg-val, .seg-model, .live-timer).
 *
 * Order replicates the legacy notch.html footer parser output:
 *   trascr  llm  tok  model  [live audio]  [wait/audio frozen chips]
 *
 * The live AUDIO timer is rendered when `lastAudioStart` is set in the
 * store and the corresponding bubble matches lastAssistantBubbleRef.
 */
import { useEffect, useState } from "react";
import type { Bubble } from "../types";
import { useNotchStore } from "../store";

const HOST = ((window as any).__notchHost ?? window.location.origin).replace(/\/+$/, "");

function fmtSec(s: number): string {
  return s.toFixed(1) + "s";
}

/**
 * Stop the currently-playing TTS audio. Two parallel actions:
 *   1. Pause the local <audio> element directly via window.jarvisAudio.stop()
 *      (already wired by useSwiftBridge) — instant client-side cutoff.
 *   2. POST /api/notch/barge so the router cancels the in-flight Cartesia
 *      WS context and bumps the generation counter (stops further chunks
 *      from being processed even if SSE delivery is in flight).
 */
async function stopAudio() {
  // Local stop first — perceived latency 0ms.
  try { (window as any).jarvisAudio?.stop?.(); } catch {}
  // Server-side cancel for the streaming Cartesia context.
  try {
    await fetch(`${HOST}/api/notch/barge`, { method: "POST" });
  } catch (err) {
    console.warn("[stop] barge POST failed", err);
  }
}

export function TimingStrip({ bubble }: { bubble: Bubble }) {
  const f = bubble.footer;
  const lastAudioStart = useNotchStore((s) => s.lastAudioStart);
  const lastAssistantBubbleId = useNotchStore((s) => s.lastAssistantBubbleId);
  const isCurrentAudioBubble = lastAssistantBubbleId === bubble.id && lastAudioStart > 0;
  const [audioElapsed, setAudioElapsed] = useState(0);

  useEffect(() => {
    if (!isCurrentAudioBubble) return;
    const tick = () => setAudioElapsed((Date.now() - lastAudioStart) / 1000);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [isCurrentAudioBubble, lastAudioStart]);

  if (!f) return null;

  return (
    <div className="timing-strip assistant">
      <span className="seg">
        <span className="seg-label">llm</span>
        <span className="seg-val">{fmtSec(f.llm)}</span>
      </span>
      <span className="seg">
        <span className="seg-label">tok</span>
        <span className="seg-val">{f.tokenIn}→{f.tokenOut}</span>
      </span>
      <span className="seg">
        <span className="seg-val seg-model">{f.model}</span>
      </span>
      {bubble.waitMs != null && (
        <span className="live-timer wait frozen">attesa {fmtSec(bubble.waitMs / 1000)}</span>
      )}
      {bubble.audioMs != null && (
        <span className="live-timer audio frozen">audio {fmtSec(bubble.audioMs / 1000)}</span>
      )}
      {bubble.audioMs == null && isCurrentAudioBubble && (
        <span className="live-timer audio with-stop">
          audio {fmtSec(audioElapsed)}
          <button
            type="button"
            className="stop-audio"
            title="Interrompi audio (barge-in)"
            aria-label="Interrompi audio"
            onClick={stopAudio}
          >
            <svg width="9" height="9" viewBox="0 0 12 12" fill="currentColor">
              <rect x="2" y="2" width="8" height="8" rx="1" />
            </svg>
          </button>
        </span>
      )}
    </div>
  );
}
