/**
 * Phase 2 Plan 02-04 — handleTmuxLookup contract (ORC-15).
 *
 * Tests the pure handler with stubbed findPane. Full HTTP envelope (status
 * + JSON body) verified end-to-end via the live curl smoke step in the
 * plan's <verification> block.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleTmuxLookup } from "./api.tmux.js";

test("GET /api/sessions/:pid/tmux returns has_tmux:true with session_name + pane_id when pane resolves", async () => {
  const r = await handleTmuxLookup(
    { findPane: async () => ({ session: "work-jarvis", pane: "%2" }) },
    12345,
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    has_tmux: true,
    session_name: "work-jarvis",
    pane_id: "%2",
  });
});

test("GET /api/sessions/:pid/tmux returns has_tmux:false for bare-TTY sessions", async () => {
  const r = await handleTmuxLookup({ findPane: async () => null }, 99999);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { has_tmux: false });
});

test("GET /api/sessions/0/tmux returns 400 invalid_pid", async () => {
  const r = await handleTmuxLookup(
    { findPane: async () => null },
    0,
  );
  assert.equal(r.status, 400);
  assert.deepEqual(r.body, { error: "invalid_pid" });
});
