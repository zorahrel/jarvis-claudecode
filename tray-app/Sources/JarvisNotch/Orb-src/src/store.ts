/**
 * Single source of truth for the notch UI. Zustand store with all state
 * the React tree consumes. SSE events, Swift bridge calls, and user actions
 * all funnel through these mutators — never set DOM/state from elsewhere.
 *
 * The `pending` bubble is the in-flight assistant reply. It's created on
 * `state.change → thinking` and finalized on `message.in`. Replacing the
 * whole bubble (instead of appending a second one) is React's reconciliation
 * job — the old monolithic notch.html had to do it imperatively and it got
 * confused, producing duplicate bubbles in some race conditions.
 */
import { create } from "zustand";
import type { AgentFooter, AgentState, Bubble, NotchPrefs } from "./types";

interface NotchStore {
  state: AgentState;
  bubbles: Bubble[];
  /** id of the in-flight assistant bubble, if any. */
  pendingId: string | null;
  /** Live partial transcript for the currently-recording user (Apple STT). */
  livePartial: string;
  /** Mic level 0..1 fed by Swift via window.__notchPartialLevel. */
  micLevel: number;
  /** Toolbar prefs synced from /api/notch/prefs. */
  prefs: NotchPrefs;
  /** Anchor: when the user input arrived at the server. Used by WAIT chip. */
  lastUserInputAt: number;
  /** Timestamp of last audio.play (for live AUDIO chip). 0 when idle. */
  lastAudioStart: number;
  /** Bubble id whose audio is currently playing. Used to bind the live
   *  AUDIO chip to the correct bubble. */
  lastAssistantBubbleId: string | null;

  // ── mutators ────────────────────────────────────────────────────────
  setState: (s: AgentState) => void;
  appendUserBubble: (text: string, ts?: number) => void;
  /**
   * Ensure a pending assistant bubble exists. Creates it if not, returns
   * its id either way. Idempotent — multiple state.change → thinking
   * events from race conditions don't duplicate the bubble.
   */
  ensurePendingAssistant: () => string;
  /** Append a delta to the pending assistant bubble (LLM streaming chunks). */
  appendChunk: (text: string) => void;
  /** Finalize the pending assistant bubble with the canonical text + footer. */
  finalizeAssistant: (text: string, footer?: AgentFooter | null) => void;
  /** Drop the pending bubble (used on aborted turns with no chunks). */
  dropPending: () => void;
  /** Replace bubbles with a freshly loaded history (rehydration on connect). */
  hydrateHistory: (items: Array<{ role: "user" | "agent"; text: string; ts: number }>) => void;
  clearLog: () => void;

  setLivePartial: (text: string) => void;
  setMicLevel: (level: number) => void;

  setPrefs: (prefs: Partial<NotchPrefs>) => void;
  noteUserInput: (ts?: number) => void;
  /** Called when audio.play SSE event arrives — mark the wait chip + start
   *  the live AUDIO chip ticking against the matching bubble. */
  noteAudioStart: () => void;
  /** Called when <audio> ends — freeze the AUDIO chip with final duration. */
  noteAudioEnd: () => void;
  freezeWaitTimer: (audioStartTs: number) => void;
  freezeAudioTimer: (audioEndTs: number, audioStartTs: number) => void;
}

let bubbleCounter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${++bubbleCounter}`;

export const useNotchStore = create<NotchStore>()((set, get) => ({
  state: "idle",
  bubbles: [],
  pendingId: null,
  livePartial: "",
  micLevel: 0,
  prefs: { tts: true, mute: false, hoverRecord: false, model: null },
  lastUserInputAt: 0,
  lastAudioStart: 0,
  lastAssistantBubbleId: null,

  setState: (s) => set({ state: s }),

  appendUserBubble: (text, ts) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = nextId("u");
    set((st) => ({
      bubbles: [...st.bubbles, { id, role: "user", text: trimmed, ts: ts ?? Date.now() }],
    }));
  },

  ensurePendingAssistant: () => {
    const cur = get();
    if (cur.pendingId) {
      // Sanity-check it's actually still in the list (could've been removed
      // by clearLog mid-turn).
      const exists = cur.bubbles.some((b) => b.id === cur.pendingId);
      if (exists) return cur.pendingId;
    }
    const id = nextId("a");
    set((st) => ({
      pendingId: id,
      bubbles: [...st.bubbles, { id, role: "assistant", text: "", ts: Date.now(), pending: true }],
    }));
    return id;
  },

  appendChunk: (text) => {
    if (!text) return;
    const cur = get();
    const id = cur.pendingId ?? cur.ensurePendingAssistant();
    set((st) => ({
      bubbles: st.bubbles.map((b) => (b.id === id ? { ...b, text: b.text + text } : b)),
    }));
  },

  finalizeAssistant: (text, footer) => {
    const id = get().pendingId;
    set((st) => {
      // If the agent emitted nothing speakable AND we have no chunks,
      // we drop the placeholder. Otherwise replace text + freeze pending.
      const target = id ? st.bubbles.find((b) => b.id === id) : null;
      if (!target) {
        // No pending — the bundle/router skipped state.change for some
        // reason. Append a fresh assistant bubble with the final text.
        if (!text.trim()) return st;
        return {
          bubbles: [
            ...st.bubbles,
            {
              id: nextId("a"),
              role: "assistant",
              text,
              ts: Date.now(),
              footer: footer ?? undefined,
            },
          ],
          pendingId: null,
        };
      }
      return {
        bubbles: st.bubbles.map((b) =>
          b.id === id ? { ...b, text, pending: false, footer: footer ?? b.footer } : b,
        ),
        pendingId: null,
      };
    });
  },

  dropPending: () => {
    const id = get().pendingId;
    if (!id) return;
    set((st) => ({
      bubbles: st.bubbles.filter((b) => b.id !== id),
      pendingId: null,
    }));
  },

  hydrateHistory: (items) => {
    const bubbles = items.map((it, i) => ({
      id: `h-${it.ts}-${i}`,
      role: it.role === "agent" ? ("assistant" as const) : ("user" as const),
      text: it.text,
      ts: it.ts,
    }));
    set({ bubbles, pendingId: null });
  },

  clearLog: () => set({ bubbles: [], pendingId: null }),

  setLivePartial: (text) => set({ livePartial: text }),
  setMicLevel: (level) => set({ micLevel: Math.max(0, Math.min(1, level)) }),

  setPrefs: (patch) => set((st) => ({ prefs: { ...st.prefs, ...patch } })),

  noteUserInput: (ts) => set({ lastUserInputAt: ts ?? Date.now() }),

  noteAudioStart: () => {
    const cur = get();
    // Bind to the most-recent assistant bubble (pending or finalized).
    const lastAsst = [...cur.bubbles].reverse().find((b) => b.role === "assistant");
    set({
      lastAudioStart: Date.now(),
      lastAssistantBubbleId: lastAsst?.id ?? null,
    });
    // Also freeze the WAIT chip on that bubble.
    cur.freezeWaitTimer(Date.now());
  },

  noteAudioEnd: () => {
    const cur = get();
    if (!cur.lastAudioStart) return;
    cur.freezeAudioTimer(Date.now(), cur.lastAudioStart);
    set({ lastAudioStart: 0, lastAssistantBubbleId: null });
  },

  freezeWaitTimer: (audioStartTs) => {
    const cur = get();
    if (!cur.lastUserInputAt) return;
    // Target: the pending assistant bubble if one exists, otherwise the
    // most recent assistant bubble (audio.play arrives after message.in
    // when LLM streaming is enabled, so pending is already finalized).
    const id = cur.pendingId
      ?? [...cur.bubbles].reverse().find((b) => b.role === "assistant")?.id;
    if (!id) return;
    const waitMs = audioStartTs - cur.lastUserInputAt;
    if (waitMs < 0 || waitMs > 60_000) return; // sanity guard
    set((st) => ({
      bubbles: st.bubbles.map((b) => (b.id === id ? { ...b, waitMs } : b)),
    }));
  },

  freezeAudioTimer: (audioEndTs, audioStartTs) => {
    // Find the most recent assistant bubble that already has waitMs but
    // not audioMs — that's the one whose audio just finished.
    set((st) => {
      let frozen = false;
      const bubbles = [...st.bubbles].reverse().map((b) => {
        if (frozen || b.role !== "assistant") return b;
        if (b.audioMs != null) return b;
        if (b.waitMs == null) return b;
        frozen = true;
        return { ...b, audioMs: audioEndTs - audioStartTs };
      });
      return { bubbles: bubbles.reverse() };
    });
  },
}));
