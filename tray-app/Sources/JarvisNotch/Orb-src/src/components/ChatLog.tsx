/**
 * Scrollable chat log. Only renders the last 200 bubbles to keep the DOM
 * tree small (the notch is meant for short interactions; full history is
 * available via the dashboard tab).
 *
 * Auto-scroll: whenever a new bubble lands, scroll the container to bottom.
 * If the user has scrolled up manually, respect their position (sticky-
 * scroll only if already at bottom).
 */
import { useEffect, useRef } from "react";
import { useNotchStore } from "../store";
import { Bubble } from "./Bubble";
import { LivePartial } from "./LivePartial";

const TAIL = 200;

export function ChatLog() {
  const bubbles = useNotchStore((s) => s.bubbles);
  const livePartial = useNotchStore((s) => s.livePartial);
  const ref = useRef<HTMLDivElement | null>(null);
  const stickyRef = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stickyRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [bubbles.length, livePartial]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickyRef.current = distFromBottom < 40;
  };

  const tail = bubbles.length > TAIL ? bubbles.slice(-TAIL) : bubbles;

  return (
    <div className="chat-log" id="notch-log" ref={ref} onScroll={onScroll}>
      {tail.map((b) => (
        <Bubble key={b.id} bubble={b} />
      ))}
      {livePartial && <LivePartial text={livePartial} />}
    </div>
  );
}
