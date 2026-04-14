# OpenClaw Source Analysis — Feature Extraction for Custom Router

> Analisi dal codice bundled in `~/.bun/install/global/node_modules/openclaw/dist/`
> Data: 2026-04-05

---

## 1. Session Management

### Come funziona
- **Session key derivation**: `resolveSessionKey()` genera chiavi basate su scope (global/per-peer). Pattern: `agent:{agentId}:{channel}:{type}:{peerId}`
- **Isolamento**: gruppi (`group:`) e canali (`channel:`) hanno chiavi separate; DM diretti collassano in un bucket "main" canonical (`agent:main:main`)
- **Session store**: JSON file-based (`loadSessionStore`/`updateSessionStore`), path risolto per agent ID
- **Normalizzazione**: E.164 per telefoni, normalizzazione esplicita per Discord (custom normalizer per provider)
- **Metadata per sessione**: `compactionCount`, `memoryFlushCompactionCount`, `ttsAuto`, `abortedLastRun`, `totalTokensFresh`

### Must-have
- Session key derivation per canale/peer (abbiamo già qualcosa di simile)
- Store JSON per stato sessione (compaction count, ultimo flush)
- Isolamento gruppi vs DM

### Nice-to-have
- Normalizzatori per-provider delle session key
- Multi-agent session routing (supporto per agent diversi)

### Non serve
- ACP (Agent Communication Protocol) bindings — troppo complesso per il nostro caso

---

## 2. Message Routing

### Come funziona
- **`dispatchReplyFromConfig()`** è il cuore (858 righe in `dispatch-C2z_6KF9.js`)
- **Inbound dedupe**: cache con TTL 20min, max 5000 entries. Key = `provider|accountId|agentScope|peerId|threadId|messageId`
- **Routing decision**: `resolveReplyRoutingDecision()` determina se instradare verso canale originante vs corrente
- **Plugin binding**: conversazioni possono essere "bound" a plugin specifici (ACP sessions)
- **Cross-channel routing**: se `shouldRouteToOriginating` è true, usa `routeReply()` per mandare al canale originante
- **Typing signals**: soppressi quando si fa routing cross-channel o quando suppresso per ACP child sessions

### Must-have
- Inbound dedupe (evita risposte duplicate a messaggi ripetuti)
- Routing decision logic (quale canale riceve la risposta)
- Cross-channel reply routing

### Nice-to-have
- Plugin binding system
- Typing signal management

### Non serve
- Webchat special handling
- ACP session interaction modes

---

## 3. Cron System

### Come funziona
- **Store**: `cron/jobs.json` nella config dir, formato JSON con versioning
- **Scheduling**: supporta 3 tipi: `--at` (one-shot), `--every` (interval), `--cron` (cron expression 5/6 field)
- **Timezone support**: `--tz` per cron expressions, con parsing robusto di datetime offset-less
- **Stagger**: window di stagger per evitare che tutti i job partano allo stesso secondo
- **Session target**: `main` o `isolated` — isolated crea sessione dedicata
- **Delivery**: può annunciare risultati via canale (`--channel`, `--to`, `--account`)
- **Wake modes**: `now` o `next-heartbeat`
- **Payload types**: `--system-event` (main session) o `--message` (agent message)
- **Tools allowlist**: `--tools exec,read,write` per limitare tool disponibili
- **Gestito dal Gateway**: il cron scheduler gira nel daemon, non nel CLI
- **Backup**: confronta store precedente per evitare backup su cambiamenti solo runtime
- **One-shot**: `--delete-after-run` per job usa-e-getta

### Must-have
- Cron expression parsing + timezone support
- Isolated sessions per job (evita contaminazione)
- Job store persistente con stato (last run, errori)
- Delivery dei risultati verso canali

### Nice-to-have
- Stagger window
- Wake modes
- Tool allowlist per job
- Thinking level override per job

### Non serve
- Gateway RPC layer (noi usiamo processo diretto)
- Backup rotation del cron store

---

## 4. Heartbeat

### Come funziona
- **Prompt**: legge `HEARTBEAT.md` dal workspace. Se non ha contenuto actionable → skip
- **Intervallo**: configurabile via `agents.defaults.heartbeat.every` (default "30m"), parsato con `parseDurationMs`
- **Token detection**: `HEARTBEAT_OK` nell'output = niente da segnalare → skip delivery
- **Strip logic**: rimuove `HEARTBEAT_OK` dai bordi del testo, con gestione markup HTML
- **Ack max chars**: se il testo residuo dopo strip è ≤ 300 chars → skip (era solo un ack)
- **Per-agent config**: ogni agent può avere il suo heartbeat config, o usare defaults
- **Channel activity tracking**: traccia ultimo inbound/outbound per canale/account
- **Visibility**: per canale configurabile `showOk`, `showAlerts`, `useIndicator`
- **Effectively empty check**: skip se HEARTBEAT.md ha solo commenti/header/whitespace

### Must-have
- HEARTBEAT.md pattern (già lo usiamo)
- Intervallo configurabile
- HEARTBEAT_OK detection per skip delivery
- Check "effectively empty" per evitare API call inutili

### Nice-to-have
- Channel activity tracking
- Visibility config per canale
- Ack max chars threshold

### Non serve
- Multi-agent heartbeat routing
- Heartbeat event emitter system

---

## 5. Memory System

### Come funziona
- **Storage**: SQLite via LanceDB, con vector search + FTS (hybrid search)
- **Chunking**: default 400 tokens, 80 token overlap
- **Embedding**: provider "auto" o specifico (local/remote), con fallback
- **Hybrid search**: vector weight 0.7 + text weight 0.3, con candidate multiplier 4x
- **MMR**: Maximal Marginal Relevance opzionale (lambda 0.7)
- **Temporal decay**: opzionale, half-life 30 giorni
- **Sources**: `memory` (files) + `sessions` (transcript, experimental)
- **Sync triggers**: on session start, on search, file watcher (1.5s debounce)
- **Session memory**: indicizza trascrizioni sessione se sessionMemory=true, con delta tracking (100KB o 50 messaggi)
- **Post-compaction force flush**: dopo compaction, forza re-index
- **Cache**: query cache abilitata di default
- **Extra paths**: può indicizzare path aggiuntivi
- **Multimodal**: supporto sperimentale per embedding multimodali
- **Min score**: default 0.35
- **Max results**: default 6

### Must-have
- Semantic search con embeddings (già implementato tramite memory_search tool)
- Chunking con overlap
- Hybrid search (vector + text)

### Nice-to-have
- Temporal decay
- Session transcript indexing
- Post-compaction force flush
- File watcher per re-index automatico

### Non serve
- Multimodal embeddings
- Batch embedding (per grandi volumi)
- MMR (over-engineering per il nostro caso)

---

## 6. Auth Rotation

### Come funziona
- **Multi-key collection**: per ogni provider, raccoglie chiavi da:
  1. `OPENCLAW_LIVE_{PROVIDER}_KEY` (forced single, bypass tutto)
  2. `{PROVIDER}_API_KEYS` (comma/space separated list)
  3. `{PROVIDER}_API_KEY` (primary)
  4. `{PROVIDER}_API_KEY_*` (env prefix scan)
  5. Fallback vars (es. `GOOGLE_API_KEY` per google-vertex)
- **Rotation**: `executeWithApiKeyRotation()` — prova chiavi in ordine, su rate limit (429, quota exceeded, too many requests) passa alla successiva
- **Detection**: `isApiKeyRateLimitError()` matcha su keyword nel messaggio errore
- **Custom retry**: callback `shouldRetry` per override della logica
- **Deduplication**: le chiavi duplicate vengono rimosse

### Must-have
- Multi-key rotation con failover su rate limit
- Detection pattern per 429/rate limit errors
- Env var collection per provider

### Nice-to-have
- Custom shouldRetry callback
- Forced single key override

### Non serve
- Provider-specific config structs (possiamo semplificare)

---

## 7. Channel Connectors

### Come funziona
- **Plugin architecture**: ogni canale (telegram, discord, whatsapp, signal, matrix, etc.) è un plugin registrato
- **Common pattern**: ogni plugin ha `outbound` (send) e `inbound` (receive) handlers
- **Debounce**: `inbound-debounce-DcwkFaUr.js` per raggruppare messaggi ravvicinati
- **Group policy**: configurabile per gruppo (allow/deny, mention-only, etc.)
- **Allowlist**: `allow-from` pattern per limitare chi può parlare al bot
- **Media handling**: normalizzazione media type, download temp, sandbox path resolution
- **Discord specifics**: thread bindings, session key normalization per guild/channel/thread
- **WhatsApp specifics**: heartbeat integrato, auth presence, targets parsing
- **Telegram specifics**: custom commands, inline buttons, command config
- **Streaming**: `block-streaming` per risposte progressive (edit message in-place)
- **Channel activity**: tracking per heartbeat visibility
- **Send policy**: per canale, controlla se/come mandare messaggi

### Must-have
- Debounce inbound (già lo facciamo in parte)
- Group policy / allowlist
- Media handling normalizzato
- Streaming/edit-in-place per risposte lunghe

### Nice-to-have
- Plugin architecture (se vogliamo aggiungere canali facilmente)
- Thread bindings
- Channel-specific send policy

### Non serve
- Matrix/Signal/IRC/Nostr/Slack/MSTeams support
- Plugin marketplace

---

## 8. Sub-agents

### Come funziona
- **Registry**: `subagent-registry-runtime` traccia run attivi per session key
- **Tracking**: `countActiveDescendantRuns`, `countPendingDescendantRuns`, `listSubagentRunsForRequester`
- **Orphan recovery**: dopo restart gateway (SIGUSR1), scansiona sessioni orfane e manda messaggio di resume
- **Parent-owned mode**: subagent in background, output non va all'utente direttamente
- **Steer**: `replaceSubagentRunAfterSteer` per redirigere un subagent run
- **Announce suppression**: `shouldIgnorePostCompletionAnnounceForSession`
- **Session forking**: `session-fork.runtime` per creare sessioni derivate
- **Depth tracking**: sessioni hanno `spawnedBy` e `parentSessionKey`

### Must-have
- Registry per tracciare subagent attivi
- Parent-child session relationship
- Completion announcement al parent

### Nice-to-have
- Orphan recovery dopo crash
- Steer (redirect) di subagent in corso
- Depth limiting

### Non serve
- ACP protocol completo
- Stateful target driver

---

## 9. Cross-Channel Messaging

### Come funziona
- **`routeReply()`**: il core del cross-channel. Prende payload + channel + to + threadId e lo manda
- **`isRoutableChannel()`**: verifica se un canale supporta routing
- **Origin tracking**: `OriginatingChannel`, `OriginatingTo` nel contesto inbound
- **Mirror mode**: opzione per mandare copia al canale originale
- **Thread preservation**: threadId passato per mantenere contesto thread
- **Typing suppression**: quando si fa routing, typing sul canale corrente viene soppresso

### Must-have
- Origin tracking (da dove viene il messaggio originale)
- Route reply a canale diverso
- Thread preservation

### Nice-to-have
- Mirror mode
- Typing suppression per routing

### Non serve
- Niente di specifico da escludere

---

## 10. Compaction

### Come funziona
- **Trigger**: quando token count si avvicina al context window
- **Reserve floor**: `agents.defaults.compaction.reserveTokensFloor` (default 20000 tokens)
- **Meccanismo**: `compactEmbeddedPiSession()` — chiede all'LLM di riassumere la conversazione
- **Contatore**: `compactionCount` incrementato ad ogni compaction
- **Post-compaction**: `readPostCompactionContext()` per leggere il contesto dopo compaction
- **Notify user**: opzionale `🧹 Auto-compaction complete`
- **Memory flush**: dopo compaction, forza flush della memory se configurato
- **Error handling**: se compaction fallisce (context overflow durante compaction stessa), reset sessione con messaggio utente
- **Token estimation**: `estimateMessagesTokens()` per decidere quando compattare
- **Preflight compaction**: controlla prima di ogni run se serve compattare

### Must-have
- Token counting e threshold per trigger
- Reserve token floor
- Compaction counter per sessione
- Error handling con reset sessione

### Nice-to-have
- Notifica utente
- Memory flush post-compaction
- Preflight check

### Non serve
- Embedded Pi agent specifics

---

## 11. Tool System

### Come funziona
- **Tool catalog**: definizioni strutturate con `id`, `label`, `description`, `sectionId`, `profiles`
- **Sezioni**: fs, runtime, web, memory, sessions, ui, messaging, automation, nodes, agents, media
- **Profile-based**: tool taggati con profili (es. "coding") per abilitazione selettiva
- **Policy matching**: `tool-policy-match` per verificare se un tool è consentito
- **Per-session tools override**: cron jobs possono specificare `--tools exec,read,write`
- **Mutation tracking**: `tool-mutation` traccia tool che modificano stato
- **Tool display**: formatting per mostrare tool calls all'utente
- **Tool images**: gestione immagini generate dai tool
- **Tool send**: tool specifico per mandare messaggi ad altri canali
- **Security levels**: exec ha approval system con `exec-approvals`, `exec-safety`
- **Workspace-only mode**: `resolveEffectiveToolFsWorkspaceOnly` per limitare accesso file

### Must-have
- Tool allowlist configurabile (già lo facciamo parzialmente)
- Exec approval/safety system
- Per-session tool override

### Nice-to-have
- Tool catalog strutturato
- Mutation tracking
- Profile-based enablement

### Non serve
- Tool display formatting
- Tool images pipeline

---

## 12. Config System

### Come funziona
- **Config loading**: `loadConfig()` da file YAML/JSON nella config dir
- **Multi-source**: config principale + agent-specific overrides + channel overrides
- **Config schema**: validazione con Zod (`config-schema-*.js`)
- **Backup rotation**: mantiene `.bak` files, con hardened permissions
- **Orphan cleanup**: pulisce vecchi backup
- **Config health**: tracking dello stato config (entry per path)
- **Environment substitution**: `env-substitution` per variabili env in config
- **Config patching**: `merge-patch` per aggiornamenti parziali
- **Hot-reload**: segnalato come feature in schema (`"hot-reload"` enum), implementato probabilmente via SIGUSR1 al gateway
- **Config guard**: validazione prima di applicare
- **State migrations**: `state-migrations` per upgrade di formato

### Must-have
- Config loading da YAML
- Env substitution
- Schema validation
- Config patching (merge parziale)

### Nice-to-have
- Hot-reload
- Backup rotation
- State migrations

### Non serve
- Config health tracking
- Multi-path backup hardening

---

## Riepilogo Priorità per il Router Custom

### 🔴 Must-Have (implementare subito)
1. **Session key derivation** per canale/peer con isolamento gruppi
2. **Inbound dedupe** con cache TTL
3. **Auth rotation** multi-key con failover su 429
4. **Compaction trigger** basato su token count
5. **Cron** con sessioni isolate e delivery risultati
6. **Cross-channel routing** con origin tracking

### 🟡 Nice-to-Have (implementare dopo)
1. **Heartbeat** con HEARTBEAT_OK detection e empty check
2. **Memory** post-compaction force flush
3. **Subagent** registry con orphan recovery
4. **Tool allowlist** per-session/per-job
5. **Config hot-reload**
6. **Debounce** inbound messaggi

### 🟢 Non Prioritario
1. ACP protocol
2. Plugin marketplace
3. Multi-provider channel support (Matrix, Signal, etc.)
4. Multimodal embeddings
5. Tool display formatting
