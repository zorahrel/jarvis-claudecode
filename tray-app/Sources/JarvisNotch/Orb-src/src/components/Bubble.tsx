/**
 * Single chat bubble. Renders user OR assistant variant. Assistant variant
 * shows the timing strip below (trascr/llm/tok/audio/wait) once finalized.
 *
 * Pending state: while the assistant turn is in flight, we show a typing-
 * dot placeholder. Chunks (if any) replace the dots with growing text.
 */
import type { Bubble as BubbleData } from "../types";
import { TimingStrip } from "./TimingStrip";

export function Bubble({ bubble }: { bubble: BubbleData }) {
  const isAssistant = bubble.role === "assistant";
  return (
    <div className={`bubble-row ${bubble.role}`}>
      <div
        className={`bubble ${bubble.role} ${bubble.pending ? "pending" : ""}`}
        data-bubble-id={bubble.id}
      >
        {bubble.pending && !bubble.text ? (
          <span className="typing">
            <span /><span /><span />
          </span>
        ) : (
          bubble.text
        )}
      </div>
      {isAssistant && bubble.footer && !bubble.pending && (
        <TimingStrip bubble={bubble} />
      )}
    </div>
  );
}
