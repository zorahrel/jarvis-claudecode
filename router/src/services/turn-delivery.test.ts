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
  isReactionToRecentNotice,
  PROACTIVE_DEDUP_WINDOW_MS,
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

test("isReactionToRecentNotice: untracked sub-agent (no notice) → NOT suppressed (relay passes)", () => {
  // The repro case: delegated sub-agents send no task notice, so their relay
  // must still be delivered.
  assert.equal(isReactionToRecentNotice(undefined, 1_000_000), false);
});

test("isReactionToRecentNotice: a notice just sent → reaction suppressed (no double)", () => {
  const now = 1_000_000;
  assert.equal(isReactionToRecentNotice(now - 1_000, now), true);
});

test("isReactionToRecentNotice: notice outside the window → reaction delivered", () => {
  const now = 1_000_000;
  assert.equal(isReactionToRecentNotice(now - (PROACTIVE_DEDUP_WINDOW_MS + 1_000), now), false);
  // boundary: exactly the window is NOT suppressed (strictly-less-than)
  assert.equal(isReactionToRecentNotice(now - PROACTIVE_DEDUP_WINDOW_MS, now), false);
});
