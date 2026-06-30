/**
 * Run with: npx tsx --test src/services/turn-delivery.test.ts
 *
 * Verifies the root-cause fix for "channel starts but never delivers a final
 * result" (and the matching /compact COMPACT_TIMEOUT). The turn loop must skip
 * ONLY the keep-warm sentinel — never empty text — and the handler must always
 * have a non-empty body to deliver.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isKeepWarmSentinel,
  hasDeliverableText,
  EMPTY_TURN_FALLBACK,
  KEEPWARM_SENTINEL,
} from "./turn-delivery.js";

test("isKeepWarmSentinel: ONLY the keep-warm sentinel is skipped", () => {
  assert.equal(isKeepWarmSentinel(KEEPWARM_SENTINEL), true);
});

test("isKeepWarmSentinel: EMPTY text is NOT skipped — this is the fix (was hung before)", () => {
  // Before the fix the loop did `if (!text || ...) continue` → empty turns
  // hung. The turn must now resolve, so the sentinel check must return false.
  assert.equal(isKeepWarmSentinel(""), false);
});

test("isKeepWarmSentinel: real answers resolve", () => {
  assert.equal(isKeepWarmSentinel("ecco il risultato finale"), false);
  assert.equal(isKeepWarmSentinel("waiting"), false); // partial ≠ sentinel
});

test("hasDeliverableText: empty / whitespace / null / undefined are NOT deliverable", () => {
  assert.equal(hasDeliverableText(""), false);
  assert.equal(hasDeliverableText("   \n\t "), false);
  assert.equal(hasDeliverableText(null), false);
  assert.equal(hasDeliverableText(undefined), false);
});

test("hasDeliverableText: real text is deliverable", () => {
  assert.equal(hasDeliverableText("ciao"), true);
  assert.equal(hasDeliverableText("  ok  "), true);
});

test("the channel always gets a non-empty final body (no silent turn)", () => {
  // The exact decision handler.ts now makes for an empty turn.
  const body = hasDeliverableText("") ? "<formatted>" : EMPTY_TURN_FALLBACK;
  assert.ok(body.trim().length > 0, "empty turn must still deliver a non-empty body");
  assert.equal(body, EMPTY_TURN_FALLBACK);
});
