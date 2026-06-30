import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsorbableWsError } from "./crash-guard";

test("absorbs the known Baileys/ws handshake-timeout signatures", () => {
  assert.equal(isAbsorbableWsError("Opening handshake has timed out"), true);
  assert.equal(
    isAbsorbableWsError("WebSocket was closed before the connection was established"),
    true,
  );
});

test("does NOT absorb unrelated errors — they must crash & restart", () => {
  // The sock-null teardown footgun we guard elsewhere — must still be fatal if
  // it ever escapes, never silently swallowed.
  assert.equal(
    isAbsorbableWsError("Cannot read properties of undefined (reading 'catch')"),
    false,
  );
  // Generic faults that happen to originate in ws/baileys must still exit(1).
  assert.equal(isAbsorbableWsError("some baileys internal TypeError"), false);
  assert.equal(isAbsorbableWsError("ENOSPC: no space left on device"), false);
  assert.equal(isAbsorbableWsError(""), false);
});
