# Phase 1: Context Inspector — Context

**Gathered:** 2026-05-01
**Status:** Ready for planning
**Source:** PRD Express derivation from `/Users/zorahrel/.omnara/worktrees/jarvis/omnara/mural-polio/.research/context-audit/00-PROPOSTA-context-inspector.md` (proposal accepted by user with explicit decisions on scope, threshold, cost UI)

<domain>
## Phase Boundary

Costruisce un Context Inspector come tab del dashboard Router (`router/dashboard/`) che mostra:
- Lista live di TUTTE le sessioni Claude Code attive sulla macchina (router-spawned + bare CLI)
- Token usage per sessione con threshold colore 50/75/90
- Cost $ per route + aggregato giornaliero
- Drill-down per breakdown 8 categorie (system, tools, MCP, skills, CLAUDE.md, subagents, hooks/memory, history)
- Cruft detection (MCP loaded ma non usati, skill index ma mai invocati)
- Storico recente sessioni chiuse + disk hygiene info

**FUORI scope** di questa phase (deferred a v2 per scelta utente):
- Tray app SwiftUI session view (`SessionsRowView.swift`)
- Push alerts su threshold sul canale del route (TG/WA/Discord)
- Disk cleanup wizard (archivio JSONL vecchi)
- Risoluzione delle 6 open questions di config (notch inheritUserScope, split jarvis-chat/code, doc drift CLAUDE.md, ecc.) — separate

</domain>

<decisions>
## Implementation Decisions (locked)

### Architecture
- **Target UI:** Nuovo tab "Context" nel dashboard React esistente (`router/dashboard/`). NON una pagina standalone, NON CLI-only. (Decisione confermata 2026-05-01)
- **Riuso infra:** Estendere endpoint esistente `GET /api/local-sessions` (già unifica router + bare CLI in `router/src/services/localSessions/discovery.ts`) e component `LocalSessionsSection.tsx`. NON riscrivere discovery from scratch.
- **Build:** `npm run build` in `router/dashboard/` PRIMA del restart router (vincolo da CLAUDE.md di progetto).
- **Restart:** `launchctl kickstart -k gui/$(id -u)/com.jarvis.router` (router gira sotto launchd, non pm2). Avvisare utente di query attive prima di restart (memoria utente: feedback_router_restart_inflight).

### Tokenizer
- **NO tokenizer locale.** Niente `@anthropic-ai/tokenizer` (deprecato per Claude 3+ — README ufficiale Anthropic). Niente `tiktoken` (sbagliato per Claude). Niente nuove dipendenze npm (vincolo CLAUDE.md progetto).
- **Sorgente token live router-spawned:** `SDKTaskProgressMessage.usage.total_tokens` dallo stream del SDK (`@anthropic-ai/claude-agent-sdk`). Già accessibile in-process in `router/src/services/claude.ts` Map `sessions`. Pattern confermato dall'analisi di `getpaseo/paseo` (`packages/server/src/server/agent/providers/claude-agent.ts`).
- **Sorgente token live bare CLI:** Ultima riga JSONL del transcript, campo `.usage` (input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens). Path: `~/.claude/projects/<slug>/<sessionId>.jsonl`.
- **Pre-flight per cambi config:** API REST Anthropic `count_tokens` (gratis, 100 RPM tier 1). Solo per stimare baseline al cambio config, non per il monitoring live.
- **UI istantanea draft:** `chars / 3.5` (errore ~4% misurato su realistic CLAUDE.md+tools blob).

### Threshold colori (3 livelli, scelta utente più aggressiva di paseo-mac 70/90)
- `< 50%` → blue/green (safe)
- `50-74%` → green→yellow transition (warn)
- `75-89%` → orange (crit, scatta PRIMA della compaction Claude Code che parte all'80%)
- `≥ 90%` → red (panic)

### Cost tracking
- **Visibile in UI:** sì, sia per-route (per-turno medio) sia aggregato (giornaliero in footer).
- **Formula:** `cost = cache_read*0.10 + cache_write_5min*1.25 + cache_write_1h*2.00 + fresh_input*1.0 + output*output_rate` applicata al rate del modello.
- **Rates pricing (verificati 2026-05):**
  - Sonnet 4.6: input $3/MTok, output $15/MTok
  - Opus 4.7: input $5/MTok, output $25/MTok
- **Sorgente dati cache:** event `result` del SDK include `cache_creation_input_tokens` e `cache_read_input_tokens` (già loggati in `claude.ts`).

### Breakdown 8 categorie
A spawn-time, calcolare e persistere il breakdown stimato (chars × 0.25 ≈ tokens) per ognuna:
1. **System preset** Claude Code (~3-5k)
2. **Built-in tools** schemas (~5-8k)
3. **MCP servers** (per ogni server: tools count + token estimate; con `fullAccess: true` → tutti i 13)
4. **Skills index** (jarvis-marketplace 29 + user 3 + plugin marketplace; gsd:* namespace 50+ → ~2.5k da solo)
5. **CLAUDE.md chain** (con espansione `@`-imports: SOUL/AGENTS/IDENTITY/MEMORY/USER/TOOLS)
6. **Subagents index** (.claude/agents/*.md, 18 GSD se inheritUserScope=true)
7. **Hooks/Memory inject** (OMEGA auto_capture variabile per turno)
8. **Conversation history** (delta dal total_tokens live − somma delle altre 7 categorie)

### Endpoint nuovi
- `GET /api/sessions/:id/breakdown` → JSON con i dati del breakdown (categorie + dettagli MCP + dettagli @-import)
- `GET /api/sessions/cruft` → JSON con cruft detection (MCP non chiamati, skill non invocate, suggerimenti config)
- `GET /api/local-sessions` → estendere risposta esistente con `liveTokens`, `lastTurnCost`, `compactionCount`, `disk: { total_mb, total_jsonl, files_older_30d }`

### Polling
- **Frequenza:** 5s
- **Vincolo:** no memory leak su sessione dashboard >10min (test esplicito)
- **Implementation:** `setInterval` in React component, cleanup su unmount

### Disk hygiene info (display only, no actions)
- Total JSONL count
- Total MB occupati in `~/.claude/projects/`
- # file con mtime > 30 giorni
- Baseline 2026-05-01: 2012 JSONL / 986 MB

### Cruft Detection logic
- Per ogni route attivo, leggere ultimi N turni (N=5 default) dal JSONL
- Estrarre `tool_use` events
- Confrontare con MCP servers caricati per quel route (da `agent.yaml` + ramo `fullAccess`)
- "MCP loaded ma 0 chiamate" → segnalato con warning icon
- "Skill nell'indice ma 0 invocazioni" → idem
- Suggerimenti hardcoded basati sulle 6 open questions del report 02 (es. "split jarvis-chat senza MCP fullAccess").

### Claude's Discretion
- Implementazione esatta del component React (struttura props, hook personalizzati, libreria UI per stacked bar)
- Decisione tra polling client vs SSE/WebSocket per live update (raccomandato polling 5s per semplicità)
- Schema esatto JSON delle response API
- Storage: il breakdown a spawn-time va persistito (file? in-memory Map?) o ricalcolato on-demand?
- Test strategy: snapshot react-testing-library, integration su discovery
- Naming preciso file/componenti React e funzioni TypeScript

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Proposta principale (decisioni locked)
- `/Users/zorahrel/.omnara/worktrees/jarvis/omnara/mural-polio/.research/context-audit/00-PROPOSTA-context-inspector.md` — proposta + decisioni confermate + mockup UI testuale + piano fasi

### Research (sintesi nei 4 file)
- `/Users/zorahrel/.omnara/worktrees/jarvis/omnara/mural-polio/.research/context-audit/01-competitor-ux-scan.md` — Pattern UX da Paseo + Claude Code `/context` + OpenCode + Cursor + Cline + Aider
- `/Users/zorahrel/.omnara/worktrees/jarvis/omnara/mural-polio/.research/context-audit/02-jarvis-session-anatomy.md` — Anatomia spawn 8 categorie + per-route variation table + 6 open questions
- `/Users/zorahrel/.omnara/worktrees/jarvis/omnara/mural-polio/.research/context-audit/03-session-discovery.md` — Discovery filesystem + endpoints API esistenti + algoritmo list-all-sessions
- `/Users/zorahrel/.omnara/worktrees/jarvis/omnara/mural-polio/.research/context-audit/04-tokenizer-cost.md` — Cache cost math + raccomandazione SDK signal

### Codebase chiave (LEGGERE prima di toccare)
- `/Users/zorahrel/.omnara/worktrees/jarvis/omnara/mural-polio/router/src/services/claude.ts` — `buildSdkOptions()` linee 412-483, Map `sessions` linee ~316/629, compaction logic
- `/Users/zorahrel/.omnara/worktrees/jarvis/omnara/mural-polio/router/src/services/localSessions/discovery.ts` — discovery sessioni router + bare
- `/Users/zorahrel/.omnara/worktrees/jarvis/omnara/mural-polio/router/src/services/localSessions/hooksInstaller.ts` — hook script `~/.claude/jarvis/events/<pid>.json`
- `/Users/zorahrel/.omnara/worktrees/jarvis/omnara/mural-polio/router/src/dashboard/api.ts` linee 1983-2014 — endpoint `/api/local-sessions`
- `/Users/zorahrel/.omnara/worktrees/jarvis/omnara/mural-polio/router/dashboard/src/components/LocalSessionsSection.tsx` — UI esistente da estendere
- `/Users/zorahrel/.omnara/worktrees/jarvis/omnara/mural-polio/CLAUDE.md` — vincoli di progetto (NO Bun, NO Docker, NO npm deps senza ragione, NO --append-system-prompt, restart launchctl, dashboard build prima del restart)

### Project rules
- `~/.claude/CLAUDE.md` — user-global rules (italiano, mai inviare email senza conferma, ecc.)
- `~/.claude/jarvis/agents/_shared/TOOLS.md` — tools cheat sheet (gws-mail, whisper, router commands)

</canonical_refs>

<specifics>
## Specific Ideas

### Mockup UI confermato (vedi proposta sezione 4)

```
┌─ Tab "Context" ─────────────────────────────────────┐
│ AGGREGATO LIVE                                      │
│ N sessioni  |  XXk tok totali  |  $X.XXX/turno     │
│ Disco: ZZZ MB · NNNN JSONL · ⚠ K file >30g          │
└─────────────────────────────────────────────────────┘

┌─ Per route (live) ──────────────────────────────────┐
│ 🟢 jarvis    [████░░░░] 89k/200k  44%  $0.0042 TG │
│ 🟡 business  [████████░] 142k/200k 71%  $0.0091  ⚠ │
│ ⚫ matteo    idle                                    │
└─────────────────────────────────────────────────────┘

┌─ Breakdown sessione selezionata ────────────────────┐
│ ████   System preset            5.2k   6%  ▓ base  │
│ ████   Built-in tools           5.8k   7%  ▓ base  │
│ █████  MCP (13 servers)        14.1k  16%  ⚠ split │
│ ██     Skills index             3.0k   3%  ⚠ gsd:* │
│ ██     CLAUDE.md chain          5.6k   6%  ✓       │
│ █      Subagents (18 GSD)       1.0k   1%  ⚠ unused│
│ █      Hooks/OMEGA inject       0.8k   1%          │
│ █████████  History             53.1k  60%  ▒ user  │
└─────────────────────────────────────────────────────┘

┌─ 💡 Cruft detection ────────────────────────────────┐
│ - gsd:* = 2.5k tok ma 0 invocazioni ultimi 50 turni │
│ - 7 MCP caricati, 0 chiamate ultimi 5 turni         │
└─────────────────────────────────────────────────────┘
```

### Pattern UX rubati dai competitor
- **Stacked bar headline + drill-down hover** — da Claude Code `/context`, ma reso non-verboso
- **Threshold 4 colori** — da paseo-mac (`UsagePanel.swift`), ma più granulare
- **Persistent token/% per route** — da OpenCode TUI bottom-bar
- **Cost $ inline per turno** — da paseo-mac `UsageChip` in `ConversationView.swift`

### Anti-pattern da evitare
- **Cline bug** ([#7383](https://github.com/cline/cline/issues/7383)): UI a 50% mentre API a 200K — silent failure. Mitigation: usare SDK signal authoritative, non stima.
- **Cursor regression** v2.2.44: rimosso token counter → uproar utenti. Mitigation: il counter è first-class feature, non rimuovibile.
- **Claude Code `/context` verbosity** ([#27592](https://github.com/anthropics/claude-code/issues/27592)): drill-down non auto-aperto. Mitigation: headline first, drill-down on click.

</specifics>

<deferred>
## Deferred Ideas

### Fuori scope MVP (decisioni utente confermate)
- **Tray app session view (M5):** nuovo `SessionsRowView.swift` in `tray-app/` — fase successiva
- **Push alerts su canale (M4):** notifica TG/WA/Discord oltre threshold — fase successiva
- **Disk hygiene wizard (M6):** comando `jarvis cleanup-sessions --older-than 30d` — fase successiva
- **Config cleanup (M7):** risolvere 6 open questions Agent 2 (notch inheritUserScope, split jarvis chat/code, ecc.) — fase successiva, evidence-based dopo aver visto il dashboard
- **Update doc drift project CLAUDE.md** (buildSpawnArgs → buildSdkOptions): nice-to-have, non bloccante per Phase 1, già nei todo

### Out-of-scope permanente
- Tokenizer locale (deprecato + non necessario con SDK signal)
- Riscrittura discovery (esiste già in `localSessions/discovery.ts`)
- Context optimizer automatico (solo detection + suggestions, decisioni sempre umane)
- Aggiunta dipendenze npm

</deferred>

---

*Phase: 01-context-inspector*
*Context gathered: 2026-05-01 derived from research + accepted proposal*
