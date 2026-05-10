/**
 * Stub re-export for tsx ESM resolution.
 *
 * Some import chain (likely a transitive dynamic import inside
 * `agent-conductor` or `notch/orchestrator-events.ts`) resolves to
 * `services/orchestrator/snapshot.js`. The actual snapshot builder
 * lives in the `agent-conductor` package — this file only exists so
 * tsx's ESM resolver finds *something* and doesn't spam ERR_MODULE_NOT_FOUND
 * every 5 seconds (the orchestrator bridge tick rate in dashboard/server.ts).
 *
 * Re-exports the real `buildSnapshot` from `agent-conductor` so callers
 * that resolve this path get the correct implementation.
 */

export { buildSnapshot, composeSnapshot } from "agent-conductor";
