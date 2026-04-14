# Sintesi — Feature da portare nel Router Jarvis

> Fonti: OpenClaw, ClaudeClaw, NemoClaw, cc-connect
> Data: 5 aprile 2026

---

## 🔴 MUST-HAVE (v1 → v2 del router)

### 1. Sessioni persistenti con --resume
- **Fonte**: tutti
- Ora spawniamo un Claude nuovo per ogni messaggio. Serve `--resume <sessionId>` per continuare la sessione.
- Session key: `{channel}:{from|group}` (già nel router)
- Salvare sessionId Claude per route, riusarlo

### 2. Inbound dedupe
- **Fonte**: OpenClaw
- Cache TTL 20min, max 5000 entries
- Key: `channel|from|messageId`
- Evita risposte duplicate su messaggi ripetuti/webhook retry

### 3. Auth rotation (VDM-style)
- **Fonte**: OpenClaw + VDM
- Se Claude torna rate limit (429 / exit code) → ruota account
- Pattern: prova account in ordine, skip su errore, cooldown
- VDM lo fa già → il router deve solo detectare l'errore e riprovare

### 4. Rate limit detection + model fallback
- **Fonte**: ClaudeClaw
- Regex su stdout/stderr per detectare rate limit
- Fallback automatico: Opus → Sonnet → Haiku
- Configurabile per route

### 5. Compaction
- **Fonte**: OpenClaw + ClaudeClaw
- Trigger: token count > threshold (es. 150k)
- Con --resume, Claude Code gestisce il contesto internamente
- Se senza --resume: troncamento history o compaction manuale

### 6. Cron con sessioni isolate
- **Fonte**: OpenClaw + cc-connect
- Schedule: cron expression, at, every
- Ogni job = sessione fresh (new_per_run)
- Timeout per job (kill se supera)
- Delivery risultato su canale specifico
- Timezone-aware

### 7. Serial queue per sessione
- **Fonte**: ClaudeClaw
- Se arriva messaggio mentre Claude sta processando → queue
- Non spawnare 2 Claude sulla stessa sessione
- Process queue FIFO dopo risposta

### 8. Credential injection
- **Fonte**: NemoClaw
- API key non toccano l'agent — il router le inietta via env
- Per i clienti: ogni tenant ha le sue key, il router le mappa

### 9. Rate limiting bidirezionale
- **Fonte**: cc-connect
- Incoming: max N messaggi per utente per window (anti-spam)
- Outgoing: max N messaggi per piattaforma per window (anti-ban)

### 10. Session zombie detection
- **Fonte**: cc-connect
- Se Claude non produce output per N minuti → kill
- idle_timeout configurabile (default: 120min)

---

## 🟡 SHOULD-HAVE (v3)

### 11. Heartbeat con quiet hours
- **Fonte**: OpenClaw + ClaudeClaw
- Ogni N minuti, check se c'è qualcosa da fare
- Quiet hours: niente notifiche di notte
- HEARTBEAT_OK convention: se niente da fare → silenzio

### 12. PID management + auto-restart
- **Fonte**: ClaudeClaw
- PID file, stale cleanup
- launchd/systemd per auto-restart

### 13. Hot-reload config
- **Fonte**: ClaudeClaw + OpenClaw
- Watch config.yaml, reload senza restart
- Già nel router (basic), da rendere più robusto

### 14. Keyword-based model routing
- **Fonte**: ClaudeClaw
- "plan", "design" → Opus
- "implement", "code" → Sonnet
- Configurabile per route

### 15. Security levels
- **Fonte**: ClaudeClaw
- locked / strict / moderate / unrestricted
- Per route: clienti = strict, owner = unrestricted

### 16. Streaming replies
- **Fonte**: cc-connect
- Edit-in-place su Telegram/Discord
- Intervallo e min_delta configurabili

### 17. Auto-compress con threshold
- **Fonte**: cc-connect
- Quando session estimate supera soglia → comprimi
- Cooldown per evitare loop

### 18. Fork-on-continue
- **Fonte**: cc-connect
- Sessione vecchia inattiva da N ore → fresh session
- Evita contesto stale

---

## ⚪ NON SERVE (per ora)

- Sandbox container/Landlock (Linux, noi macOS)
- Blueprint lifecycle OCI
- ACP protocol
- Plugin marketplace
- Multi-provider channels (Matrix, Signal, ecc.)
- Tool display formatting
- Multimodal embeddings
- Config backup rotation
- State migrations
- i18n
- Secretary integration

---

## Piano implementazione

### v2 (prossima iterazione — ~6-8h)
Aggiungere al router: 1, 2, 6, 7, 10
→ Sessioni persistenti, dedupe, cron, serial queue, zombie detection

### v3 (iterazione dopo — ~6-8h)  
Aggiungere: 3, 4, 5, 8, 9
→ Auth rotation, model fallback, compaction, credential injection, rate limiting

### v4 (polish — ~8-10h)
Aggiungere: 11-18
→ Heartbeat, PID, hot-reload, model routing, security, streaming, auto-compress, fork

### Totale: ~20-26h di lavoro per un sistema completo
