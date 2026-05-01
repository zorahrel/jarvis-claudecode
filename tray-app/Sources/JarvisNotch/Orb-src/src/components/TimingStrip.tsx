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

function fmtSec(s: number): string {
  return s.toFixed(1) + "s";
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
        <span className="live-timer audio">audio {fmtSec(audioElapsed)}</span>
      )}
    </div>
  );
}
