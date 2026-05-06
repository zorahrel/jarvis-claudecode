# Requirements: Jarvis Router — Context Inspector

**Defined:** 2026-05-01
**Core Value:** Visibility sul "cosa c'è nelle sessioni Claude Code" per identificare cruft e ridurre il baseline token

## v1 Requirements

Requirements per il MVP del Context Inspector (Phase 1). Derivati dalla proposta `00-PROPOSTA-context-inspector.md`.

### Live Sessions View (M1 della proposta)

- [ ] **CTX-01**: User vede elenco sessioni Claude Code live (router-spawned + bare CLI) nel dashboard, con identificatore route/cwd, ultimo turno, total token attuale
- [ ] **CTX-02**: User vede aggregato globale: # sessioni attive, total token su tutte, costo medio $/turno
- [ ] **CTX-03**: Per ogni sessione, bar % (live tokens / 200k) con colore threshold: blue <50% / green 50-74% / orange 75-89% / red ≥90%
- [ ] **CTX-04**: Cost $ per route (per turno) + aggregato giornaliero in footer dashboard
- [ ] **CTX-13**: Auto-refresh polling 5s, senza memory leak su sessione dashboard >10min
- [ ] **CTX-15**: Sorgente token live = SDK `task_progress.usage.total_tokens` per router-spawned, ultima riga JSONL `.usage` per bare CLI; niente tokenizer locale (no `@anthropic-ai/tokenizer`, no tiktoken)

### Breakdown per sessione (M2)

- [ ] **CTX-05**: User clicca una sessione → drill-down con stacked bar 8 categorie: system preset, built-in tools, MCP servers, skills index, CLAUDE.md chain, subagents, hooks/memory inject, conversation history. Peso in token + %
- [ ] **CTX-06**: Per CLAUDE.md, lista i file inclusi via @-import (es. SOUL.md, AGENTS.md, IDENTITY.md, MEMORY.md, USER.md, TOOLS.md) con peso individuale
- [ ] **CTX-07**: Per MCP, lista i server caricati con tools count e token estimate per ognuno
- [ ] **CTX-14**: Endpoint `GET /api/sessions/:id/breakdown` ritorna JSON strutturato con i dati del breakdown

### Cruft Detection (M3)

- [ ] **CTX-08**: Detect "MCP loaded ma non chiamato negli ultimi N turni" leggendo i tool_use events dei JSONL recenti; segnalato in UI con warning icon
- [ ] **CTX-09**: Detect "skill nell'indice ma mai invocata" sull'arco di N sessioni; segnalato in UI con suggerimento gating per agent
- [ ] **CTX-10**: Suggerimenti config split actionable (es. "split `jarvis` in `jarvis-chat` senza MCP + `jarvis-code` con MCP fullAccess") visualizzati nel pannello cruft
- [ ] **CTX-11**: Storico recente sessioni chiuse (ultime N) con: route, total token finale, # turni, # compactions
- [ ] **CTX-12**: Disk hygiene info: totale JSONL, MB occupati, # file >30 giorni

## v2 Requirements

Deferred — fasi successive.

### Tray App (M5 proposta)

- **TRAY-01**: Tray app SwiftUI mostra mini-bar token per route nel menu dropdown
- **TRAY-02**: Click su row apre dashboard tab Context con focus sulla sessione

### Push Alerts (M4 proposta)

- **ALRT-01**: Quando una sessione live supera threshold (50/75/90), push messaggio sul canale del route (TG/WA/Discord)
- **ALRT-02**: Throttle: max 1 alert per livello per sessione
- **ALRT-03**: Threshold configurabili per route in `config.yaml`

### Disk Hygiene (M6 proposta)

- **HYGI-01**: Comando CLI `jarvis cleanup-sessions --older-than 30d` per archiviare JSONL vecchi
- **HYGI-02**: Archive in `~/.claude/jarvis/archive/sessions-YYYYMM.tar.gz`

### Config Cleanup (M7 proposta — risolvere open questions Agent 2)

- **CFG-01**: Decisione su `notch.inheritUserScope` (true → false?)
- **CFG-02**: Decisione su split `jarvis-chat` vs `jarvis-code`
- **CFG-03**: Update project `CLAUDE.md` Spawn discipline post-SDK migration (rimuovere riferimenti a `buildSpawnArgs()` CLI flags)
- **CFG-04**: Audit @-import CLAUDE.md jarvis: quali load-bearing?
- **CFG-05**: Plugin marketplace disabilitati ancora indicizzati?

## Out of Scope

| Feature | Reason |
|---------|--------|
| Context optimizer automatico | Solo detection + suggerimenti; le decisioni di config le prende sempre l'umano |
| Tokenizer locale (`@anthropic-ai/tokenizer` / tiktoken) | Deprecato per Claude 3+; il SDK già emette `usage` live (Paseo-style) |
| Riscrivere discovery sessions | `localSessions/discovery.ts` esiste già e funziona; estendere, non riscrivere |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| CTX-01 | Phase 1 | Pending |
| CTX-02 | Phase 1 | Pending |
| CTX-03 | Phase 1 | Pending |
| CTX-04 | Phase 1 | Pending |
| CTX-05 | Phase 1 | Pending |
| CTX-06 | Phase 1 | Pending |
| CTX-07 | Phase 1 | Pending |
| CTX-08 | Phase 1 | Pending |
| CTX-09 | Phase 1 | Pending |
| CTX-10 | Phase 1 | Pending |
| CTX-11 | Phase 1 | Pending |
| CTX-12 | Phase 1 | Pending |
| CTX-13 | Phase 1 | Pending |
| CTX-14 | Phase 1 | Pending |
| CTX-15 | Phase 1 | Pending |

**Coverage:**
- v1 requirements: 15 total
- Mapped to phases: 15
- Unmapped: 0 ✓

---
*Requirements defined: 2026-05-01*
*Source: `/Users/zorahrel/.omnara/worktrees/jarvis/omnara/mural-polio/.research/context-audit/00-PROPOSTA-context-inspector.md`*
