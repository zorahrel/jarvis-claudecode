# State: Jarvis Router

## Current Status

**Active milestone:** v1
**Active phase:** Phase 2 — Orchestrator Multi-Session (planning)
**Branch:** feature/orchestrator (rebased on main dd4345d)

## Accumulated Context

### Roadmap Evolution

- 2026-05-01: Phase 1 added — Context Inspector (8 plans, completed code-complete)
- 2026-05-10: Phase 2 added — Orchestrator multi-sessione (cruscotto unificato per pilotare N sessioni Claude Code attive con todo backbone Apple Reminders e HUD notch; 5 plan in waves)

### Decisions Log

- 2026-05-10: Branch strategy — Phase 2 lives on `feature/orchestrator` (separate from `feature/notch` which was already merged into main). Notch UI stays in its own track; orchestrator delivers as dashboard tab + skill `/orchestrator`.
- 2026-05-10: Phase 2 architecture — 3 layer separation: Reminders = intent layer, /api/local-sessions = execution layer, notch = HUD, orchestrator = bridge translating intent ↔ execution.
- 2026-05-10: Phase 2 inject mechanism — chosen `tmux send-keys` over `UserPromptSubmit` hook + file watch, because zero modifications to Claude Code and works on existing terminal sessions when run under tmux.

### Open Stashes

- `stash@{0}`: MCP auth v2 WIP (stdio + http transport) — paused for Phase 2; resume after orchestrator delivery.
