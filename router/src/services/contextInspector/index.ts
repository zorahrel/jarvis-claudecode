/**
 * Context Inspector — barrel re-exports.
 *
 * Pure module aggregator: consumers import from one path
 * (`../contextInspector/index.js`) instead of reaching into the 8 internal
 * modules. Used by:
 *  - `dashboard/api.ts` (the 3 HTTP endpoints)
 *  - `services/claude.ts` (SDK consumer loop taps + sidecar lifecycle)
 *  - `services/localSessions/discovery.ts` (sidecar lookup by PID)
 */

export * from "./types.js";

export {
  recordTaskProgress,
  recordTurnResult,
  clearTaskProgress,
  getLiveTokensFromSdk,
  getLiveTokensFromJsonl,
  normalizeModel,
  _resetForTests,
} from "./tokenSource.js";

export { costPerTurn, aggregateCost, formatUsd, RATES } from "./cost.js";

export { calculateBreakdown } from "./breakdown.js";
export type {
  SpawnConfig,
  BreakdownResult,
  CategoryResult,
  CategoryDetails,
  McpServerDetail,
  ChainEntryDetail,
} from "./breakdown.js";

export { expandClaudeMdChain } from "./claudeMdChain.js";
export type { ChainEntry, ChainResult } from "./claudeMdChain.js";

export {
  detectCruft,
  getSuggestionsForCruft,
  extractMcpServerName,
  SUGGESTIONS,
} from "./cruft.js";
export type { CruftFinding, ConfigSuggestion } from "./cruft.js";

export {
  extractToolUseEvents,
  countCompactions,
  sumTokens,
  countTurns,
  readJsonlTailLines,
} from "./jsonlParser.js";
export type { ToolUseRecord, TokenSummary } from "./jsonlParser.js";

export { diskStats, recentSessions } from "./diskHygiene.js";
export type { DiskStats, RecentSession } from "./diskHygiene.js";

export {
  writeSessionSidecar,
  readSessionSidecar,
  removeSessionSidecar,
  listSessionSidecars,
  ACTIVE_SESSIONS_DIR,
} from "./sidecar.js";
export type { SessionSidecar } from "./sidecar.js";

export { analyzeAgentBaselines } from "./agentBaselines.js";
export type { AgentBaseline, AgentCruftHint } from "./agentBaselines.js";
