import { logger } from "../services/logger";

const log = logger.child({ module: "notch-events" });

/**
 * Wire protocol between the router and the Jarvis Notch surfaces
 * (DynamicNotch WKWebView, dashboard iframe). Four event types cover
 * the entire state machine the orb cares about.
 */
export type NotchEvent =
  // `recording` aggiunto per il barge-in: quando il VAD detecta voce mentre
  // il TTS sta parlando, il connector emit state→`recording` (non `idle`),
  // perché l'utente sta GIÀ parlando. La 6-state machine completa
  // (recording/transcribing/waiting/speaking) è stretch, per ora aggiungiamo
  // solo recording che serve al barge-in.
  | { type: "state.change"; data: { state: "idle" | "thinking" | "responding" | "listening" | "recording"; agent?: string } }
  | { type: "tool.running"; data: { tool: string; args?: Record<string, unknown> } }
  | { type: "message.in"; data: { text: string; from?: string; agent?: string; model?: string } }
  | { type: "message.out"; data: { text: string; from?: string } }
  | { type: "agent-meta"; data: { text: string } }
  | { type: "voice.transcribed"; data: { text: string } }
  | { type: "voice.partial"; data: { text: string } }
  | { type: "audio.play"; data: { url: string; mime: string } }
  // `audio.stop` chiamato da connector.barge() per dire al WebView di stoppare
  // l'<audio> element subito (in pair con AVSpeech.stop() lato Swift).
  | { type: "audio.stop"; data: Record<string, never> }
  | { type: "message.chunk"; data: { text: string; from?: string } }
  | { type: "tts.speak"; data: { text: string; voice?: string } }
  | { type: "tts.stop"; data: Record<string, never> };

export type NotchSubscriber = (event: NotchEvent) => void;

const subscribers = new Set<NotchSubscriber>();

/** Add a subscriber. Returns an unsubscribe function. */
export function subscribe(fn: NotchSubscriber): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

/** Broadcast a notch event to every live subscriber. Cheap when nothing's listening. */
export function emitNotch(event: NotchEvent): void {
  if (subscribers.size === 0) return;
  for (const fn of subscribers) {
    try { fn(event); } catch (err) {
      log.warn({ err, type: event.type }, "Notch subscriber threw");
    }
  }
}

/** Current listener count — exposed for health/telemetry. */
export function listenerCount(): number {
  return subscribers.size;
}
