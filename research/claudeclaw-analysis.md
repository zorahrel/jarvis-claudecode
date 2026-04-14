# ClaudeClaw Source Analysis

> Analisi del codice sorgente in `~/.claude/plugins/cache/claudeclaw/claudeclaw/1.0.0/src/`
> Obiettivo: capire cosa portare nel nostro router custom (`~/.claude/jarvis/router/`)

---

## 1. Daemon System

### Come funziona
- **PID file** in `.claude/claudeclaw/daemon.pid` — scrive il PID al boot, controlla se il processo è vivo con `process.kill(pid, 0)`
- **Stale cleanup**: se il PID file esiste ma il processo è morto, lo cancella automaticamente
- **Signal handling**: SIGTERM/SIGINT → teardown statusline, cleanup PID, stop web/discord, exit
- **`--replace-existing`**: manda SIGTERM al daemon attivo, aspetta fino a 4s, poi prende il suo posto
- **Bootstrap**: alla partenza crea subito una sessione Claude Code con un prompt iniziale ("Wakeup, my friend!")
- **Hot-reload**: ogni 30s rilegge `settings.json` e `jobs/` per detect cambiamenti senza restart

### Essenziale per il router
- ✅ PID management con stale cleanup — necessario per evitare doppi daemon
- ✅ Signal handling con graceful shutdown
- ✅ Hot-reload config ogni 30s — molto utile per cambiare settings senza restart

### Nice-to-have
- `--replace-existing` flag
- Statusline CJS script per Claude Code UI

### Non serve
- La statusline `.cjs` script — noi non usiamo Claude Code come IDE

---

## 2. Cron Jobs

### Come funziona
- **Job files**: `.claude/claudeclaw/jobs/*.md` con frontmatter YAML:
  ```yaml
  ---
  schedule: "0 9 * * *"
  recurring: true
  notify: true|false|"error"
  ---
  Il prompt qui sotto
  ```
- **Cron parser custom** (`cron.ts`): supporta `*/N`, ranges `1-5`, liste `1,3,5`, wildcard `*`
- **Timezone-aware**: shifta la data UTC con l'offset configurato prima del match
- **Tick ogni 60s**: nel main loop, controlla ogni job se il cron matcha il minuto corrente
- **One-time jobs**: se `recurring: false`, dopo l'esecuzione cancella la riga `schedule:` dal frontmatter
- **Notify**: `true` = forward sempre, `false` = mai, `"error"` = solo se exit code ≠ 0
- **Prompt resolution**: se il prompt finisce con `.md`/`.txt`/`.prompt`, legge il file

### Essenziale per il router
- ✅ Cron matching con timezone — il nostro router ne ha bisogno
- ✅ Job files in markdown con frontmatter — formato pulito e human-editable
- ✅ Notify strategy (true/false/error)

### Nice-to-have
- One-time jobs con auto-clear schedule
- Prompt file resolution

### Non serve
- Il cron parser custom — possiamo usare `croner` o `node-cron` che sono più robusti

---

## 3. Heartbeat

### Come funziona
- **Config**: `heartbeat.enabled`, `heartbeat.interval` (minuti), `heartbeat.prompt`, `heartbeat.forwardToTelegram`
- **Exclude windows**: array di `{ days: [0-6], start: "HH:MM", end: "HH:MM" }` — quiet hours con supporto overnight
- **Prompt template**: carica `HEARTBEAT.md` dal plugin, con override progetto in `.claude/claudeclaw/prompts/HEARTBEAT.md`
- **Merge**: template + user prompt custom vengono concatenati
- **Scheduling**: dopo ogni tick, calcola il prossimo slot ammesso (skippa exclude windows)
- **Forward**: se `forwardToTelegram: true` OPPURE se la risposta non inizia con `HEARTBEAT_OK`, forwarda a Telegram/Discord
- **HEARTBEAT_OK convention**: Claude può rispondere "HEARTBEAT_OK" per indicare "niente da segnalare" → non viene forwardata

### Essenziale per il router
- ✅ Exclude windows con timezone — le quiet hours sono fondamentali
- ✅ Forward condizionale basato su risposta

### Nice-to-have
- Prompt template con project-level override
- Convention HEARTBEAT_OK

### Non serve
- Il sistema di heartbeat intero se usiamo OpenClaw heartbeat nativo

---

## 4. Telegram Integration

### Come funziona
- **Long polling** con `getUpdates` (timeout 30s, no webhook)
- **Auth**: `allowedUserIds: number[]` — se vuoto, accetta tutti
- **Gruppi**: risponde solo se:
  - Reply to bot message
  - @mention nel testo o nelle entities
  - Bare bot command (`/cmd`)
  - Scoped command (`/cmd@botname`)
- **Comandi built-in**: `/start`, `/reset` (reset session), `/compact`, `/status`, `/context` (token usage con progress bar)
- **Media handling**:
  - Foto: scarica la più grande, passa il path a Claude
  - Voice/audio: scarica, converte OGG→WAV, trascrive con whisper.cpp o STT API esterna
  - Documenti: PDF, DOCX, XLSX, plain text — scarica e passa path
- **Markdown→HTML**: converter custom per Telegram (bold, italic, code, links, code blocks)
- **Chunking**: messaggi > 4096 chars vengono spezzati
- **Reactions**: `[react:emoji]` nel response di Claude → `setMessageReaction` API
- **File sending**: `[send-file:/path/to/file]` → `sendDocument` API
- **Typing indicator**: loop ogni 4s finché Claude lavora
- **Skill routing**: `/command` → cerca `SKILL.md` in project/global/plugin skills dirs
- **Bot commands menu**: registra dinamicamente tutti gli skill come comandi Telegram
- **Secretary integration**: callback query per bottoni yes/no su un endpoint locale `:9999`
- **Group join event**: quando aggiunto a un gruppo, chiede a Claude di scrivere un messaggio di benvenuto

### Essenziale per il router
- ✅ Long polling con retry su errore (sleep 5s)
- ✅ AllowedUserIds filtering
- ✅ Group trigger detection (reply/mention/command)
- ✅ Typing indicator loop
- ✅ Chunking a 4096 chars
- ✅ Markdown→HTML conversion

### Nice-to-have
- Voice transcription (whisper.cpp integration)
- Skill routing via slash commands
- Secretary callback queries
- `/context` con progress bar token usage

### Non serve
- L'intero Telegram handler — noi usiamo OpenClaw come transport layer, non raw Telegram API

---

## 5. Discord Integration

### Come funziona
- **WebSocket Gateway** (non polling) con reconnect/resume automatico
- **Intents**: GUILDS, GUILD_MESSAGES, GUILD_MESSAGE_REACTIONS, DIRECT_MESSAGES, MESSAGE_CONTENT
- **Auth**: `allowedUserIds: string[]` (snowflake IDs come stringhe per precision >2^53)
- **Listen channels**: `listenChannels: string[]` — canali dove risponde a TUTTI i messaggi senza mention
- **Thread sessions**: ogni thread Discord ha una sessione Claude Code indipendente (`sessionManager.ts`)
  - I thread sono creati via AI intent classification (es: "hire X" crea un thread, "fire X" lo elimina)
  - `classifyThreadIntent` usa `claude --model sonnet` in subprocess per capire l'intento
- **Trigger logic**: mention, reply to bot, listen channel, thread in listen channel parent
- **Slash commands**: `/start`, `/reset`, `/compact`, `/status`, `/context` — registrati globalmente via REST API
- **Attachments**: immagini e voice (con flag IS_VOICE_MESSAGE)
- **Rate limiting**: retry con `retry_after` header
- **Reconnect**: resume se ha session_id + sequence, altrimenti full reconnect. Non riconnette su fatal codes (4004, 4010, etc)
- **Thread persistence**: `sessions.json` per thread→session mapping, rejoin automatico al boot

### Essenziale per il router
- ✅ Thread-based sessions — pattern potente per conversazioni parallele
- ✅ Listen channels concept
- ✅ Snowflake ID handling (stringhe, non numeri)

### Nice-to-have
- AI-powered thread management (hire/fire)
- Slash command registration
- Gateway reconnect/resume

### Non serve
- Il gateway WebSocket intero — noi usiamo OpenClaw come transport

---

## 6. Session Management

### Come funziona
- **Global session** (`sessions.ts`): un singolo `session.json` con:
  ```json
  { "sessionId": "...", "createdAt": "...", "lastUsedAt": "...", "turnCount": 0, "compactWarned": false }
  ```
- **Thread sessions** (`sessionManager.ts`): `sessions.json` con `threads: { [threadId]: ThreadSession }`
- **Turn counting**: incrementa dopo ogni risposta success (exitCode 0)
- **Compact warning**: a 25 turns, emette evento "warn" (una volta sola per sessione)
- **Auto-compact on timeout**: se Claude esce con exit code 124 (timeout), esegue `/compact` e riprova
- **Session backup**: `backupSession()` rinomina `session.json` in `session_N.backup`
- **Serial queue**: le richieste non-thread sono serializzate (no concurrent `--resume`). Thread hanno code parallele indipendenti
- **New session**: usa `--output-format json` per catturare `session_id` dal response. Resumed: usa `--output-format text` con `--resume`

### Essenziale per il router
- ✅ Turn counting con compact warning threshold — previene context overflow
- ✅ Auto-compact on timeout + retry — resilienza
- ✅ Serial queue per sessione — evita race condition su `--resume`
- ✅ Thread-based parallel sessions

### Nice-to-have
- Session backup con numerazione incrementale
- Compact event listeners

### Non serve
- Il dettaglio implementativo del JSON parsing per session_id — dipende dal nostro backend

---

## 7. Security Levels

### Come funziona
4 livelli in `security.level`:

| Level | Behavior |
|-------|----------|
| `locked` | Solo Read, Grep, Glob — read-only |
| `strict` | Tutto tranne Bash, WebSearch, WebFetch |
| `moderate` | Tutti i tool, ma scoped alla project dir via system prompt |
| `unrestricted` | Tutti i tool, nessuna restrizione directory |

- Sempre `--dangerously-skip-permissions` (il daemon è headless)
- **Directory scoping** per moderate: system prompt con "CRITICAL SECURITY CONSTRAINT: You are scoped to ${PROJECT_DIR}"
- **Custom allow/disallow**: `security.allowedTools` e `security.disallowedTools` override aggiuntivi
- Il security level è loggato e hot-reloadable

### Essenziale per il router
- ✅ I 4 livelli sono un buon framework — li possiamo replicare
- ✅ Directory scoping via system prompt — semplice ed efficace

### Nice-to-have
- Custom allowedTools/disallowedTools lists

### Non serve
- `--dangerously-skip-permissions` — noi non usiamo Claude Code CLI

---

## 8. Web Dashboard

### Come funziona
- **Bun HTTP server** con fallback automatico su porte alternative (fino a 10 tentativi)
- **Snapshot-based**: il daemon passa una funzione `getSnapshot()` che ritorna stato corrente
- **API endpoints** (dedotti da types):
  - State: PID, uptime, heartbeat next, settings, jobs
  - Heartbeat toggle on/off + settings update
  - Jobs reload
  - **Chat SSE**: streaming via `stream-json` output format — chunked responses
- **SSE streaming per chat**: `onChat(message, onChunk, onUnblock)` — riceve testo incrementale e sblocca UI quando Claude inizia a rispondere (prima che finisca i tool calls)
- **HTML page**: single-page con script/styles inline (`page/html.ts`, `page/script.ts`, `page/styles.ts`)

### Essenziale per il router
- ✅ Streaming response pattern — se facciamo una web UI
- ✅ Snapshot-based state — clean separation

### Nice-to-have
- Port fallback (auto-increment)
- Full web UI

### Non serve
- L'intera web dashboard se usiamo solo Telegram/Discord via OpenClaw

---

## 9. GLM Fallback

### Come funziona
- **Config**: `fallback: { model: "", api: "" }` — modello di fallback
- **Detection**: regex `RATE_LIMIT_PATTERN = /you.ve hit your limit|out of extra usage/i` su stdout/stderr
- **Flow**:
  1. Esegue con modello primario
  2. Se rate limited E fallback configurato E non è lo stesso modello → riprova con fallback
  3. Se fallback non configurato → ritorna errore rate limit
- **GLM specifico**: se `model === "glm"`, setta:
  - `ANTHROPIC_BASE_URL = "https://api.z.ai/api/anthropic"`
  - `API_TIMEOUT_MS = "3000000"` (50 minuti!)
- **API key**: `ANTHROPIC_AUTH_TOKEN` env var per API custom

### Essenziale per il router
- ✅ Rate limit detection + automatic fallback — critico per produzione
- ✅ Pattern: primary → detect limit → fallback model

### Nice-to-have
- GLM-specific base URL handling

### Non serve
- Il dettaglio dell'env var `ANTHROPIC_BASE_URL` — dipende dal nostro setup

---

## 10. Agentic Mode (Model Routing)

### Come funziona
- **Config**: `agentic.enabled`, `agentic.defaultMode`, `agentic.modes[]`
- **Modes**: array di `{ name, model, keywords[], phrases[] }`
  - Default: "planning" (opus, keywords: plan/design/research/think...) e "implementation" (sonnet, keywords: implement/code/fix/deploy...)
- **Routing algorithm** (`model-router.ts`):
  1. **Phase 1 — Phrase match** (highest priority): exact substring match → confidence 0.95
  2. **Phase 2 — Keyword scoring**: conta keyword hit per mode, question marks boost planning-style modes
  3. **Tie-breaking**: se score uguale, preferisce `defaultMode`
  4. **Fallback**: se nessun keyword matcha → usa `defaultMode` con confidence 0.5
- **Backward compat**: supporta vecchio formato `planningModel`/`implementationModel`
- **Logging**: logga ogni routing decision con reasoning

### Essenziale per il router
- ✅ Keyword + phrase based routing — semplice e funziona
- ✅ Configurable modes — non hardcoded
- ✅ Default mode fallback

### Nice-to-have
- Confidence scoring
- Backward compatibility con vecchi config

### Non serve
- I keyword specifici — ne definiremmo di nostri

---

## Bonus: Whisper STT

ClaudeClaw include un sistema completo di speech-to-text:
- Download automatico di whisper.cpp binary per platform (macOS arm64/x64, Linux x64/arm64, Windows)
- Download modello `base.en` da HuggingFace
- Conversione OGG Opus → WAV via `ogg-opus-decoder` (Node.js)
- Supporto STT API esterna (`stt.baseUrl`) come alternativa al local whisper

---

## Riassunto: Cosa portare nel nostro Router

### Must-have (Essenziale)
1. **PID management** con stale cleanup
2. **Hot-reload config** ogni 30s
3. **Rate limit detection + model fallback**
4. **Session management** con turn counting
5. **Auto-compact** on timeout (exit 124) + retry
6. **Serial queue** per sessione (no concurrent resume)
7. **Exclude windows** (quiet hours) timezone-aware
8. **Keyword-based model routing** configurabile

### Should-have (Nice-to-have)
1. **Security levels** framework (locked/strict/moderate/unrestricted)
2. **Cron jobs** in markdown con frontmatter
3. **Thread-based parallel sessions**
4. **Streaming response** pattern
5. **Compact warning** threshold

### Won't need
1. Telegram/Discord transports (abbiamo OpenClaw)
2. Web dashboard (abbiamo OpenClaw dashboard)
3. Whisper STT (abbiamo OpenClaw whisper skill)
4. Statusline CJS
5. Plugin preflight system
6. Secretary integration (:9999 endpoint)

---

## Architettura ClaudeClaw

```
settings.json ←── hot-reload (30s)
     │
     ├── start.ts (daemon main loop)
     │     ├── pid.ts (PID management)
     │     ├── bootstrap (init session)
     │     ├── heartbeat (setTimeout loop)
     │     ├── cron tick (setInterval 60s)
     │     ├── telegram polling
     │     ├── discord gateway
     │     └── web UI server
     │
     ├── runner.ts (Claude Code executor)
     │     ├── model-router.ts (agentic routing)
     │     ├── security args builder
     │     ├── rate limit → fallback
     │     ├── auto-compact on timeout
     │     └── serial queue (global + per-thread)
     │
     ├── sessions.ts (global session)
     ├── sessionManager.ts (thread sessions)
     ├── jobs.ts (cron job loader)
     └── cron.ts (cron expression matcher)
```
