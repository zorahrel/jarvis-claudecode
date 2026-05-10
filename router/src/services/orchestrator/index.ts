/**
 * Orchestrator — barrel re-exports for Phase 2 Plan 02-01.
 *
 * Single import path for downstream consumers (dashboard/api.ts handlers,
 * future plans 02-02..02-05). Keeps internal module layout flexible.
 */

export { buildSnapshot, composeSnapshot, buildTranscript } from "./snapshot.js";
export type { TranscriptBlock, TranscriptTurn, TranscriptResponse } from "./snapshot.js";
export { deriveRefinedStatus, refinedStatusFor } from "./refinedStatus.js";
export { suggestNext } from "./suggest.js";
export { detectConflict, findGitRoot } from "./lock.js";
export type {
  RefinedStatus,
  Suggestion,
  SnapshotEntry,
  OrchestratorSnapshot,
  AuditEntry,
  Confidence,
} from "./types.js";
