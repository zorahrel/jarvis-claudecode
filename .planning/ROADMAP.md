# Roadmap: Jarvis Router

## Overview

Jarvis Router è un orchestrator multi-canale (Telegram/WhatsApp/Discord/tray-app) che spawn-a sessioni Claude Code via SDK. Questa roadmap copre il primo lavoro pianificato sotto GSD: visibility sul context state delle sessioni live (Phase 1). Future phase saranno aggiunte mano a mano (es. tray app session view, push alerts, disk hygiene, config cleanup automatico).

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 1: Context Inspector** — Tab dashboard per audit token/categoria + cruft detection delle sessioni Claude Code attive ✓ 2026-05-01 (code complete, UAT pending user)

## Phase Details

### Phase 1: Context Inspector
**Goal**: Dashboard tab che mostra in tempo reale ogni sessione Claude Code (router + bare CLI) con token usage, breakdown 8 categorie (system/tools/MCP/skills/CLAUDE.md/subagents/hooks-memory/history), cost $ per route + aggregato, e cruft detection (MCP non usati, skill non invocate). Threshold colore 50/75/90%. Riusa infra esistente (`/api/local-sessions` + `LocalSessionsSection.tsx`); niente tokenizer locale (usa `SDKTaskProgressMessage.usage.total_tokens` dal SDK stream + ultima riga JSONL per bare CLI).
**Depends on**: Nothing (first phase)
**Requirements**: CTX-01, CTX-02, CTX-03, CTX-04, CTX-05, CTX-06, CTX-07, CTX-08, CTX-09, CTX-10, CTX-11, CTX-12, CTX-13, CTX-14, CTX-15
**Success Criteria** (what must be TRUE):
  1. User apre dashboard `localhost:3340`, vede tab "Context" con elenco sessioni live (router + bare) e total token aggregato
  2. Per ogni sessione: bar % con colore threshold corretto (blue <50, giallo 50-74, arancione 75-89, rosso ≥90) — vedi CTX-03 in REQUIREMENTS.md per la palette canonica
  3. User clicca su una sessione e vede breakdown stacked bar in 8 categorie (system, tools, MCP, skills, CLAUDE.md chain, subagents, hooks/memory, history) con peso in token e %
  4. Per la sessione corrente jarvis (fullAccess), il breakdown mostra MCP ~10-15k token e la lista dei 13 server con tools count
  5. Per CLAUDE.md, il breakdown lista i file @-import (SOUL/AGENTS/IDENTITY/MEMORY/USER/TOOLS) con peso individuale
  6. Cost $ per turno è visibile per route + aggregato giornaliero in footer
  7. Sezione "Cruft detection" segnala MCP server caricati ma non chiamati negli ultimi 5 turni e skill nell'indice mai invocate, con suggerimenti config (es. "split jarvis-chat vs jarvis-code")
  8. Storico recente mostra ultime N sessioni chiuse con compaction count e disk size totale (986 MB / 2012 JSONL al baseline 2026-05-01)
  9. Auto-refresh polling 5s funziona senza memory leak su 10+ minuti aperto
**Plans**: 8 plans in 5 waves (Wave 0..4)

Plans:
- [x] 01-01-PLAN.md — Wave 0: Test scaffolding (node:test fixtures + SDK mock + run script)
- [x] 01-02-PLAN.md — Wave 1: Token source (SDK + JSONL tail) + cost calculation library
- [x] 01-03-PLAN.md — Wave 1: 8-category breakdown estimator + CLAUDE.md @-import resolver
- [x] 01-04-PLAN.md — Wave 1: Cruft detector + JSONL parser + disk hygiene stats
- [x] 01-05-PLAN.md — Wave 2: API endpoints (extended /api/local-sessions + /breakdown + /cruft) + claude.ts SDK tap
- [x] 01-06-PLAN.md — Wave 3: ContextTab UI components (AggregateHeader, SessionRow, BreakdownStackedBar, CruftPanel, RecentSessionsList, DiskHygieneFooter)
- [x] 01-07-PLAN.md — Wave 3: Polling hook with memory-leak guards + Sidebar/App route wiring
- [x] 01-08-PLAN.md — Wave 4: Final test sweep + dashboard build + router restart + manual UAT (checkpoint:human-verify)

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Context Inspector | 8/8 | Code complete (UAT pending user) | 2026-05-01 |
| 2. Orchestrator Multi-Session | 3/5 | Plans 02-01..03 done; 02-04 running concurrently; 02-05 deferred | — |

### Phase 2: Orchestrator Multi-Session
**Goal**: Cruscotto unificato per pilotare N sessioni Claude Code attive (router-spawned + bare CLI under tmux). Trasforma 5+ sessioni scollegate in un'orchestra controllabile da un punto: skill `/orchestrator` produce snapshot con next-step suggerito per ogni sessione; Reminders Mac come intent layer (sync iPhone/Watch/Siri); notch HUD always-on con top-3 todo + badge sessioni; tmux send-keys come canale di inject approvato dall'utente. Read-only first (Plan 02-01) + sync (02-02..03) + write con approvazione (02-04) + auto-pilot opt-in (02-05). Estende infrastructure di Phase 1 (`/api/local-sessions`), nessuna riscrittura.
**Depends on**: Phase 1 (Context Inspector — `/api/local-sessions` + JSONL parser)
**Requirements**: ORC-01, ORC-02, ORC-03, ORC-04, ORC-05, ORC-06, ORC-07, ORC-08, ORC-09, ORC-10, ORC-11, ORC-12, ORC-13, ORC-14, ORC-15, ORC-16, ORC-17, ORC-18, ORC-19, ORC-20, ORC-21, ORC-22
**Success Criteria** (what must be TRUE):
  1. User digita `/orchestrator` in chat → riceve JSON con un entry per ogni sessione live (router + bare under tmux), ogni entry ha `pid`, `repo`, `branch`, `status` derivato (awaiting_user_input/tool_pending/crashed/working/idle), `last_assistant_summary`, `suggestion`, `action`, `todo_link`
  2. Apple Reminders list `Jarvis/ActiveTasks` sincronizzata bidirezionale entro 3-15s lag: orchestrator scrive todo nuovi → visibili su iPhone/Watch/Siri; user spunta su iPhone → router rileva al next poll → notifica notch
  3. Notch (mod. expanded) mostra always-on: (a) right peek con sidebar sessioni live + badge stato colorato; (b) thin strip con top-3 todo aperti; click su todo = complete, long-press = riassegna sessione
  4. Dashboard ha nuova tab "Orchestrator" con per-sessione controlli "Approve" / "Skip" / "Custom" attivi solo per sessioni in stato `awaiting_user_input`; click "Approve" esegue `tmux send-keys` sulla pane mappata e scrive audit JSONL
  5. Cwd-collision lock: due sessioni con stesso cwd o sub-path producono `conflict: <other_pid>` nello snapshot e bloccano "Approve" finché user non digita `force` nel modal
  6. Auto-pilot mode è disabled by default; abilitato via `config.yaml`, applica solo action con `confidence: high` e rispetta daily_token_cap (default 100k); ogni auto-inject in audit con `source: "auto"`
  7. Bare Terminal.app sessions (no tmux) appaiono nello snapshot in read-only — niente endpoint inject, "Approve" disabilitato con tooltip
  8. Skill `/orchestrator` sta in `~/jarvis/skills-marketplace/skills/orchestrator/` (mai in `~/.claude/`); fa solo HTTP calls al router, niente fs reads diretti
**Plans**: 5 plans in 4 effective waves (02-05 deferred behind manual gate)

Plans:
- [x] 02-01-PLAN.md — Wave 0: Conductor read-only — fixtures + transcriptReader/refinedStatus/cwdLock/suggestionEngine + /api/sessions/:pid/{transcript,snapshot} + skill /orchestrator (HTTP-only). Requirements: ORC-01..05 ✓ 2026-05-10
- [x] 02-02-PLAN.md — Wave 1: Reminders bridge — remindctl wrapper + 3s polling + metadata schema (pid/repo/phase) + /api/todos GET/POST/PATCH/complete + TodosTab.tsx + auth banner. Requirements: ORC-06..10. Depends on 02-01.
- [x] 02-03-PLAN.md — Wave 1: Notch HUD Swift views — SessionsSidebarView + TodoStripView + NotchEventBus reconnect + bridge in connectors/notch.ts. Requirements: ORC-11..14. Depends on 02-02. ✓ 2026-05-10
- [ ] 02-04-PLAN.md — Wave 2: tmux inject control — pid→pane resolver (cached) + /api/sessions/:pid/{tmux,inject} + audit JSONL + Approve/Skip/Custom dashboard + force-confirm modal. Requirements: ORC-15..19. Depends on 02-01 + 02-02.
- [ ] 02-05-PLAN.md — Wave 5 [DEFERRED, autonomous=false]: Auto-pilot opt-in — UserPromptSubmit hook + budget guard + confidence:high gate + audit. Requirements: ORC-20..22. Depends on 02-01..04. Manual /gsd:execute-plan 02-05 only after ≥1 week stability.
