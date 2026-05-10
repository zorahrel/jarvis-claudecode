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

### Orchestrator Multi-Session (Phase 2)

#### Conductor read-only (Plan 02-01)

- [x] **ORC-01**: `GET /api/sessions/:pid/transcript?limit=N` ritorna last-N turn JSON-strutturati dal JSONL della sessione (`~/.claude/projects/-Users-.../<uuid>.jsonl`), con campi `role`, `content`, `tool_use[]`, `tool_result[]`, `stop_reason`, `timestamp` ✓ 02-01
- [x] **ORC-02**: Endpoint deriva uno `refinedStatus` per sessione: `awaiting_user_input` | `tool_pending` | `crashed` | `working` | `idle` (regole in CONTEXT.md). Aggiunto a `LocalSession` esteso o restituito accanto. ✓ 02-01
- [x] **ORC-03**: Skill `/orchestrator` (in `~/jarvis/skills-marketplace/skills/orchestrator/`) chiama `/api/local-sessions` + `/transcript` per ogni sessione e ritorna JSON con un entry per sessione: `{pid, repo, branch, status, last_assistant_summary, suggestion, action, todo_link}` ✓ 02-01
- [x] **ORC-04**: Suggestion engine genera `suggestion` umana e `action.type ∈ {inject, abort, restart, none}` deterministicamente da `refinedStatus` + ultimo turno; nessun LLM call per la suggestion ✓ 02-01
- [x] **ORC-05**: Skill output rispetta lock per `cwd` (sub-path detection) — sessioni che condividono path producono un warning `conflict: <other_pid>` e nessun action automatico ✓ 02-01

#### Reminders bridge (Plan 02-02)

- [x] **ORC-06**: Wrapper `router/src/services/reminders.ts` espone `listTodos()`, `addTodo({title, body, list})`, `completeTodo(uuid)` via `apple-reminders-cli` (preferred) o `ekctl` (fallback) con JSON I/O
- [x] **ORC-07**: Polling 3s su lista dedicata `Jarvis/ActiveTasks`; emette eventi `todo:added`, `todo:completed`, `todo:updated` sul bus interno del router
- [x] **ORC-08**: Schema body Reminders contiene linea `pid:NNNN repo:<name> phase:<plan|exec|review>` + parser bidirezionale; round-trip preserve dei campi metadata
- [x] **ORC-09**: `GET /api/todos` + `POST /api/todos` + `POST /api/todos/:uuid/complete` esposti via dashboard API; `GET` ritorna max 100 todos open ordinati per due-date
- [x] **ORC-10**: Tab "Todos" in `router/dashboard/src/pages/` mostra lista con stato live (auto-refresh 5s come Context Inspector); link per ogni todo alla sessione mappata

#### Notch HUD (Plan 02-03)

- [x] **ORC-11**: Vista Swift "Sessions sidebar" in `tray-app/Sources/JarvisNotch/` (right peek): lista compatta delle sessioni live con badge stato colorato; click apre dashboard tab Orchestrator filtrato sulla sessione ✓ 02-03
- [x] **ORC-12**: Vista Swift "Todo strip" (top o bottom thin row): top-3 todo aperti dalla lista Reminders; sempre visibile in modalità expanded ✓ 02-03
- [x] **ORC-13**: Click su todo = mark complete (chiama `POST /api/todos/:uuid/complete`); long-press = picker per riassegnare a sessione attiva (sceglie un `pid`) ✓ 02-03
- [x] **ORC-14**: Notch riceve `sessions:update` (esistente) + nuovo `todos:update` via NotchConnector subscribe/emit; reconnect graceful senza perdita di stato ✓ 02-03

#### tmux inject control (Plan 02-04)

- [ ] **ORC-15**: Endpoint `GET /api/sessions/:pid/tmux` ritorna `{has_tmux: bool, session_name?, pane_id?}` mappando pid → pane (via `tmux list-panes -aF '#{pane_pid} #{session_name} #{pane_id}'`)
- [ ] **ORC-16**: Endpoint `POST /api/sessions/:pid/inject {text, source}` esegue `tmux send-keys -t <pane_id> -- "<text>" Enter`, fallisce con 409 se sessione non sotto tmux o se lock cwd violato
- [ ] **ORC-17**: Audit log JSONL append-only in `~/.claude/jarvis/orchestrator/audit.jsonl` con `{ts, pid, repo, action, text, source}`; rotation a 10 MB
- [ ] **ORC-18**: Tab Orchestrator dashboard ha controlli "Approve" (action suggerito), "Skip" (no-op + nota), "Custom" (textarea) per ogni sessione `awaiting_user_input`; ogni click chiama `/inject` con `source: "user-approved"`
- [ ] **ORC-19**: Confirmation modal su "Approve" se la sessione è in cwd condivisa con un'altra sessione (lock conflict) — utente deve digitare `force` per procedere

#### Auto-pilot opzionale (Plan 02-05)

- [ ] **ORC-20**: Flag `auto_pilot.enabled` (default `false`) in `router/config.yaml`; hook `UserPromptSubmit` letto solo se enabled — `false` significa zero side-effects
- [ ] **ORC-21**: Budget guard: `auto_pilot.daily_token_cap` (default `100000`) controllato leggendo l'aggregato Phase 1 (`/api/sessions/aggregate`) prima di ogni auto-inject; supera = no-op + log warning
- [ ] **ORC-22**: Hook applica solo `action` con `confidence: high` (deterministico — la suggestion engine marca low/medium/high) e `source: "auto"`; ogni auto-inject scrive audit con motivazione

### Tray App (M5 proposta — superseded by Phase 2 ORC-11..14)

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
| ORC-01 | Phase 2 | Pending |
| ORC-02 | Phase 2 | Pending |
| ORC-03 | Phase 2 | Pending |
| ORC-04 | Phase 2 | Pending |
| ORC-05 | Phase 2 | Pending |
| ORC-06 | Phase 2 | Complete |
| ORC-07 | Phase 2 | Complete |
| ORC-08 | Phase 2 | Complete |
| ORC-09 | Phase 2 | Complete |
| ORC-10 | Phase 2 | Complete |
| ORC-11 | Phase 2 | Complete |
| ORC-12 | Phase 2 | Complete |
| ORC-13 | Phase 2 | Complete |
| ORC-14 | Phase 2 | Complete |
| ORC-15 | Phase 2 | Pending |
| ORC-16 | Phase 2 | Pending |
| ORC-17 | Phase 2 | Pending |
| ORC-18 | Phase 2 | Pending |
| ORC-19 | Phase 2 | Pending |
| ORC-20 | Phase 2 | Pending |
| ORC-21 | Phase 2 | Pending |
| ORC-22 | Phase 2 | Pending |

**Coverage:**
- v1 requirements: 37 total (15 Phase 1 + 22 Phase 2)
- Mapped to phases: 37
- Unmapped: 0 ✓

---
*Requirements defined: 2026-05-01*
*Source: `/Users/zorahrel/.omnara/worktrees/jarvis/omnara/mural-polio/.research/context-audit/00-PROPOSTA-context-inspector.md`*
