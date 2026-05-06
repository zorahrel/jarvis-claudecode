# Plan 01-05 — Backend Wiring + 3 API Endpoints — SUMMARY

**Status:** COMPLETE
**Wave:** 2
**Date:** 2026-05-01
**Self-Check:** PASSED

## Objective achieved

Wave 1 modules wired into the live router. SDK consumer loop in `claude.ts` taps both `task_progress` events (running totalTokens) AND `result` events (per-field usage for cost calc — BLOCKER 1 fix). Sidecar JSON files at `~/.claude/jarvis/active-sessions/<pid>.json` link spawned Claude SDK PIDs to the router sessionKey (MAJOR 5 fix), read by `localSessions/discovery.ts`. Three new HTTP endpoints in `dashboard/api.ts`.

## Files created (4 NEW)

- `router/src/services/contextInspector/sidecar.ts` — write/read/remove/list sidecar JSON by PID
- `router/src/services/contextInspector/sidecar.spec.ts` — 7 tests
- `router/src/services/contextInspector/index.ts` — barrel re-exports of 8 internal modules
- `router/src/services/contextInspector/api.spec.ts` — 5 integration tests (BLOCKER 1 contract)

## Files modified (4)

- `router/src/services/localSessions/types.ts` — `LocalSession` extended with 11 optional fields
- `router/src/services/localSessions/discovery.ts` — reads sidecar by PID; populates sessionKey/agent/fullAccess
- `router/src/services/claude.ts` — 5 surgical changes: imports + helper functions + SDK consumer dual tap + killSession cleanup + getSessionMetadata/listSessionKeys exports
- `router/src/dashboard/api.ts` — imports + extended `/api/local-sessions` + 2 new endpoints

## API endpoints (response shapes)

### `GET /api/local-sessions` (extended)

Default response:
- `sessions: LocalSession[]` (with new optional fields populated)
- `aggregate: { totalSessions, totalLiveTokens, avgCostPerTurnUsd }`
- `disk: { totalMb, totalJsonl, filesOlderThan30d }`
- `recent: RecentSession[]` (top 10 newest)

Backward-compat: `?legacy=1` returns the OLD `LocalSession[]` shape verbatim.

### `GET /api/sessions/:sessionId/breakdown` (NEW)

Drill-down with the 8 categories (system_preset, builtin_tools, mcp_servers, skills_index, claudemd_chain, subagents, hooks_memory, history). Each category has `{ category, tokens, details }`. Plus `totalEstimated` and `liveTotal`.

### `GET /api/sessions/cruft` (NEW)

Per-agent cruft detection. Returns `{ agents: [{ agent, findings, suggestions }] }`. Findings list unused MCPs/skills with token cost. Suggestions match the 4 hardcoded entries (split-jarvis-chat, notch-collapse-userscope, gsd-namespace-gating, scope-mcp-explicit).

## Sidecar lifecycle

- **Spawn**: first `task_progress` event triggers `registerSessionSidecars(s)` → enumerates Claude CLI children of router PID via `ps` → writes one JSON per PID with sessionKey/agent/fullAccess/inheritUserScope
- **Live**: `discovery.ts` reads sidecar by PID and attaches fields to LocalSession
- **Kill**: `killSession` calls `unregisterSessionSidecars(sessionKey)` → unlinks all tracked PIDs
- Sidecar dir: `~/.claude/jarvis/active-sessions/<pid>.json`

## Test results

12 new tests pass (7 sidecar + 5 api.spec). Total Wave 0+1+2: **57/57** all green.

BLOCKER 1 contract (verified by `api.spec.ts`):
- Call `recordTaskProgress("k", 87432)`
- Call `recordTurnResult("k", { input: 1500, output: 800, cache_creation: 30000, cache_read: 50000 })`
- Result: `getLiveTokensFromSdk(...).lastTurnUsage` is non-null AND `costPerTurn(snap.lastTurnUsage, "sonnet").totalUsd > 0`

## Smoke test recipe (post-restart in Plan 08)

```bash
curl -s http://127.0.0.1:3340/api/local-sessions | jq '.aggregate'
curl -s "http://127.0.0.1:3340/api/local-sessions?legacy=1" | jq 'length'
curl -s http://127.0.0.1:3340/api/local-sessions | jq '.sessions[] | select(.isRouterSpawned == true) | {pid, sessionKey, agent, lastTurnCostUsd}'
ls ~/.claude/jarvis/active-sessions/
curl -s http://127.0.0.1:3340/api/sessions/cruft | jq '.agents'
```

## Commits

- `62be8ba` feat(01-05): sidecar PID linkage + tap dual SDK (task_progress + result) in claude.ts
- `5aa578f` feat(01-05): discovery.ts legge sidecar per attaccare sessionKey/agent
- `9ddee44` feat(01-05): 3 endpoint API (local-sessions extended + breakdown + cruft)
- `bd81d7d` test(01-05): integration spec end-to-end con BLOCKER 1 contract

## Notes

- Pre-existing TS error at `dashboard/api.ts:1756` (notch `event` parameter implicit any) is unrelated to this plan.
- The `?legacy=1` query param is a temporary backward-compat hatch — Plan 06 adopts the new shape; the param can stay indefinitely.
- CTX-09 caveat preserved: skill cruft detection is unit-tested but `skillsLoaded: []` in production until v2 skills index reader.
