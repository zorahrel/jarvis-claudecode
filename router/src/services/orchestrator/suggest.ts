import type { RefinedStatus, Suggestion } from "./types.js";

/**
 * Deterministic suggestion table — Phase 2 Plan 02-01 (ORC-04).
 *
 * Pure function. No I/O. No LLM. Lookup-only mapping from
 * (refinedStatus, lastAssistantSummary?) → (text, action, confidence, reason).
 *
 * Auto-pilot (Plan 02-05) MUST gate on `confidence==="high"` AND
 * `action.type==="inject"` — only the explicit-approval branch below qualifies.
 * Custom inject text from a user textarea always rides the dashboard
 * "user-approved" path, never auto-pilot.
 */

const APPROVAL_PROMPT_RE = /\b(approve|approval|y\/n|proceed\?|continue\?)\b/;

export interface SuggestInput {
  refinedStatus: RefinedStatus;
  lastAssistantSummary: string | null;
}

export function suggestNext(s: SuggestInput): Suggestion {
  switch (s.refinedStatus) {
    case "awaiting_user_input": {
      const last = (s.lastAssistantSummary ?? "").toLowerCase();
      const trimmed = last.trim();
      if (APPROVAL_PROMPT_RE.test(last) || /\?$/.test(trimmed)) {
        return {
          text: "Approve and proceed",
          action: { type: "inject", text: "y" },
          confidence: "high",
          reason: "explicit approval prompt",
        };
      }
      return {
        text: "Acknowledge",
        action: { type: "inject", text: "ok" },
        confidence: "low",
        reason: "ambiguous prompt",
      };
    }
    case "tool_pending":
      return {
        text: "Wait — tool call in flight",
        action: { type: "none", reason: "tool_use unmatched" },
        confidence: "high",
        reason: "tool_use unmatched",
      };
    case "crashed":
      return {
        text: "Restart session",
        action: { type: "restart" },
        confidence: "medium",
        reason: "process gone, transcript incomplete",
      };
    case "working":
      return {
        text: "Working — let it run",
        action: { type: "none", reason: "active progress" },
        confidence: "high",
        reason: "active progress",
      };
    case "idle":
      return {
        text: "Idle — check in",
        action: { type: "none", reason: "no recent activity" },
        confidence: "low",
        reason: "no recent activity but no prompt either",
      };
  }
}
