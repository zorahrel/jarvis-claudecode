/**
 * Timing chips below an assistant bubble. Three permanent (trascr/llm/tok)
 * + two computed live (wait/audio). The live ones are managed in the store
 * but rendered inline here when their value is set.
 */
import type { Bubble } from "../types";

function fmtSec(ms: number): string {
  return (ms / 1000).toFixed(1) + "s";
}

export function TimingStrip({ bubble }: { bubble: Bubble }) {
  const f = bubble.footer;
  if (!f) return null;
  return (
    <div className="timing-strip">
      <span className="seg">
        <span className="seg-label">llm</span>
        <span className="seg-val">{f.llm.toFixed(1)}s</span>
      </span>
      <span className="seg">
        <span className="seg-label">tok</span>
        <span className="seg-val">{f.tokenIn}→{f.tokenOut}</span>
      </span>
      <span className="seg">
        <span className="seg-val seg-model">{f.model}</span>
      </span>
      {bubble.waitMs != null && (
        <span className="chip wait">attesa {fmtSec(bubble.waitMs)}</span>
      )}
      {bubble.audioMs != null && (
        <span className="chip audio">audio {fmtSec(bubble.audioMs)}</span>
      )}
    </div>
  );
}
