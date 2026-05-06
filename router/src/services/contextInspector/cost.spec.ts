import { test } from "node:test";
import assert from "node:assert/strict";
import { costPerTurn, aggregateCost, formatUsd, RATES } from "./cost.js";

test("RATES table has entries for sonnet, opus, haiku", () => {
  assert.ok(RATES.sonnet);
  assert.ok(RATES.opus);
  assert.ok(RATES.haiku);
  assert.equal(RATES.sonnet.input, 3);
  assert.equal(RATES.opus.input, 5);
});

test("costPerTurn Sonnet 4.6 fresh-input + output (no cache)", () => {
  const c = costPerTurn(
    { input_tokens: 1500, output_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    "sonnet",
  );
  // 1500 * 3 / 1e6 + 800 * 15 / 1e6 = 0.0045 + 0.012 = 0.0165
  assert.ok(Math.abs(c.totalUsd - 0.0165) < 1e-9, `expected 0.0165, got ${c.totalUsd}`);
  assert.ok(Math.abs(c.inputUsd  - 0.0045) < 1e-9);
  assert.ok(Math.abs(c.outputUsd - 0.012)  < 1e-9);
  assert.equal(c.cacheWriteUsd, 0);
  assert.equal(c.cacheReadUsd, 0);
});

test("costPerTurn Opus 4.7 fresh-input + output (no cache)", () => {
  const c = costPerTurn(
    { input_tokens: 1500, output_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    "opus",
  );
  // 1500 * 5 / 1e6 + 800 * 25 / 1e6 = 0.0075 + 0.02 = 0.0275
  assert.ok(Math.abs(c.totalUsd - 0.0275) < 1e-9, `expected 0.0275, got ${c.totalUsd}`);
});

test("costPerTurn warm turn: 30k cache_read on Sonnet = $0.009", () => {
  const c = costPerTurn(
    { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 30000 },
    "sonnet",
  );
  // 30000 * 0.30 / 1e6 = 0.009
  assert.ok(Math.abs(c.cacheReadUsd - 0.009) < 1e-9, `expected 0.009, got ${c.cacheReadUsd}`);
  assert.ok(Math.abs(c.totalUsd     - 0.009) < 1e-9);
});

test("costPerTurn cache write 5m = 1.25x input rate (Sonnet)", () => {
  const c = costPerTurn(
    { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0 },
    "sonnet",
  );
  // 1000 * 3.75 / 1e6 = 0.00375
  assert.ok(Math.abs(c.cacheWriteUsd - 0.00375) < 1e-9);
});

test("aggregateCost sums totalUsd correctly", () => {
  const turns = [
    costPerTurn({ input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, "sonnet"),
    costPerTurn({ input_tokens: 500, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, "sonnet"),
  ];
  const agg = aggregateCost(turns);
  // (1000*3 + 100*15)/1e6 + (500*3 + 50*15)/1e6 = 0.0045 + 0.00225 = 0.00675
  assert.ok(Math.abs(agg - 0.00675) < 1e-9, `expected 0.00675, got ${agg}`);
});

test("formatUsd uses 4 decimals under $1, 2 above", () => {
  assert.equal(formatUsd(0.0042), "$0.0042");
  assert.equal(formatUsd(1.234567), "$1.23");
  assert.equal(formatUsd(0), "$0.0000");
});
