/**
 * Single SSE subscription. The legacy notch.html had three EventSource
 * connections (one per IIFE) — wasted bandwidth + state-desync bugs.
 * Now: one connection, dispatch by event.type into the Zustand store.
 *
 * Audio playback dispatch: this hook signals the store but DOESN'T play
 * the audio itself — `<AudioPlayer>` (a sibling component) reacts to the
 * `audioPlayUrl` field in the store and owns the <audio> element.
 *
 * Reconnect: if the EventSource errors (network drop), close + retry
 * after a short delay. Backoff is unnecessary because router on localhost
 * is either up or about to be — failure is short-lived.
 */
import { useEffect, useRef, useState } from "react";
import type { NotchEvent } from "../types";
import { useNotchStore } from "../store";
import { parseFooter } from "../footer";

interface UseSSEOptions {
  /** Override base URL. Default: window.__notchHost or window.location.origin. */
  host?: string;
  /** When true (dashboard iframe), don't auto-play TTS — still dispatch state. */
  isDashboardMirror?: boolean;
}

export interface SSEController {
  audioPlayUrl: string | null;
  /** Clear the URL after the player consumes it (so re-emit still triggers). */
  consumeAudioUrl: () => void;
  /** True when audio.stop event was dispatched (barge-in). */
  audioStopRequested: boolean;
  consumeAudioStop: () => void;
}

export function useSSE(opts: UseSSEOptions = {}): SSEController {
  const [audioPlayUrl, setAudioPlayUrl] = useState<string | null>(null);
  const [audioStopRequested, setAudioStopRequested] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const host = (opts.host ?? (window as any).__notchHost ?? window.location.origin)
      .replace(/\/+$/, "");

    let es: EventSource | null = null;
    let stopped = false;

    const open = () => {
      if (stopped) return;
      try {
        es = new EventSource(`${host}/api/notch/stream`);
      } catch (err) {
        console.warn("[sse] EventSource construction failed", err);
        scheduleReconnect();
        return;
      }
      es.onmessage = (ev) => {
        let event: NotchEvent;
        try { event = JSON.parse(ev.data); } catch { return; }
        if (!event || !event.type) return;
        dispatchEvent(event, opts);
        if (event.type === "audio.play" && !opts.isDashboardMirror) {
          setAudioPlayUrl((event.data as { url: string }).url);
        }
        if (event.type === "audio.stop") {
          setAudioStopRequested(true);
        }
      };
      es.onerror = () => {
        try { es?.close(); } catch {}
        es = null;
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (stopped) return;
      if (reconnectTimer.current) return;
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null;
        open();
      }, 1500);
    };

    open();

    return () => {
      stopped = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      try { es?.close(); } catch {}
    };
  // host/isDashboardMirror change should re-create — practically they don't.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.host, opts.isDashboardMirror]);

  return {
    audioPlayUrl,
    consumeAudioUrl: () => setAudioPlayUrl(null),
    audioStopRequested,
    consumeAudioStop: () => setAudioStopRequested(false),
  };
}

function dispatchEvent(event: NotchEvent, _opts: UseSSEOptions): void {
  const store = useNotchStore.getState();
  switch (event.type) {
    case "state.change": {
      store.setState(event.data.state);
      // Spawn pending bubble on `thinking` so chunks can target it.
      if (event.data.state === "thinking" || event.data.state === "responding") {
        store.ensurePendingAssistant();
      }
      break;
    }
    case "message.out": {
      const text = event.data.text;
      // Always append the user echo bubble. The legacy bundle skipped this
      // when `from === 'notch'` because it pre-pushed the bubble in
      // triggerSend. The React port doesn't pre-push (single source of
      // truth = SSE dispatch), so we always append.
      if (text) store.appendUserBubble(text);
      // Anchor the WAIT timer regardless of source.
      store.noteUserInput();
      break;
    }
    case "message.in": {
      const raw = event.data.text;
      const { clean, footer } = parseFooter(raw);
      store.finalizeAssistant(clean, footer);
      break;
    }
    case "message.chunk": {
      // Disabled in connectors/notch.ts as of 2026-05-01 — kept here so the
      // wire format is forward-compatible if we re-enable streaming text.
      store.appendChunk(event.data.text);
      break;
    }
    case "voice.transcribed":
    case "voice.partial": {
      store.setLivePartial(event.data.text);
      break;
    }
    case "audio.play":
      // handled in main hook (sets audioPlayUrl). Also freeze WAIT here.
      useNotchStore.getState().freezeWaitTimer(Date.now());
      break;
    case "audio.stop":
    case "tts.stop":
      // Handled in main hook for stop; nothing else to dispatch.
      break;
    case "tool.running":
    case "agent-meta":
    case "tts.speak":
      // Not currently rendered in the React tree. Drop silently.
      break;
  }
}
