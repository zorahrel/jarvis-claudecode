---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_plan: 02-04 (running concurrently — tmux inject)
status: in_progress
last_updated: "2026-05-10T11:17:30Z"
progress:
  total_phases: 2
  completed_phases: 1
  total_plans: 13
  completed_plans: 12
---

# State: Jarvis Router

## Current Status

**Active milestone:** v1
**Active phase:** Phase 2 — Orchestrator Multi-Session (executing)
**Current plan:** 02-03 completed — Notch HUD; 02-04 running concurrently — tmux inject (Wave 1b parallel)
**Branch:** feature/orchestrator (rebased on main dd4345d)
**Last session:** 2026-05-10T11:17:30Z — Completed 02-03-PLAN.md (Notch HUD)

## Accumulated Context

### Roadmap Evolution

- 2026-05-01: Phase 1 added — Context Inspector (8 plans, completed code-complete)
- 2026-05-10: Phase 2 added — Orchestrator multi-sessione (cruscotto unificato per pilotare N sessioni Claude Code attive con todo backbone Apple Reminders e HUD notch; 5 plan in waves)
- 2026-05-10: Phase 2 Plan 01 completed — read-side observatory: refinedStatus + suggestion + lock + 2 HTTP endpoints + /orchestrator skill. 47 tests GREEN, typecheck GREEN.
- 2026-05-10: Phase 2 Plan 02 completed — Reminders bridge: remindctl wrapper + 3s polling + /api/todos endpoints + TodosTab dashboard with Vitest+RTL. 33 new tests GREEN, typecheck GREEN, dashboard build GREEN, no notch/events.ts pollution. ORC-06..10 closed.
- 2026-05-10: Phase 2 Plan 03 completed — Notch HUD: SessionsSidebarView + TodoStripView + NotchEventBus multi-subscriber + reconnect-replay-last-snapshot + router orchestrator-events bridge. 10 XCTest cases GREEN, 68 prior router tests still GREEN, typecheck GREEN, swift build GREEN, tray-app/make-app.sh GREEN, notch/events.ts UNCHANGED. ORC-11..14 closed.

### Decisions Log

- 2026-05-10: Branch strategy — Phase 2 lives on `feature/orchestrator` (separate from `feature/notch` which was already merged into main). Notch UI stays in its own track; orchestrator delivers as dashboard tab + skill `/orchestrator`.
- 2026-05-10: Phase 2 architecture — 3 layer separation: Reminders = intent layer, /api/local-sessions = execution layer, notch = HUD, orchestrator = bridge translating intent ↔ execution.
- 2026-05-10: Phase 2 inject mechanism — chosen `tmux send-keys` over `UserPromptSubmit` hook + file watch, because zero modifications to Claude Code and works on existing terminal sessions when run under tmux.
- 2026-05-10 (Plan 02-01): Pure composer + async wrapper split — `composeSnapshot` (sync, pure) + `buildSnapshot` (async, fetches inputs) makes orchestrator composition unit-testable without fs/discovery mocking.
- 2026-05-10 (Plan 02-01): `buildTranscript` extracted into `services/orchestrator/snapshot.ts` so the `/api/sessions/:pid/transcript` handler stays unit-testable. Importing `handleApi` in tests transitively pulls in baileys + cron + ws and hangs the test runner.
- 2026-05-10 (Plan 02-01): refinedStatus 2s in-process cache mirrors `localSessions/discovery.ts CACHE_TTL_MS` so dashboard 5s polling never thrashes JSONL reads.
- 2026-05-10 (Plan 02-02): Pure handler helpers + injectable deps — same `handleApi`-import-hangs-tests workaround as Plan 02-01's buildTranscript. `api.todos.ts` has the route logic; `api.ts` is a 4-line wrapper. Tests are fast and hermetic.
- 2026-05-10 (Plan 02-02): `normalizeRemindCtl` adapter — live remindctl 0.1.1 emits `{listName, isCompleted, priority:string}` not the documented `{list, completed, priority:number}`. Adapter shields downstream code from CLI version drift.
- 2026-05-10 (Plan 02-02): Banner-driven graceful degradation for `/api/todos` — never 500 on unauthorized OR list-missing. Dashboard renders specific banners per state (`unauthorized:true` → `remindctl authorize` instructions; `listMissing:true` → `remindctl list "Jarvis/ActiveTasks" --create` instructions). Polling loop also swallows list-missing silently to avoid 3s WARN spam.
- 2026-05-10 (Plan 02-02): Selective Vitest fake timers (`vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })`) — full fake timers wedge RTL's waitFor; this lets us test 5s cadence without breaking async assertions.
- 2026-05-10 (Plan 02-02): Vitest+RTL+jsdom installed in dashboard package as one-time infrastructure; future React component specs land for free.
- 2026-05-10 (Plan 02-02): `notch/orchestrator-events.ts` separate from `notch/events.ts` — RESEARCH.md anti-pattern explicitly avoided. Sessions/todos events do NOT pollute the WKWebView wire protocol.
- 2026-05-10 (Plan 02-02): PATCH /api/todos/:uuid landed here (B2 fix) instead of Plan 02-03 — keeps the four todo handlers cohesive in one module.
- 2026-05-10 (Plan 02-03): Bridge boots from `server.ts`, not `api.ts`. The parallel-execution constraint forbade touching `api.ts` while Plan 02-04's agent owned the snapshot/inject regions. `server.ts` already owns `startReminderPolling` lifecycle — natural co-location for `startOrchestratorBridge`. Plan explicitly permitted this with "or wherever the dashboard server is bootstrapped".
- 2026-05-10 (Plan 02-03): NotchEventBus gains a multi-subscriber `subscribe(_:)` API alongside the existing `start(_:)` API. Backwards-compatible — existing controller handler keeps working unchanged.
- 2026-05-10 (Plan 02-03): Last-known-snapshot cache lives on the bus, not the views. Replays on subscribe + on reconnect (`replayCachedSnapshots` from `scheduleReconnect`). Single source of truth — no per-view caching, no race between bus and view-model. Solves ORC-14 reconnect-state preservation.
- 2026-05-10 (Plan 02-03): Test affordances behind `#if DEBUG` extensions on the bus + the views (`publishForTesting`, `simulateDisconnectForTesting`, `lastSessionsForTesting`, `resetForTesting`, `_test_complete(id:session:)`, `_test_longPressOpensPicker(id:)`, `_test_installSubscription`). Production API stays clean; XCTest drives the same code paths the production lifecycle modifiers register.
- 2026-05-10 (Plan 02-03): NotchConnector forwards orchestrator events via the EXISTING `emitNotch({type, data})` transport. No new endpoint, no new SSE channel. The Swift `NotchEventBus.parse(line:)` updates recognize the two new types and route them to orchestrator subscribers. RESEARCH.md anti-pattern preserved end-to-end — `notch/events.ts` UNCHANGED.

### Open Stashes

- `stash@{0}`: MCP auth v2 WIP (stdio + http transport) — paused for Phase 2; resume after orchestrator delivery. **The pre-existing un-staged diff in `router/src/dashboard/api.ts` (606..887 region) is preserved here. Plan 02-02's Task 3 reset the working-tree state of api.ts to HEAD before staging to keep the orchestrator-todos commit clean — recovery via `git stash apply stash@{0}` will need conflict resolution because line numbers shifted by ~46 from new todos imports.** See `.planning/phases/02-orchestrator-multi-session/deferred-items.md`.

## Performance Metrics

| Plan  | Duration | Tasks | Files | Tests added | Completed                |
| ----- | -------- | ----- | ----- | ----------- | ------------------------ |
| 02-01 | 24 min   | 4/4   | 21    | 26 (47 GREEN total) | 2026-05-10T10:29:24Z |
| 02-02 | 23 min   | 4/4   | 30    | 33 (62 GREEN total)  | 2026-05-10T10:59:09Z |
| 02-03 | 10 min   | 3/3   | 13    | 10 XCTest (Swift) + 0 router (router specs unchanged, all 68 still GREEN) | 2026-05-10T11:17:30Z |
