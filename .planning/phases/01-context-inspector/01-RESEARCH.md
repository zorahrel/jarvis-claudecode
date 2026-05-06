# Phase 1: Context Inspector — Research

**Compiled:** 2026-05-01
**Source:** Synthesis of 4 parallel research agents (raw outputs in `/Users/zorahrel/.omnara/worktrees/jarvis/omnara/mural-polio/.research/context-audit/0[1-4]-*.md`)

## RESEARCH COMPLETE

---

## TL;DR

- **Tokenizer strategy = Paseo-style:** lettura `SDKTaskProgressMessage.usage.total_tokens` dallo stream SDK (router-spawned) + ultima riga JSONL `.usage` (bare CLI). Niente tokenizer locale (`@anthropic-ai/tokenizer` deprecato per Claude 3+).
- **L'infra discovery esiste:** `GET /api/local-sessions` + `localSessions/discovery.ts` + `LocalSessionsSection.tsx` già unificano router + bare CLI. Il lavoro vero è il **breakdown** sopra a quello che esiste.
- **Baseline range osservato:** jarvis fullAccess 22-28k tok vs cecilia lean 5-6k → **4× spread**. La vista deve rendere queste differenze visibili.
- **Pattern UX gold standard:** Claude Code `/context` 9 categorie + OpenCode bottom-bar persistente + paseo-mac threshold colors. Antipattern: Cline silent failure (#7383), Cursor regression (#2.2.44).

---

## 1. Anatomia della sessione (cosa va dentro)

Da `02-jarvis-session-anatomy.md`. Una sessione Claude Code spawn-ata dal router contiene 8 contributors, in ordine di peso tipico:

| # | Categoria | Sorgente | Token tipici | Per-agent variation |
|---|-----------|----------|--------------|---------------------|
| 1 | System preset (`claude_code`) | SDK `@anthropic-ai/claude-agent-sdk` | 3-5k | ~costante |
| 2 | Built-in tools schemas | preset (Read/Write/Edit/Bash/...) | 5-8k | ~costante |
| 3 | MCP servers tool catalogs | `mcpServers` in SDK options | 10-15k (fullAccess) / 0-3k (scoped) | dipende da `agent.yaml.tools` + `fullAccess` |
| 4 | Skills index | `~/.claude/plugins/`, `~/.claude/skills/`, jarvis-marketplace | 2-3k | costante (ma `gsd:*` da solo 2.5k) |
| 5 | CLAUDE.md chain | `settingSources` + `@`-imports recursive | 1-6k | inheritUserScope true=6k, false=1k |
| 6 | Subagents index | `~/.claude/agents/*.md` (18 GSD) | ~1k | inheritUserScope=true only |
| 7 | Hooks output (OMEGA inject) | `UserPromptSubmit` + `PostToolUse` hooks | 0.5-2k per turno | inheritUserScope=true only |
| 8 | Conversation history | session JSONL accumula | varia 0→160k | massimo prima di compaction (80%) |

**Spawn flags chiave** (da `claude.ts:buildSdkOptions` 412-483):
- `strictMcpConfig: true` — sempre on, blocca leak MCP da `~/.claude.json`
- `settingSources: ["user","project","local"]` — full chain. Override per route con `inheritUserScope: false` → `["project","local"]`
- `permissionMode`: `bypassPermissions` (fullAccess) o `acceptEdits` (readonly)
- `mcpServers`: con `fullAccess: true` tutti i 13, altrimenti subset esplicito
- `systemPrompt: { type: "preset", preset: "claude_code", excludeDynamicSections: true }`

**Tabella per-route** (snapshot live 2026-05-01):

| Agent | inheritUserScope | fileAccess | MCP loaded | Hooks | Subagents | Baseline est. |
|-------|------------------|------------|------------|-------|-----------|---------------|
| jarvis | true | full | 13 | yes | 18 GSD | **22-28k** |
| notch | true | readonly | 13 | yes | 18 | 18-22k |
| business | false | full | 7 | NO | NO | 10-14k |
| matteo | false | readonly | 2 | NO | NO | 6-8k |
| cecilia | false | readonly | 0 | NO | NO | **5-6k** |
| fatima | false | readonly | 2 | NO | NO | 6-8k |
| simone | false | full | 4 | NO | NO | 9-11k |

**Doc drift segnalato:** project `CLAUDE.md` referenzia ancora `buildSpawnArgs()` (CLI flags). La migrazione SDK è del 2026-04 (memoria utente: project_sdk_migration). Da fixare separatamente.

---

## 2. Discovery — come trovare le sessioni live

Da `03-session-discovery.md`.

### Disk layout
- Root: `~/.claude/projects/<slug>/`
- Slug encoding: `'-' + cwd.replace(/\//g, '-')` (non perfettamente invertibile — sempre leggere `cwd` da una riga JSONL anziché ricostruirlo)
- Transcript: `~/.claude/projects/<slug>/<sessionId>.jsonl`
- Subagent transcripts (separati): `~/.claude/projects/<slug>/<sessionId>/subagents/agent-<hash>.jsonl`
- Compaction markers: inline JSONL come righe `type:"user"` con `isCompactSummary:true` e `isVisibleInTranscriptOnly:true`. Nessun file separato.

### Process discovery (macOS)
```bash
# List Claude CLI PIDs
pgrep -lf claude

# CWD del processo (path assoluto richiesto sotto launchd!)
/usr/sbin/lsof -a -p <pid> -d cwd -Fn

# ENV (per JARVIS_SPAWN, JARVIS_SESSION_KEY)
ps eww <pid>
```

### Distinguere router-spawned vs bare
- env var `JARVIS_SPAWN=1` (settato in `services/claude.ts:156`)
- Fallback: `args.includes(".claude/jarvis/router")` perché il SDK gira sotto la root del router

### API esistente (riusare!)
- **`GET http://127.0.0.1:3340/api/local-sessions`** → `LocalSession[]` unificato. Dashboard endpoint definito in `router/src/dashboard/api.ts:1983-2014`.
- Il router mantiene `Map<sessionId, SdkSession>` in-process in `claude.ts`
- Hook script alimenta `~/.claude/jarvis/events/<pid>.json` (status, scade dopo 24h, 172 file live al baseline)
- File `~/.claude/jarvis/router/cli-sessions.json` è dead-letter pre-SDK migration → ignorare

### Snapshot live (2026-05-01)
- 6 sessioni Claude CLI attive (1 router `notch`, 5 bare)
- 2012 JSONL totali, 986 MB su disco
- 27 file modificati negli ultimi 30 min
- 359 JSONL solo nello slug jarvis (biggest 180 KB)

### Gap noto
- `SdkSession.pid` è sempre `null` (`claude.ts:316,629`) — il SDK gestisce il subprocess. Per correlare router-key ↔ PID disco serve leggere `JARVIS_SESSION_KEY` dall'env del processo.
- Tray app NON ha session view (`tray-app/Sources/JarvisTray/`) — fuori scope MVP.

### Algoritmo list-all-sessions (pseudo-code)
```ts
async function listAllSessions(): Promise<LocalSession[]> {
  const router = await readRouterState();    // claude.ts sessions Map
  const events = await readEventsDir();       // ~/.claude/jarvis/events/*.json
  const processes = await psClaudeCli();      // pgrep + lsof + ps eww
  const projects = await scanProjectsDir();   // ~/.claude/projects/*/
  return mergeBy(['cwd','sessionId'], router, events, processes, projects);
}
```

---

## 3. Tokenizer + cost — la "killer finding"

Da `04-tokenizer-cost.md`.

### Discovery cardine
**`@anthropic-ai/claude-agent-sdk` (v0.2.126) emette `SDKTaskProgressMessage` con `usage.total_tokens`** — Claude Code stesso ci dice il context fill live, in stream. **Paseo lo usa esattamente così** (`packages/server/src/server/agent/providers/claude-agent.ts:3230-3274`). Non serve tokenizer locale per il monitoring delle sessioni router-spawned.

Per bare CLI: l'ultima riga `assistant` del JSONL contiene `usage` (input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens). Lettura O(1) tail-style.

### Strategia ibrida raccomandata
| Caso | Sorgente | Costo | Latency |
|------|----------|-------|---------|
| Live (router-spawned) | `task_progress.usage.total_tokens` | 0 | event-driven, stream |
| Live (bare CLI) | tail JSONL `.usage` | 0 (file I/O) | <10ms |
| Pre-flight (cambio config) | `count_tokens` REST API | 0 (rate-limited 100 RPM tier 1) | 150-400ms (EU, sospettato) |
| UI istantanea (draft input) | `chars / 3.5` | 0 | 0 |

### Approssimazione accuracy
| Method | Avg error vs API | Note |
|--------|------------------|------|
| `chars / 3.5` | 4% under (realistic CLAUDE.md+tools blob) | rough but stable |
| `chars / 4` | maggiore | OpenAI rule, sotto-stima per Claude |
| `tiktoken cl100k_base` | 10% under | tokenizer wrong family |
| `@anthropic-ai/tokenizer` | DEPRECATO | "no longer accurate" — Anthropic README ufficiale |

### Cache cost multipliers (verificati)
- 5min cache write: **1.25× input rate**
- 1h cache write: **2.00× input rate**
- Cache read: **0.10× input rate**
- Minimum cacheable: 4096 tok (Opus 4.7), 2048 tok (Sonnet 4.6), 1024 tok (Sonnet 4.5)

### Pricing (2026-05)
- Sonnet 4.6: input $3/MTok, output $15/MTok → cache write $3.75, cache read $0.30
- Opus 4.7: input $5/MTok, output $25/MTok → cache write $6.25, cache read $0.50

### Formula completa
```ts
costPerTurn(usage: Usage, model: 'sonnet'|'opus'): number {
  const r = model === 'opus' ? { in: 5, out: 25 } : { in: 3, out: 15 };
  return (
    usage.cache_read_input_tokens   * r.in * 0.10 +
    usage.cache_creation_5m_tokens  * r.in * 1.25 +
    usage.cache_creation_1h_tokens  * r.in * 2.00 +
    usage.input_tokens              * r.in * 1.00 +
    usage.output_tokens             * r.out
  ) / 1_000_000;
}
```

### Competitor token strategy
| Tool | Lib | Note |
|------|-----|------|
| **Paseo** | SDK signal | nostro modello |
| Cline | `Math.ceil(text.length/4)` | accuracy chosen lower for binary size |
| Cline (Anthropic provider) | response.usage | SDK-faithful when available |
| Continue.dev | js-tiktoken cl100k | wrong tokenizer for Claude |
| Aider | litellm.token_counter | provider-agnostic |
| Cursor | closed source | unverified |

### Open questions (non bloccanti)
- Claude Code TTL cache esatto (likely 5min ephemeral, da verificare con request capture)
- Latency `count_tokens` API da EU (sospettato 150-400ms, da misurare)
- No tokenizer Swift per Claude (confermato: per il tray app M5 si chiama back il router via HTTP)

---

## 4. Pattern UX dai competitor

Da `01-competitor-ux-scan.md`. 9 tool analizzati, ranking per rilevanza:

### Gold standard — Claude Code `/context`
9-categorie grid: System / System tools / MCP / MCP-deferred / System-deferred / Memory / Skills / Messages / Free / Autocompact buffer. Per ogni MCP: tool weights individuali. Per skills: vista `/skills` sortable by token count.
- **Pro:** completezza, per-tool granularity, sortable
- **Con:** verboso ([#27592](https://github.com/anthropics/claude-code/issues/27592)), non persistente ([#52794](https://github.com/anthropics/claude-code/issues/52794))
- **Da rubare:** la struttura dati delle 9 categorie (noi semplifichiamo a 8 collassando Memory in Hooks/Memory)

### Pattern più imitato — OpenCode TUI bottom-bar
Persistente: `x tokens / x% / $0.00 spend`. Mancante in Desktop ([#5892](https://github.com/sst/opencode/issues/5892)).
- **Da rubare:** bottom-bar persistente nel dashboard (footer aggregato)

### Threshold colors — paseo-mac `UsagePanel.swift`
Linear bar + soglie 70%/90% blue/orange/red. È plan quota, non session context, ma il pattern UX è giusto.
- **Da rubare:** threshold colors (noi più aggressivi: 50/75/90)

### Per-turn chip — paseo-mac `UsageChip` in `ConversationView.swift`
"1.2k/100k" + circular progress + tooltip con input/cached/output/cost.
- **Da rubare:** chip granulare per turno (fase 2)

### Cline bar (con bug) — fonte di anti-pattern
Bar in alto chat pane. Bug grave: UI 50% mentre API a 200K → silent failure ([#7383](https://github.com/cline/cline/issues/7383)).
- **Lesson:** mai stimare quando hai dato authoritative. Usiamo SDK signal.

### Aider — minimalista
`/tokens` + `/map` testuali. Accurato perché possiede ciò che inietta.
- **Lesson:** semplicità ha valore, ma noi abbiamo più superfici (dashboard/tray) quindi UI ricca è giustificata.

### Lagging
- Codex CLI: niente
- Roo Code: niente
- Cursor: regredito (rimosso v2.2.44)

### Top 3 pattern per Jarvis
1. **Claude Code categorical breakdown** rendered come stacked bar con hover/drill-down (risolve verbosità #27592)
2. **OpenCode-style persistent `tokens / % / $`** per-route in dashboard sidebar
3. **Push threshold alerts** sul canale del route (M4 deferred — vantaggio Jarvis unico vs competitor single-surface)

---

## 5. Validation Architecture (Nyquist)

> **Nota:** Questo lavoro è UI-heavy con backend logic; la validation primaria è visual/integration test sui component React + unit test sulle funzioni di calcolo breakdown e cost.

### Test layers
- **Unit (Vitest)** — funzioni pure: `calculateBreakdown(spawnConfig)`, `costPerTurn(usage, model)`, `detectCruft(toolUseEvents, mcpsLoaded)`, `colorForThreshold(pct)`. Target coverage: 90%+.
- **Integration (Vitest)** — endpoints `/api/local-sessions`, `/api/sessions/:id/breakdown`, `/api/sessions/cruft` con sessioni di test fittizie su filesystem temporaneo.
- **E2E component (Playwright)** — apri dashboard `localhost:3340` tab Context, verifica:
  - Lista sessioni live presenti (almeno 1 router + 1 bare)
  - Bar % con colore corretto al threshold
  - Click su sessione → drill-down rendering 8 categorie
  - Polling 5s aggiorna i numeri
  - Auto-refresh non leak memory dopo 10min (heap snapshot before/after)
- **Performance** — `/performance/spec.md` (vincolo CLAUDE.md utente): CLS < 0.1, load time < 2s, layout shift assente al primo render

### Non-goals nella validation
- Accuracy esatta del tokenizer (usiamo SDK signal, è authoritative by definition)
- Test su 200k sessions con compaction reale (skip — usiamo sessioni mock con `usage` plausibile)

### Acceptance criteria mapping
- CTX-01..CTX-15 → ognuno mappato a uno o più test (definizione esatta nel PLAN)

---

## 6. Project rules da rispettare (vincoli noti)

Da `CLAUDE.md` di progetto e memoria utente:

1. **NO Bun**, usa Node + tsx. Spawn via `child_process`.
2. **NO Docker**.
3. **NO npm dependencies senza buona ragione.** Per Phase 1 questo vincolo è centrale: nessuna nuova lib (no tokenizer, no chart libs pesanti). Riusare quello che c'è in `router/dashboard/`.
4. **TypeScript clean:** `npx tsc --noEmit` deve passare prima del restart.
5. **Dashboard build:** `npm run build` in `router/dashboard/` PRIMA del restart router.
6. **Restart router:** `launchctl kickstart -k gui/$(id -u)/com.jarvis.router`. **AVVISARE utente** di query attive prima del kickstart (memoria: feedback_router_restart_inflight) — il kickstart killa risposte in volo.
7. **NO --append-system-prompt** (memoria: project_orchestrator_skill).
8. **CLAUDE.md scoping:** non aggiungere terzo layer. Solo user-global + agent-specific.
9. **Performance spec obbligatoria:** ogni progetto deve includere `performance/spec.md` (CLS, load time, layout shift).
10. **Spec-first se openspec/ esiste:** questo progetto NON ha openspec/, quindi GSD-flow vincolante.
11. **Atomic commits via GSD executor.** Commits no Co-Authored-By Claude (memoria: feedback_no_claude_coauthor).
12. **Italiano** nei commit messages e UI labels (memoria: User preferences Italian).

---

## 7. Risk register

| Rischio | Mitigation |
|---------|------------|
| SDK signal `task_progress.usage` non emette per ogni turno | Fallback: leggere `result` event finale + ultima riga JSONL. Test esplicito con sessione live. |
| Polling 5s causa memory leak su dashboard tenuto aperto a lungo | Test acceptance: heap snapshot dopo 10min. Cleanup interval su unmount. |
| Breakdown stimato diverge dal reale total tokens | Calcolare history come delta (total - somma 7 categorie note). Mai mostrare percentuali che non sommano a 100. |
| Bare CLI session con JSONL gigante (>50MB) blocca UI | Tail-only read, mai full parse. |
| Cost calculation drift su Sonnet 4.7 (futuro) | Tabella rates in config file, non hardcoded. |
| Token count non aggiornato quando sessione idle | UI mostra `last update X sec ago` + indicatore "stale". |
| 13 MCP server → tools schema cambia → estimate drift | Calcolo MCP weight on-demand leggendo `~/.claude.json` + tools listing real-time. |
| User scope `inheritUserScope: true` su notch è cruft confermato — il dashboard lo rivelerà | Questa è una FEATURE: il cruft detection deve segnalarlo. Risoluzione config separata (M7 fuori scope). |

---

## RESEARCH COMPLETE

Tutti i dati, formula, pattern UX, file paths, vincoli noti per partire al planner. Open questions di config (notch inheritUserScope, split jarvis-chat/code, doc drift) sono FUORI scope di Phase 1 — il loro luogo è il prossimo round dopo che il dashboard mostra le evidence.
