/**
 * Transport-level Baileys/ws errors that are SAFE to absorb in the global
 * `uncaughtException` handler: the WhatsApp connector self-recovers from these
 * via its existing reconnect/backoff (a late handshake-timeout fires on the raw
 * ws after teardown, escaping to Node with no surviving listener).
 *
 * Matched on the error MESSAGE only — never on a ws/baileys stack frame — so a
 * genuine bug originating inside ws/baileys (TypeError, assertion, …) still
 * crashes the process and lets launchd restart it cleanly, instead of being
 * silently swallowed and resumed in a possibly-corrupt state.
 *
 * Keep this list tight. Adding a broad pattern here re-opens the door to
 * masking real crashes — see crash-guard.spec.ts for the contract.
 */
export function isAbsorbableWsError(message: string): boolean {
  return (
    /Opening handshake has timed out/.test(message) ||
    /WebSocket was closed before the connection was established/.test(message)
  );
}
