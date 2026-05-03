export type LocalSessionStatus = "working" | "idle" | "waiting" | "finished" | "errored" | "unknown";

export interface LocalSession {
  pid: number;
  cwd: string;
  repoName: string;
  branch: string | null;
  status: LocalSessionStatus;
  hookEvent: string | null;
  sessionId: string | null;
  transcriptPath: string | null;
  lastActivity: number;
  tty: string | null;
  parentCommand: string | null;
  preview: {
    lastUserMessage: string | null;
    lastAssistantText: string | null;
  };
  isRouterSpawned: boolean;
  // ─── Context Inspector extensions (Phase 1 — Plan 01-05) ─────────────────
  // All optional, populated by /api/local-sessions handler. Existing consumers ignore them.
  /** Live token count if known (router-spawned: from SDK task_progress; bare CLI: from JSONL tail). */
  liveTokens?: number;
  /** Source signal that produced liveTokens. */
  liveTokensSource?: "sdk-task-progress" | "sdk-result" | "jsonl-tail" | "unknown";
  /** Wall-clock ms when liveTokens was captured. */
  liveTokensAt?: number;
  /** Model context window in tokens (e.g. 200000). */
  contextWindow?: number;
  /** Cost in USD of the most recent completed turn. */
  lastTurnCostUsd?: number;
  /** Resolved Claude model id (e.g. "claude-sonnet-4-6"). */
  model?: string;
  /** Compaction count for the current session (router-spawned only). 0 if unknown. */
  compactionCount?: number;
  /** Router session key (e.g. "telegram:123456:jarvis") if router-spawned and sidecar resolved. */
  sessionKey?: string;
  /** Agent name (resolved from sidecar if router-spawned). */
  agent?: string;
  /** fullAccess flag for the agent (resolved from sidecar). */
  fullAccess?: boolean;
  /** inheritUserScope flag for the agent (resolved from sidecar). */
  inheritUserScope?: boolean;
}

export type OpenTargetId = "iterm" | "terminal" | "topics" | "finder" | "editor" | "pr";

export interface TargetAvailability {
  id: OpenTargetId;
  available: boolean;
  label: string;
  reason?: string;
}
