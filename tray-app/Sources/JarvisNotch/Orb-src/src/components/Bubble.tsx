/**
 * Bubble — same classes as legacy: `.bubble.user` / `.bubble.assistant`.
 * Pending state uses 3 typing dots (legacy class `.typing-dot` + animation).
 *
 * The timing strip is rendered as a SIBLING below the assistant bubble
 * (not nested) so the flex layout matches legacy. We render it for the
 * latest assistant bubble even before the footer arrives — TimingStrip
 * itself is responsible for emitting only the chips that are applicable
 * (live wait timer during streaming, frozen wait/audio after that, full
 * footer once parsed).
 */
import type { Bubble as BubbleData } from "../types";
import { TimingStrip } from "./TimingStrip";

interface BubbleProps {
  bubble: BubbleData;
  isLatestAssistant: boolean;
}

export function Bubble({ bubble, isLatestAssistant }: BubbleProps) {
  if (bubble.pending && !bubble.text) {
    return (
      <>
        <div className="bubble pending" data-bubble-id={bubble.id}>
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
        </div>
        {isLatestAssistant && (
          <TimingStrip bubble={bubble} isLatestAssistant={isLatestAssistant} />
        )}
      </>
    );
  }
  return (
    <>
      <div className={`bubble ${bubble.role}`} data-bubble-id={bubble.id}>
        {bubble.text}
      </div>
      {bubble.role === "assistant" && (
        <TimingStrip bubble={bubble} isLatestAssistant={isLatestAssistant} />
      )}
    </>
  );
}
