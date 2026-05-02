# Plan 01-02 — Token Source + Cost Library — SUMMARY

**Status:** COMPLETE
**Wave:** 1
**Date:** 2026-05-01
**Self-Check:** PASSED

## Objective achieved

Token source library reading from SDK stream signal + JSONL tail (Paseo-style) + cost calculation library with cache multipliers. Includes BLOCKER 1 fix from planning revision: `recordTurnResult(sessionKey, usage)` merge helper that preserves prior `totalTokens` from `task_progress` events and attaches `lastTurnUsage` from `result` events — fixing the cost-calculation gap where router-spawned sessions would otherwise always have `null` lastTurnUsage.

## Files created

- `router/src/services/contextInspector/tokenSource.ts` — Live token signal extraction
  - `getLiveTokensFromSdk(session, lastTurnUsage)` — reads `task_progress.usage.total_tokens` from in-memory map
  - `getLiveTokensFromJsonl(path)` — tail-reads JSONL last assistant turn `.usage`
  - `recordTaskProgress(sessionKey, totalTokens, lastTurnUsage)` — preserves prior `lastTurnUsage` when called with `null`
  - `recordTurnResult(sessionKey, usage)` — preserves prior `totalTokens`, sets `lastTurnUsage` (**BLOCKER 1 fix**)
  - `normalizeModel(id)` — maps versioned ids (`claude-sonnet-4-6` → `sonnet`)
- `router/src/services/contextInspector/tokenSource.spec.ts` — 7 tests, all pass
- `router/src/services/contextInspector/cost.ts` — Per-turn cost calculation
  - `RATES: Record<PricedModel, ModelRates>` for sonnet/opus/haiku
  - `costPerTurn(usage, model): CostBreakdown` with split into input/cacheWrite/cacheRead/output
  - `aggregateCost(turns[])` — sum totalUsd
  - `formatUsd(amount)` — UI formatting (4 decimals < $1, 2 decimals ≥ $1)
- `router/src/services/contextInspector/cost.spec.ts` — 7 tests, all pass

## Cost formula (verified per Anthropic docs 2026-05)

```
cost = input × input_rate
     + cache_creation × cacheWrite5m_rate    (5-min ephemeral, default)
     + cache_read × cacheRead_rate
     + output × output_rate
```

Multipliers:
- 5-min cache write: 1.25× input rate
- 1-hour cache write: 2.00× input rate
- Cache read: 0.10× input rate

Per-million rates (USD):
- Sonnet 4.6: input $3, output $15 → cache_write_5m $3.75, cache_read $0.30
- Opus 4.7: input $5, output $25 → cache_write_5m $6.25, cache_read $0.50
- Haiku 3.5: input $0.80, output $4

## Test results

14 tests passing across `tokenSource.spec.ts` (7) + `cost.spec.ts` (7).

BLOCKER 1 contract test verified: `recordTaskProgress(k, 50000, null)` then `recordTurnResult(k, {input:1500, output:800, cache_creation:30000, cache_read:50000})` produces `lastTurnUsage` populated AND `costPerTurn(snapshot.lastTurnUsage, "sonnet").totalUsd > 0`.

## Commits

- `4b60894` feat(01-02): aggiungi tokenSource per signal SDK + JSONL tail
- `32e05a5` feat(01-02): aggiungi calcolo cost per turno con cache multipliers

## Notes

- Imports types only from `./types.js` (Wave 0 artifact). No imports from outside `contextInspector/` directory — module is self-contained.
- Plan 05 will tap `result` events in `claude.ts` and call `recordTurnResult` to feed `lastTurnUsage` into the live progress map. Without this Plan 05 wiring, the router-spawned cost calculation would always return `undefined` (the original BLOCKER 1 root cause).
- `tokenSource.spec.ts` was written by a sub-agent before mid-session permission failures. `cost.ts` was written inline by the orchestrator after sub-agent permission denial; content preserved verbatim from the agent's blocked-write report.
