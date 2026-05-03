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
import { parseFooter } from "./footer";
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
  /** Timestamp when the first text chunk landed in the current turn. Used
   *  as anchor for the live TESTO chip. 0 when idle / pre-first-chunk. */
  textStreamStartAt: number;
  /** True while the sticky continuous-call mode is active (mic open).
   *  Driven by the call-button click + Swift's __notchSetMicState pushback. */
  inCall: boolean;

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
  setInCall: (on: boolean) => void;

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
  textStreamStartAt: 0,
  inCall: false,

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
    // First chunk of the turn:
    //   - anchor TESTO live chip
    //   - freeze ATTESA LLM (waitMs) on the bubble = LLM TTFT
    if (cur.textStreamStartAt === 0 && cur.lastUserInputAt > 0) {
      const now = Date.now();
      const waitMs = now - cur.lastUserInputAt;
      const validWait = waitMs >= 0 && waitMs < 60_000;
      set((st) => ({
        textStreamStartAt: now,
        bubbles: st.bubbles.map((b) =>
          b.id === id && b.waitMs == null && validWait
            ? { ...b, waitMs }
            : b,
        ),
      }));
    }
    set((st) => ({
      bubbles: st.bubbles.map((b) => (b.id === id ? { ...b, text: b.text + text } : b)),
    }));
  },

  finalizeAssistant: (text, footer) => {
    const cur = get();
    const id = cur.pendingId;
    const target = id ? cur.bubbles.find((b) => b.id === id) : null;

    // Freeze "attesa" on finalize when nothing else froze it (TTS off +
    // no streaming chunks path). If freezeWaitTimer ran on first chunk or
    // audio.play, preserve that value.
    const computeWaitMs = (existing: number | undefined): number | undefined => {
      if (existing != null) return existing;
      if (cur.lastUserInputAt <= 0) return undefined;
      const d = Date.now() - cur.lastUserInputAt;
      if (d < 0 || d > 60_000) return undefined;
      return d;
    };
    // Freeze "testo" — duration of text streaming from first chunk to
    // finalize. If no chunks ever arrived (textStreamStartAt == 0), the
    // turn was zero-stream (atomic message.in) and we leave it undefined.
    const computeTextStreamMs = (existing: number | undefined): number | undefined => {
      if (existing != null) return existing;
      if (cur.textStreamStartAt <= 0) return undefined;
      const d = Date.now() - cur.textStreamStartAt;
      if (d < 0 || d > 120_000) return undefined;
      return d;
    };

    // Decide whether to do client-side word-by-word reveal.
    // We do it ONLY if all of:
    //   - we have a pending bubble that's still empty (no real-time chunks
    //     ever landed during the turn — typical of extended-thinking models)
    //   - the final text is long enough to benefit from a perceived
    //     "typing" cadence (>40 chars threshold)
    //   - we're not in dashboard mirror (lower-priority context)
    // If real chunks already landed (target.text non empty), we just freeze.
    const TYPING_THRESHOLD = 40;
    const hadStream = target && target.text.length > 0;
    const wantsClientStream = !!target && !hadStream && text.length > TYPING_THRESHOLD;

    if (!target) {
      // No pending — the SSE state.change skipped. Append a fresh bubble.
      if (!text.trim()) return;
      const waitMs = computeWaitMs(undefined);
      const textStreamMs = computeTextStreamMs(undefined);
      set((st) => ({
        bubbles: [
          ...st.bubbles,
          {
            id: nextId("a"),
            role: "assistant",
            text,
            ts: Date.now(),
            footer: footer ?? undefined,
            waitMs,
            textStreamMs,
          },
        ],
        pendingId: null,
        textStreamStartAt: 0,
      }));
      return;
    }

    if (!wantsClientStream) {
      // Atomic finalize — chunks already filled the bubble OR text is short.
      set((st) => ({
        bubbles: st.bubbles.map((b) =>
          b.id === id
            ? {
                ...b,
                text,
                pending: false,
                footer: footer ?? b.footer,
                waitMs: computeWaitMs(b.waitMs),
                textStreamMs: computeTextStreamMs(b.textStreamMs),
              }
            : b,
        ),
        pendingId: null,
        textStreamStartAt: 0,
      }));
      return;
    }

    // Client-side word-by-word reveal. SAFE because by the time we're
    // here message.in has already been dispatched — no more chunks racing.
    // We mark the bubble as no-longer-pending immediately (so the typing
    // dots disappear) but reveal the text progressively.
    const targetId = id!;
    set((st) => ({
      bubbles: st.bubbles.map((b) =>
        b.id === targetId
          ? {
              ...b,
              text: "",
              pending: false,
              footer: footer ?? b.footer,
              waitMs: computeWaitMs(b.waitMs),
              textStreamMs: computeTextStreamMs(b.textStreamMs),
            }
          : b,
      ),
      pendingId: null,
      textStreamStartAt: 0,
    }));
    const words = text.match(/\S+\s*/g) ?? [text];
    let i = 0;
    const drip = () => {
      if (i >= words.length) return;
      const next = words[i++];
      const cur2 = get();
      const exists = cur2.bubbles.some((b) => b.id === targetId);
      if (!exists) return; // bubble cleared (clearLog), abort reveal
      set((st) => ({
        bubbles: st.bubbles.map((b) => (b.id === targetId ? { ...b, text: b.text + next } : b)),
      }));
      setTimeout(drip, 22);
    };
    setTimeout(drip, 0);
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
    const bubbles: Bubble[] = items.map((it, i) => {
      const role = it.role === "agent" ? ("assistant" as const) : ("user" as const);
      if (role === "assistant") {
        const { clean, footer } = parseFooter(it.text);
        return {
          id: `h-${it.ts}-${i}`,
          role,
          text: clean,
          ts: it.ts,
          footer: footer ?? undefined,
        };
      }
      return { id: `h-${it.ts}-${i}`, role, text: it.text, ts: it.ts };
    });
    set({ bubbles, pendingId: null });
  },

  clearLog: () => set({ bubbles: [], pendingId: null }),

  setLivePartial: (text) => set({ livePartial: text }),
  setMicLevel: (level) => set({ micLevel: Math.max(0, Math.min(1, level)) }),
  setInCall: (on) => set({ inCall: on }),

  setPrefs: (patch) => set((st) => ({ prefs: { ...st.prefs, ...patch } })),

  noteUserInput: (ts) => set({ lastUserInputAt: ts ?? Date.now() }),

  noteAudioStart: () => {
    const cur = get();
    const lastAsst = [...cur.bubbles].reverse().find((b) => b.role === "assistant");
    const now = Date.now();
    // Freeze ATTESA AUDIO (audioWaitMs) on the bound bubble: TTS
    // synthesis+network lag from user input to first audio out.
    const audioWaitMs =
      cur.lastUserInputAt > 0 ? now - cur.lastUserInputAt : undefined;
    const validWait =
      audioWaitMs != null && audioWaitMs >= 0 && audioWaitMs < 60_000;
    set((st) => ({
      lastAudioStart: now,
      lastAssistantBubbleId: lastAsst?.id ?? null,
      bubbles: validWait && lastAsst
        ? st.bubbles.map((b) =>
            b.id === lastAsst.id && b.audioWaitMs == null
              ? { ...b, audioWaitMs }
              : b,
          )
        : st.bubbles,
    }));
  },

  noteAudioEnd: () => {
    const cur = get();
    if (!cur.lastAudioStart) return;
    cur.freezeAudioTimer(Date.now(), cur.lastAudioStart);
    set({ lastAudioStart: 0, lastAssistantBubbleId: null });
  },

  freezeWaitTimer: (eventTs) => {
    const cur = get();
    if (!cur.lastUserInputAt) return;
    const id = cur.pendingId
      ?? [...cur.bubbles].reverse().find((b) => b.role === "assistant")?.id;
    if (!id) return;
    const waitMs = eventTs - cur.lastUserInputAt;
    if (waitMs < 0 || waitMs > 60_000) return; // sanity guard
    set((st) => ({
      bubbles: st.bubbles.map((b) =>
        // Don't overwrite — first event (chunk OR audio.play) wins.
        b.id === id && b.waitMs == null ? { ...b, waitMs } : b,
      ),
    }));
  },

  freezeAudioTimer: (audioEndTs, audioStartTs) => {
    // Audio chip duration = playback only (audio-start → audio-end). The
    // synthesis/network lag is on the separate "attesa" chip.
    set((st) => {
      let frozen = false;
      const bubbles = [...st.bubbles].reverse().map((b) => {
        if (frozen || b.role !== "assistant") return b;
        if (b.audioMs != null) return b;
        frozen = true;
        return { ...b, audioMs: audioEndTs - audioStartTs };
      });
      return { bubbles: bubbles.reverse() };
    });
  },
}));
