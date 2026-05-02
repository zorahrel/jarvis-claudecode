# Router hardening — notify + Discord + context + subagent

**Status**: ✅ done (shipped via PR #8 + follow-ups #9-#17)  •  **Created**: 2026-04-24  •  **Closed**: 2026-04-28  •  **Owner**: Attilio + Jarvis

## Outcome (2026-04-28)

Tutti gli stream sono mergati in `main` e in produzione da giorni.

| Stream | Stato | Evidenza |
|---|---|---|
| S1 Notify + subagent flag | ✅ | `services/notify-tokens.ts`, `JARVIS_NOTIFY_*` env, `POST /api/notify`, PR #8 + #9-#17 (rich child footer iterations) |
| S2 Discord hygiene | ✅ | mention resolver in `discord.ts`, `[@username]:` prefix in guild, quoted relative timestamps — vedi CHANGELOG `[Unreleased] § Fixed` |
| S3 Connector bootstrap | ✅ | retry/backoff su Telegram/Discord/WhatsApp, vedi `connectors/*` |
| S4 Security/obs | ✅ | log redaction (`logger.ts`), rate-limiter, dedup 5s, token hash on disk |
| S5 Context compression | ✅ | sostituito dalla SDK migration (compaction nativa SDK), vedi `.planning/audit/sdk-cutover-status.md` |
| S6 Integration | ✅ | shipped + soak in produzione |

### Risposte alle 7 domande aperte
1. **Budget 100/sessione** — confermato, non è mai esploso in produzione.
2. **Dedup 5s** — confermato.
3. **Multi-agent worktrees** — usato, ha funzionato.
4. **Upstream PR** — non proposto upstream (decisione: questa logica è troppo Jarvis-specific). Riconsiderare se altri utenti la chiedono.
5. **Compaction threshold 80%** — superato dalla SDK migration: compaction è gestita dall'SDK ufficiale.
6. **`/compact` nativo** — N/A dopo migrazione SDK.
7. **Subagent prompt wording** — accettato il template proposto, mai stato un problema.

---


## Goal
Quattro filoni, un solo piano, multi-agent execution:
- **NOTIFY** — agente può scrivere al canale di origine a fine job/cron/subagent/background bash.
- **DISCORD** — mention resolution, multi-user session hygiene, boot resilience.
- **CONTEXT** — awareness della context window + auto-compress a soglia (openhuman #702).
- **SUBAGENT** — flag per distinguere spawn primari vs subagent (openhuman #688).

Tutti i rischi vanno chiusi **alla radice**, non con "mitigation".

---

## Streams (paralleli dove possibile)

```
S1 Notify + subagent flag  ──┐
S2 Discord hygiene           ├──► S6 Integration + E2E test
S3 Connector harden          │
S4 Security/obs              │
S5 Context compression       ──┘
```

| Stream | Owner | Touches | Blocks |
|---|---|---|---|
| S1 Notify core + subagent flag | agent-notify | `notify-tokens.ts`, `claude.ts`, `api.ts` | S6 |
| S2 Discord hygiene | agent-discord | `discord.ts`, `handler.ts` (quoted fmt) | S6 |
| S3 Connector harden | agent-bootstrap | `index.ts`, `telegram.ts`, `discord.ts`, `whatsapp.ts` | S6 |
| S4 Security/obs | agent-security | `logger.ts`, `notify-tokens.ts`, `rate-limiter.ts`, `api.ts` | S6 |
| S5 Context compression | agent-context | `claude.ts`, `services/context.ts` (new), dashboard | S6 |
| S6 Integration + E2E | orchestrator | tests, manual smoke, `CHANGELOG.md` | — |

S1-S5 possono girare in parallelo su 5 worktrees isolati. S6 merge sequentially.

**Nota merge S1 ↔ S4 ↔ S5**: toccano tutti `claude.ts`. Merge order: S1 → S5 → S4. Conflitti attesi minimi (funzioni diverse) ma da sorvegliare.

---

## S1 — Notify core + subagent flag

### Design (root-causal)

**Token identity = channel+target binding**. Il token *è* l'autorità: chi ce l'ha può scrivere solo al `{channel, target}` per cui è stato emesso. Nessun body param `channel`/`target` → spoofing impossibile by construction.

**Env injection al CLI spawn**. `sessionKey = channel:target[:group]` è invariante per la vita del processo (verificato `claude.ts:516`). Inject una volta sola in `buildSafeEnv`. Subagents (Task tool, in-process) e `Bash(run_in_background)` (subprocess shell) ereditano per costruzione.

**Subagent flag**. `buildSpawnArgs` riceve un `isSubagent: boolean`. Quando true:
- Env `JARVIS_IS_SUBAGENT=1`
- `--append-system-prompt "You are a subagent. Respond ONLY to the specific task. No preambles, no personal memory, no brand. Terse."` — **unica eccezione** alla regola "no third layer" (documentata in CLAUDE.md), valida SOLO per subagent spawn perché il subagent non ha identità propria.
- `JARVIS_NOTIFY_*` **non** iniettato (il subagent non notifica — solo il primary agent può).

**Trigger del flag**: oggi il router spawna CLI per route normali (primary) e per cron (`askClaudeFresh` in `cron.ts`). I cron passano `isSubagent=true`. Future spawn programmatici (es. batch job interni) settano il flag esplicitamente. Task-tool subagent in-process non sono un nostro spawn → irrilevante per questo flag.

### Deliverables

1. `router/src/services/notify-tokens.ts` (~80 righe)
   - `issueToken(channel, target): string` — UUID v4
   - `resolveToken(token): {channel, target} | null`
   - Persistenza: **hash SHA-256 su disk**, plaintext solo in memoria. File `0600`. (→ S4)
   - TTL 24h, GC su startup + ogni 1h
   - `revokeToken(token)` per cleanup esplicito a shutdown CLI

2. `router/src/services/claude.ts` — modifiche `buildSafeEnv` + `buildSpawnArgs` + `getOrCreateProcess`:
   - Parse `key` → `{channel, target}`
   - Call `issueToken` al primo spawn per quella key (solo se non subagent)
   - Inject env notify: `JARVIS_CHANNEL`, `JARVIS_REPLY_TARGET`, `JARVIS_SESSION_KEY`, `JARVIS_NOTIFY_URL`, `JARVIS_NOTIFY_TOKEN`
   - Inject env subagent: `JARVIS_IS_SUBAGENT=1` se `isSubagent`
   - Append `--append-system-prompt` con prompt subagent dedicato se `isSubagent`
   - Revoke token su `killProcess`

3. `router/src/dashboard/api.ts` — endpoint `POST /api/notify`
   - Auth: `Authorization: Bearer <token>` (header-only)
   - Body: `{text: string, silent?: boolean}`
   - Token-budget + rate-limit + dedup (→ S4)
   - `formatForChannel` + `deliverFn` (già esistenti)
   - Response: `200 {messageId, remaining: {tokens, rate}}`

4. `router/src/services/cron.ts` — passa `isSubagent: true` al cron spawn

### Scope escluso
- MCP tool dedicato (`jarvis_notify`) — post-MVP
- Subagent che notifica — per ora no, primary only

---

## S2 — Discord hygiene

### Design (root-causal)

**Mention resolution in ingresso**. Risolti al boundary → tutto il sistema vede testo leggibile.

**Username prefix per multi-speaker**. Prefix `[@user]:` risolve senza per-user sessions.

**Quoted message normalization**. Reply con timestamp + mention risolti.

### Deliverables

1. `router/src/connectors/discord.ts` — `resolveMentions(text, discordMsg)`:
   - `<@ID>` / `<@!ID>` → `@username` via `mentions.users`
   - `<@&ROLE_ID>` → `@rolename` via `mentions.roles`
   - `<#CHANNEL_ID>` → `#channelname` via `mentions.channels`
   - Applicata a `cleanText` E `quotedMessage.text`

2. `discord.ts:169` — prefix speaker in guild:
   ```ts
   const prefixed = discordMsg.guildId
     ? `[@${discordMsg.author.username}]: ${cleanText}`
     : cleanText;
   ```

3. `router/src/services/handler.ts` — timestamp relativo (`(3h fa)`, `(ieri)`) nel `[Replying to from X]:` header. Cross-canale.

### Scope escluso
- Channel-history context (B4 originale): token cost non giustificato. Opt-in separato post-validation.

---

## S3 — Connector bootstrap resilience

### Design (root-causal)

**Startup non-bloccante**. `connector.start()` fire-and-retry in background, router UP anche se un canale è transitoriamente giù.

**Exponential backoff centralizzato**. Helper `startWithRetry` in `index.ts`.

### Deliverables

1. `router/src/index.ts` — `startWithRetry`:
   - Attempts 5, delays 5s/15s/45s/2m/5m
   - Log warn per tentativo, error finale
   - Non blocca `initCrons`/`setDeliveryFn`

2. Applicato a Telegram, Discord, WhatsApp (`setMyCommands` stesso problema DNS)

3. `CHANGELOG.md` entry

### Scope escluso
- Reconnect automatico post-startup (WebSocket drop) — gestito a livello library

---

## S4 — Security + observability

### Design (root-causal)

**Token mai in plaintext su disk**. Registry salva SHA-256. Plaintext solo in-memory e nell'env del child CLI.

**Redaction automatica nei log**. Pino serializer che redige `JARVIS_NOTIFY_TOKEN`, `token`, `Authorization`.

**Token budget per-session**. 100 notifiche / sessione CLI, configurabile via `notifyBudget` in `agent.yaml`.

**Loop detection**. Text identico allo stesso target in <5s → drop + warn.

### Deliverables

1. `router/src/services/notify-tokens.ts` — hash persistence, file mode `0600`

2. `router/src/services/logger.ts` — redaction paths:
   ```
   JARVIS_NOTIFY_TOKEN, token, headers.authorization, env.JARVIS_NOTIFY_TOKEN
   ```

3. `router/src/services/rate-limiter.ts` — counter aggiuntivi:
   - `notifyRate(channel, target)` — 30/min default, configurabile
   - `notifySessionBudget(sessionKey)` — 100/session default, config via `agent.yaml`
   - `notifyDedup(target, textHash)` — 5s window, drop identical

4. `router/src/dashboard/api.ts` — applica tutti e 3. Response include `remaining`

5. Dashboard: widget `notify.outbound` nel feed eventi

---

## S5 — Context-window compression (openhuman #702)

### Design (root-causal)

**Awareness, non timeout**. Oggi il CLI si strozza silenziosamente quando la context satura. Root fix: router tiene il conto dei token usati per sessione (già ha token counter per cost tracking — riuso) e **agisce prima** che arrivi il limite.

**Compaction = riassunto + respawn**. Soglia 80% del context window del modello corrente:
1. Inietta turn dedicato: "Riassumi lo stato della conversazione in ≤20 bullet: decisioni prese, file/path rilevanti, todo aperti. Solo la lista, niente commento."
2. Cattura il summary dalla response.
3. Kill del persistent process (come già fa `killProcess`).
4. Respawn pulito. Primo user turn del nuovo processo = summary dell'agente (come *user message*, NON come `--append-system-prompt` → rispetta il vincolo "no third layer" del CLAUDE.md).
5. Flag `session.compacted` nel broadcast dashboard.

**Context window lookup**. Nuovo `router/src/services/context.ts` con mapping:
- `opus 4.7` / `sonnet 4.6` standard: 200k
- Versioni `[1m]`: 1M
- `haiku 4.5`: 200k
- Fallback conservativo 200k se unknown

**Trigger proattivo a turn-boundary**. Check in `sendMessage` PRIMA di inviare prossimo input: se `tokensUsed/contextWindow > 0.80` → compacting step, poi prosegui con l'input vero.

### Deliverables

1. `router/src/services/context.ts` (new, ~40 righe)
   - `contextWindowFor(model): number`
   - `shouldCompact(used, model, threshold=0.80): boolean`

2. `router/src/services/claude.ts` — modifiche:
   - Tracking cumulativo `pp.totalInputTokens` (esiste già per cost, verificare)
   - Hook in `askClaudeInternal` prima di `sendMessage`: se `shouldCompact` → esegui compacting flow
   - `compactSession(pp, key)`:
     - Send special compaction prompt
     - Cattura summary
     - `killProcess(pp)`, `processes.delete(key)`
     - Nuovo spawn alla prossima `getOrCreateProcess`, con summary come primo user turn (via `messageForClaude` = `[CONTEXT RESTORED]\n${summary}\n\n[NEW TURN]\n${originalMessage}`)

3. Dashboard:
   - Event `session.compacted` broadcast (ts, key, tokensBefore, summaryBullets)
   - Tab sessions: badge "compacted @X tokens" + mini-log
   - `router/dashboard/src/components/` — toccare il componente sessions

4. Log: `log.info({key, tokensBefore, threshold}, "Session compacted")`

### Considerazioni

- **Slash `/compact` nativo di Claude Code**: verificare se funziona in stream-json mode. Se sì, usare quello invece del custom prompt (più idiomatico, gestisce lui lo stato). Se no, custom flow.
- **Compaction budget**: max 5 compactions per sessione lifetime. Se raggiunte, next compact = hard reset (kill + new session senza summary, notifica utente via canale).
- **Model fallback**: se sessione corrente usa modello 1M ma compaction emette summary di 40k token, può starci tranquillo. Solo il modello 200k richiede vigilanza stretta.

### Scope escluso
- Sliding-window alternative: mantenere ultimi N turn senza riassumere. Peggiore qualitativamente, rigettato.
- Compaction per-subagent Task tool: in-process, gestita dal CLI parent. Fuori scope.

---

## S6 — Integration + E2E

Dopo merge S1-S5:

1. `npx tsc --noEmit` in `router/` — clean
2. `npm run build` in `router/dashboard/` — clean (S4 + S5 toccano dashboard)
3. `launchctl kickstart -k gui/$(id -u)/com.jarvis.router`
4. Smoke tests:
   - **T1**: curl locale con token sintetico → msg su Telegram arriva
   - **T2**: agente Telegram `Bash(run_in_background) && sleep 10 && curl $JARVIS_NOTIFY_URL` → notifica arriva
   - **T3**: subagent via Task tool fa stesso curl → notifica arriva (env ereditato)
   - **T4**: Discord con role mention `<@&...>` → agente vede `@rolename`
   - **T5**: Discord multi-user in guild → prompt contiene `[@userA]:` e `[@userB]:`
   - **T6**: WiFi off, restart, attendi 30s, WiFi on → Discord sale entro 15-60s
   - **T7**: Loop sintetico 200 curl → blocco a 100 con 429, log warn
   - **T8**: Log grep — zero token plaintext in `logs/router.log`
   - **T9**: Sessione Telegram lunga (pump fino a ~160k token su opus 200k) → `session.compacted` broadcast, nuova sessione parte con summary, conversazione continua coerente
   - **T10**: Spawn cron con `isSubagent=true` → env del child ha `JARVIS_IS_SUBAGENT=1`, system prompt contiene blocco subagent (verifica via `ps -E <pid>` o inspezione args)
   - **T11**: Primary agent (Telegram) non ha `JARVIS_IS_SUBAGENT` in env, ha `JARVIS_NOTIFY_TOKEN`

5. `CHANGELOG.md` → `[Unreleased]` aggiornato (3 entry separati: notify/discord/context+subagent)
6. Memory update: reference memory con path endpoint + env vars

---

## Rischi — stato "risolto alla radice"

| Rischio | Era | Ora |
|---|---|---|
| Token leak via log | "non loggare" | redaction automatica `logger.ts` |
| Spam loop | rate limit 30/min | budget duro 100/session + dedup 5s + rate limit |
| Token file sensibile | `0600` e speriamo | hash SHA-256 su disk, plaintext mai persistito |
| Loop self-notify | connector ignora bot self | + dedup 5s copre anche non-self loops |
| Cross-target spoof | trust on client | token↔target binding by construction |
| Boot bloccante | give up dopo 65s | async retry, router UP sempre |
| Discord mention bug | fix puntuale | `resolveMentions` al boundary, zero dati corrotti in sistema |
| Guild session confusion | session per-user | prefix speaker = agente capisce, session simple |
| Context saturation silenziosa | nessun controllo | awareness proattiva + auto-compact a 80%, broadcast dashboard |
| Subagent role confusion | nessuno | env flag + system prompt dedicato, unica eccezione third-layer documentata |
| Compaction infinito | nessuno | budget 5 compactions/session, poi hard reset con notifica |
| --append-system-prompt fight | CLAUDE.md lo vieta | applicato SOLO a subagent (no identità propria → no fight) |

Nessuna mitigation rimasta. Ogni riga ha un fix strutturale.

---

## Execution order

**Wave 1 (parallelo, 5 worktrees)**:
- S1 notify core + subagent flag
- S2 discord hygiene
- S3 connector harden
- S4 security/obs
- S5 context compression

**Wave 2 (sequenziale, merge con attenzione a `claude.ts`)**:
- Merge order: S1 → S5 → S4 → S2 → S3
- S6 integration + E2E

**Stima**: 
- Wave 1 wall-clock ≈ 2-3h (S5 è il più pesante, mezza giornata dichiarata da openhuman)
- Wave 2 ≈ 1.5h (merge + full smoke suite)
- **Totale**: 3.5-4.5h con 5 agenti paralleli

Zero deps npm nuove.

---

## File toccati (riepilogo)

| File | Stream |
|---|---|
| `router/src/services/notify-tokens.ts` (new) | S1, S4 |
| `router/src/services/context.ts` (new) | S5 |
| `router/src/services/claude.ts` | S1, S5 |
| `router/src/services/cron.ts` | S1 (isSubagent=true) |
| `router/src/services/logger.ts` | S4 |
| `router/src/services/rate-limiter.ts` | S4 |
| `router/src/services/handler.ts` | S2 |
| `router/src/dashboard/api.ts` | S1, S4 |
| `router/src/connectors/discord.ts` | S2 |
| `router/src/connectors/telegram.ts` | S3 |
| `router/src/connectors/whatsapp.ts` | S3 |
| `router/src/index.ts` | S3 |
| `router/dashboard/src/components/` (sessions tab) | S4 (notify feed), S5 (compaction badge) |
| `CHANGELOG.md` | S6 |

---

## Domande aperte (da confermare prima di partire)

1. **Budget 100/sessione** ragionevole per batch tipo "10 foto Giappone"? (Default alzabile a 500.)
2. **Dedup 5s** ok o preferisci 30s?
3. **Multi-agent execution**: confermi lancio parallelo S1-S5 su worktrees?
4. **Upstream PR**: conviene proporre a `zorahrel/jarvis-claudecode`? Secondo CLAUDE.md sì (feature generale).
5. **Compaction threshold 80%** ok o preferisci 70% (più safe, più compactions) / 85% (meno compactions, più rischio)?
6. **Compaction via `/compact` nativo CLI** se funziona in stream-json, o custom prompt sempre? (Se CLI lo supporta, root-fix preferito.)
7. **Subagent prompt wording**: il template dichiarato nel piano (`"You are a subagent..."`) ok o preferisci scritto tu?
