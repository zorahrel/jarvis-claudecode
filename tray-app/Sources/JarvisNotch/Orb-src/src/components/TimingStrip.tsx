/**
 * Timing strip — four sequential/parallel phases, each with own live+frozen
 * chip. Visual layout:
 *
 *   [attesa-llm] [testo] [attesa-audio] [audio]   tok ↗  model
 *
 * Anchors / freeze events:
 *
 *   ATTESA LLM    user-input → first text chunk      arancio
 *   TESTO         first chunk → message.in           ciano
 *   ATTESA AUDIO  user-input → audio.play            giallo
 *   AUDIO         audio.play → <audio> ended         verde
 *
 * Chips are independent: attesa-llm and attesa-audio both anchor on
 * user-input but freeze at different events, so during the streaming
 * window you can see e.g. "attesa llm 0.3s frozen" + "testo 1.4s ticking"
 * + "attesa audio 0.9s ticking" + ... whatever's live.
 */
import { useEffect, useState } from "react";
import type { Bubble } from "../types";
import { useNotchStore } from "../store";

const HOST = ((window as any).__notchHost ?? window.location.origin).replace(/\/+$/, "");

function fmtSec(s: number): string {
  return s.toFixed(1) + "s";
}

async function stopAudio() {
  try { (window as any).jarvisAudio?.stop?.(); } catch {}
  try {
    await fetch(`${HOST}/api/notch/barge`, { method: "POST" });
  } catch (err) {
    console.warn("[stop] barge POST failed", err);
  }
}

interface Props {
  bubble: Bubble;
  isLatestAssistant: boolean;
}

export function TimingStrip({ bubble, isLatestAssistant }: Props) {
  const f = bubble.footer;
  const lastUserInputAt = useNotchStore((s) => s.lastUserInputAt);
  const lastAudioStart = useNotchStore((s) => s.lastAudioStart);
  const lastAssistantBubbleId = useNotchStore((s) => s.lastAssistantBubbleId);
  const textStreamStartAt = useNotchStore((s) => s.textStreamStartAt);
  const isCurrentAudioBubble = lastAssistantBubbleId === bubble.id && lastAudioStart > 0;

  const [llmWaitElapsed, setLlmWaitElapsed] = useState(0);
  const [textElapsed, setTextElapsed] = useState(0);
  const [audioWaitElapsed, setAudioWaitElapsed] = useState(0);
  const [audioElapsed, setAudioElapsed] = useState(0);

  // Visibility rules — each chip independent.
  const showLiveLlmWait =
    isLatestAssistant && lastUserInputAt > 0 && bubble.waitMs == null;
  const showLiveText =
    isLatestAssistant && textStreamStartAt > 0 && bubble.textStreamMs == null;
  const showLiveAudioWait =
    isLatestAssistant && lastUserInputAt > 0 && bubble.audioWaitMs == null
    // No point showing audio-wait if we already know there'll be no audio.
    // Heuristic: hide once message.in has been finalized (footer present)
    // AND no audio.play has arrived in some grace window. Simpler check:
    // hide when the bubble is no longer pending and audio hasn't started.
    && (bubble.pending !== false || isCurrentAudioBubble);
  const showLiveAudio =
    isCurrentAudioBubble && bubble.audioMs == null;

  useEffect(() => {
    if (!showLiveLlmWait) return;
    const tick = () => setLlmWaitElapsed((Date.now() - lastUserInputAt) / 1000);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [showLiveLlmWait, lastUserInputAt]);

  useEffect(() => {
    if (!showLiveText) return;
    const tick = () => setTextElapsed((Date.now() - textStreamStartAt) / 1000);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [showLiveText, textStreamStartAt]);

  useEffect(() => {
    if (!showLiveAudioWait) return;
    const tick = () => setAudioWaitElapsed((Date.now() - lastUserInputAt) / 1000);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [showLiveAudioWait, lastUserInputAt]);

  useEffect(() => {
    if (!showLiveAudio) return;
    const tick = () => setAudioElapsed((Date.now() - lastAudioStart) / 1000);
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [showLiveAudio, lastAudioStart]);

  const hasAnything =
    f != null ||
    bubble.waitMs != null ||
    bubble.textStreamMs != null ||
    bubble.audioWaitMs != null ||
    bubble.audioMs != null ||
    showLiveLlmWait ||
    showLiveText ||
    showLiveAudioWait ||
    showLiveAudio;
  if (!hasAnything) return null;

  return (
    <div className="timing-strip assistant">
      {/* LLM phases (orange family) */}
      {showLiveLlmWait && (
        <span className="live-timer wait" title="attesa LLM (TTFT)">
          attesa llm {fmtSec(llmWaitElapsed)}
        </span>
      )}
      {bubble.waitMs != null && (
        <span className="live-timer wait frozen" title="attesa LLM (TTFT)">
          attesa llm {fmtSec(bubble.waitMs / 1000)}
        </span>
      )}
      {showLiveText && (
        <span className="live-timer text" title="stream LLM">
          testo {fmtSec(textElapsed)}
        </span>
      )}
      {bubble.textStreamMs != null && (
        <span className="live-timer text frozen" title="stream LLM">
          testo {fmtSec(bubble.textStreamMs / 1000)}
        </span>
      )}

      {/* Audio phases (green family) */}
      {showLiveAudioWait && (
        <span className="live-timer audio-wait" title="attesa audio (synth+net)">
          attesa audio {fmtSec(audioWaitElapsed)}
        </span>
      )}
      {bubble.audioWaitMs != null && (
        <span className="live-timer audio-wait frozen" title="attesa audio (synth+net)">
          attesa audio {fmtSec(bubble.audioWaitMs / 1000)}
        </span>
      )}
      {showLiveAudio && (
        <span className="live-timer audio with-stop" title="audio playback">
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
      {bubble.audioMs != null && (
        <span className="live-timer audio frozen" title="audio playback">
          audio {fmtSec(bubble.audioMs / 1000)}
        </span>
      )}

      {/* Footer details (post-finalize). */}
      {f && (
        <>
          <span className="seg">
            <span className="seg-label">tok</span>
            <span className="seg-val">{f.tokenIn}→{f.tokenOut}</span>
          </span>
          <span className="seg">
            <span className="seg-val seg-model">{f.model}</span>
          </span>
        </>
      )}
    </div>
  );
}
