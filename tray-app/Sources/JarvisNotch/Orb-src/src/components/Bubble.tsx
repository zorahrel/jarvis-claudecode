/**
 * Bubble — same classes as legacy: `.bubble.user` / `.bubble.assistant`.
 * Pending state uses 3 typing dots (legacy class `.typing-dot` + animation).
 *
 * The timing strip is rendered as a SIBLING below the assistant bubble
 * (not nested) so the flex layout matches legacy.
 */
import type { Bubble as BubbleData } from "../types";
import { TimingStrip } from "./TimingStrip";

export function Bubble({ bubble }: { bubble: BubbleData }) {
  if (bubble.pending && !bubble.text) {
    return (
      <div className="bubble pending" data-bubble-id={bubble.id}>
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
    );
  }
  return (
    <>
      <div className={`bubble ${bubble.role}`} data-bubble-id={bubble.id}>
        {bubble.text}
      </div>
      {bubble.role === "assistant" && bubble.footer && !bubble.pending && (
        <TimingStrip bubble={bubble} />
      )}
    </>
  );
}
