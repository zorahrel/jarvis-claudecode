# Roadmap: Jarvis Router

## Overview

Jarvis Router è un orchestrator multi-canale (Telegram/WhatsApp/Discord/tray-app) che spawn-a sessioni Claude Code via SDK. Questa roadmap copre il primo lavoro pianificato sotto GSD: visibility sul context state delle sessioni live (Phase 1). Future phase saranno aggiunte mano a mano (es. tray app session view, push alerts, disk hygiene, config cleanup automatico).

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [ ] **Phase 1: Context Inspector** — Tab dashboard per audit token/categoria + cruft detection delle sessioni Claude Code attive

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
- [ ] 01-05-PLAN.md — Wave 2: API endpoints (extended /api/local-sessions + /breakdown + /cruft) + claude.ts SDK tap
- [ ] 01-06-PLAN.md — Wave 3: ContextTab UI components (AggregateHeader, SessionRow, BreakdownStackedBar, CruftPanel, RecentSessionsList, DiskHygieneFooter)
- [ ] 01-07-PLAN.md — Wave 3: Polling hook with memory-leak guards + Sidebar/App route wiring
- [ ] 01-08-PLAN.md — Wave 4: Final test sweep + dashboard build + router restart + manual UAT (checkpoint:human-verify)

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Context Inspector | 4/8 | In progress | - |
