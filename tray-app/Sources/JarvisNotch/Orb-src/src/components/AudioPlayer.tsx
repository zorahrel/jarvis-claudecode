/**
 * Hidden <audio> element that plays TTS streams from /api/notch/tts-stream.
 * Owns the lifecycle (play/end/error) and posts back to Swift via the
 * `audioLifecycle` bridge so the recorder/STT side knows the assistant
 * is talking (echo guard).
 *
 * One `<audio>` reused across turns. `key` reset trick is unnecessary:
 * just set src to a new URL and call .play(). Each new URL invalidates
 * the prior load.
 */
import { useEffect, useRef } from "react";
import { useNotchStore } from "../store";

interface AudioPlayerProps {
  url: string | null;
  onConsumed: () => void;
  stopRequested: boolean;
  onStopConsumed: () => void;
}

function postAudioLifecycle(phase: "start" | "end") {
  const bridge = (window as any).webkit?.messageHandlers?.jarvis;
  if (!bridge) return;
  try { bridge.postMessage({ type: "audioLifecycle", phase }); } catch {}
}

export function AudioPlayer({ url, onConsumed, stopRequested, onStopConsumed }: AudioPlayerProps) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const startTsRef = useRef<number>(0);
  const startedRef = useRef(false);
  const noteAudioEnd = useNotchStore((s) => s.noteAudioEnd);

  // React on URL change → load + play.
  useEffect(() => {
    if (!url) return;
    const el = ref.current;
    if (!el) return;
    try { el.pause(); } catch {}
    el.src = url + (url.includes("?") ? "&" : "?") + "t=" + Date.now();
    startedRef.current = false;
    const playPromise = el.play();
    if (playPromise && typeof (playPromise as any).catch === "function") {
      (playPromise as Promise<void>).catch((err) => {
        console.warn("[audio] play() rejected (autoplay policy?)", err);
      });
    }
    onConsumed();
  // We intentionally only react to url changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // React on stop request (barge-in).
  useEffect(() => {
    if (!stopRequested) return;
    const el = ref.current;
    if (el) {
      try { el.pause(); } catch {}
      el.removeAttribute("src");
    }
    onStopConsumed();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopRequested]);

  // Lifecycle event wiring.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onPlay = () => {
      if (startedRef.current) return;
      startedRef.current = true;
      startTsRef.current = Date.now();
      postAudioLifecycle("start");
    };
    const onEnded = () => {
      if (!startedRef.current) return;
      startedRef.current = false;
      noteAudioEnd();
      postAudioLifecycle("end");
    };
    const onErrorOrPause = () => {
      if (!startedRef.current) return;
      startedRef.current = false;
      noteAudioEnd();
      postAudioLifecycle("end");
    };

    el.addEventListener("play", onPlay);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onErrorOrPause);
    el.addEventListener("pause", onErrorOrPause);
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onErrorOrPause);
      el.removeEventListener("pause", onErrorOrPause);
    };
  }, [noteAudioEnd]);

  return <audio ref={ref} preload="auto" style={{ display: "none" }} />;
}
