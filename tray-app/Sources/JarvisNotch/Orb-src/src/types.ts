/**
 * Wire types between the router (router/src/notch/events.ts) and the notch
 * React client. Keep this in sync with the canonical TypeScript union there.
 *
 * Adding a new event type? Add it to BOTH files. The notch SSE consumer in
 * `useSSE.ts` switches on `type` — anything not handled falls through silently.
 */
export type AgentState =
  | "idle"
  | "thinking"
  | "responding"
  | "listening"
  | "recording";

export type NotchEvent =
  | { type: "state.change"; data: { state: AgentState; agent?: string } }
  | { type: "tool.running"; data: { tool: string; args?: Record<string, unknown> } }
  | { type: "message.in"; data: { text: string; from?: string; agent?: string; model?: string } }
  | { type: "message.out"; data: { text: string; from?: string } }
  | { type: "agent-meta"; data: { text: string } }
  | { type: "voice.transcribed"; data: { text: string } }
  | { type: "voice.partial"; data: { text: string } }
  | { type: "audio.play"; data: { url: string; mime: string } }
  | { type: "audio.stop"; data: Record<string, never> }
  | { type: "message.chunk"; data: { text: string; from?: string } }
  | { type: "tts.speak"; data: { text: string; voice?: string } }
  | { type: "tts.stop"; data: Record<string, never> };

/** Parsed agent footer extracted from a message.in text body. */
export interface AgentFooter {
  /** Total turn time, parsed from the leading `t Xs` segment of `[t ...]`. */
  total: number;
  /** LLM-only time, parsed from `llm Xs` if present. */
  llm: number;
  /** Token in/out from `tok IN>OUT`. */
  tokenIn: string;
  tokenOut: string;
  /** "agent/model" tail. */
  agent: string;
  model: string;
}

export interface Bubble {
  /** Stable id derived from the SSE event ordering. Used as React key. */
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  /** Server-side parsed timing footer (assistant bubbles only). */
  footer?: AgentFooter;
  /** True until the assistant text is finalized. */
  pending?: boolean;
  /** WAIT timing chip (frozen value, ms). Set when audio.play arrives. */
  waitMs?: number;
  /** AUDIO timing chip (frozen value, ms). Set when <audio> ends. */
  audioMs?: number;
}

export interface NotchPrefs {
  /** TTS auto-trigger toggle. */
  tts: boolean;
  /** Master mute. */
  mute: boolean;
  /** Hover-to-record arming. */
  hoverRecord: boolean;
  /** Optional model override (haiku/sonnet/opus). */
  model?: string | null;
}
