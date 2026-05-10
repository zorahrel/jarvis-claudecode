# State: Jarvis Router

## Current Status

**Active milestone:** v1
**Active phase:** Phase 2 — Orchestrator Multi-Session (executing)
**Current plan:** 02-02 (next — Reminders bridge)
**Branch:** feature/orchestrator (rebased on main dd4345d)
**Last session:** 2026-05-10T10:29:24Z — Completed 02-01-PLAN.md

## Accumulated Context

### Roadmap Evolution

- 2026-05-01: Phase 1 added — Context Inspector (8 plans, completed code-complete)
- 2026-05-10: Phase 2 added — Orchestrator multi-sessione (cruscotto unificato per pilotare N sessioni Claude Code attive con todo backbone Apple Reminders e HUD notch; 5 plan in waves)
- 2026-05-10: Phase 2 Plan 01 completed — read-side observatory: refinedStatus + suggestion + lock + 2 HTTP endpoints + /orchestrator skill. 47 tests GREEN, typecheck GREEN.

### Decisions Log

- 2026-05-10: Branch strategy — Phase 2 lives on `feature/orchestrator` (separate from `feature/notch` which was already merged into main). Notch UI stays in its own track; orchestrator delivers as dashboard tab + skill `/orchestrator`.
- 2026-05-10: Phase 2 architecture — 3 layer separation: Reminders = intent layer, /api/local-sessions = execution layer, notch = HUD, orchestrator = bridge translating intent ↔ execution.
- 2026-05-10: Phase 2 inject mechanism — chosen `tmux send-keys` over `UserPromptSubmit` hook + file watch, because zero modifications to Claude Code and works on existing terminal sessions when run under tmux.
- 2026-05-10 (Plan 02-01): Pure composer + async wrapper split — `composeSnapshot` (sync, pure) + `buildSnapshot` (async, fetches inputs) makes orchestrator composition unit-testable without fs/discovery mocking.
- 2026-05-10 (Plan 02-01): `buildTranscript` extracted into `services/orchestrator/snapshot.ts` so the `/api/sessions/:pid/transcript` handler stays unit-testable. Importing `handleApi` in tests transitively pulls in baileys + cron + ws and hangs the test runner.
- 2026-05-10 (Plan 02-01): refinedStatus 2s in-process cache mirrors `localSessions/discovery.ts CACHE_TTL_MS` so dashboard 5s polling never thrashes JSONL reads.

### Open Stashes

- `stash@{0}`: MCP auth v2 WIP (stdio + http transport) — paused for Phase 2; resume after orchestrator delivery. **Pre-existing un-staged diff in `router/src/dashboard/api.ts` (606..887 region) is part of this work — see deferred-items.md in phases/02-orchestrator-multi-session/.**

## Performance Metrics

| Plan  | Duration | Tasks | Files | Tests added | Completed                |
| ----- | -------- | ----- | ----- | ----------- | ------------------------ |
| 02-01 | 24 min   | 4/4   | 21    | 26 (47 GREEN total) | 2026-05-10T10:29:24Z |
