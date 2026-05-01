import type { Channel } from "./config";

export interface MediaAttachment {
  type: "voice" | "audio" | "image" | "video" | "document";
  mimeType?: string;
  fileName?: string;
  caption?: string;
  /** Local file path after download */
  localPath?: string;
  /** Transcription (for voice/audio) or description (for image) or extracted text (for document) */
  processedText?: string;
}

export interface QuotedMessage {
  text?: string;
  from?: string;
  media?: MediaAttachment[];
  /** Unix epoch seconds of the quoted message (populated where easily available per-connector) */
  timestampEpoch?: number;
}

/** Per-message pipeline timings (all Unix ms) */
export interface MessageTimings {
  /** When connector received the message */
  received: number;
  /** When media download/transcription started */
  mediaStart?: number;
  /** When media processing finished */
  mediaEnd?: number;
  /** When Claude call started */
  llmStart?: number;
  /** When Claude responded */
  llmEnd?: number;
  /** When reply send started */
  sendStart?: number;
  /** When reply was fully sent */
  sendEnd?: number;
}

/** Incoming message from any channel */
export interface IncomingMessage {
  channel: Channel;
  /** Sender identifier (JID, chat ID, user ID) */
  from: string;
  /** Group/guild identifier if applicable */
  group?: string;
  /** Platform-specific identifier for async replies (telegram chat_id, whatsapp jid, discord channel.id).
   *  Used when we need to send a follow-up after the original context is gone (e.g. recovery notices after a crash). */
  replyTarget?: string;
  /** The message text */
  text: string;
  /** Original message timestamp */
  timestamp: number;
  /** Platform-specific message ID for deduplication */
  messageId?: string;
  /** Reply function to send response back */
  reply: (text: string) => Promise<void>;
  /**
   * Optional per-turn assistant DELTA callback. Fires for every text chunk
   * as it arrives from the LLM, before the full reply is ready. Used by the
   * notch streaming-TTS path to feed Cartesia WS incrementally
   * (`JARVIS_TTS_LLM_STREAM=1`). Errors thrown are caught upstream — never
   * break turn handling.
   */
  onChunk?: (delta: string) => void;
  /** Send a file to the chat */
  sendFile?: (filePath: string, caption?: string) => Promise<void>;
  /** Start typing indicator, returns a stop function */
  startTyping?: () => () => void;
  /** React to the original message with an emoji */
  react?: (emoji: string) => Promise<void>;
  /** Raw WhatsApp JID (for direct JID matching in routes) */
  rawJid?: string;
  /** Media attachments */
  media?: MediaAttachment[];
  /** Quoted/reply message context */
  quotedMessage?: QuotedMessage;
  /** Raw platform-specific data */
  raw?: unknown;
  /** Pipeline timings (mutable — populated through processing) */
  timings?: MessageTimings;
  /** When set, bypasses route.agent and uses this agent config instead. Used for owner-only @jarvis invocations. */
  agentOverride?: import("./config").AgentConfig;
  /** When set, replaces the agent's `model` for this single call. Used by the
   *  notch toolbar's model selector so the user can A/B test latency/quality
   *  without restarting the router or editing agent.yaml. */
  modelOverride?: string;
}
