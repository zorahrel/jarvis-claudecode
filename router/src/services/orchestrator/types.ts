/**
 * Phase 2 Orchestrator — public type contracts.
 *
 * Single source of truth shared by:
 *  - refinedStatus.ts (5-state derivation)
 *  - suggest.ts (deterministic next-step table)
 *  - lock.ts (cwd conflict detection result wrapping)
 *  - snapshot.ts (top-level OrchestratorSnapshot composition)
 *  - dashboard/api.ts (HTTP serialization for /api/sessions/snapshot)
 *  - skills-marketplace/skills/orchestrator/SKILL.md (consumer contract)
 *
 * Downstream plans (02-02 Reminders, 02-03 Notch, 02-04 inject) extend
 * snapshot entries via the optional fields (todo_link, tmux). Adding new
 * fields here is allowed; renaming existing ones requires a coordinated
 * skill+dashboard update.
 */

export type RefinedStatus =
  | "awaiting_user_input"
  | "tool_pending"
  | "crashed"
  | "working"
  | "idle";

export type Confidence = "low" | "medium" | "high";

export type Suggestion = {
  text: string;
  action:
    | { type: "inject"; text: string }
    | { type: "abort" }
    | { type: "restart" }
    | { type: "none"; reason?: string };
  confidence: Confidence;
  reason: string;
};

export interface AuditEntry {
  ts: number;
  pid: number;
  repo: string;
  action: "inject" | "abort" | "restart";
  text?: string;
  source: "user-approved" | "auto" | "skill";
  confidence?: Confidence;
  reason?: string;
}

export interface SnapshotEntry {
  pid: number;
  repo: string;
  branch: string | null;
  cwd: string;
  status: RefinedStatus;
  last_assistant_summary: string | null;
  suggestion: string;
  action: Suggestion["action"];
  confidence: Confidence;
  todo_link: string | null;
  tmux: { session: string; pane: string } | null;
  conflict: number | null;
}

export interface OrchestratorSnapshot {
  generated_at: string;
  sessions: SnapshotEntry[];
}
