# NemoClaw & cc-connect — Analisi per il Router Custom

> Data: 2026-04-05 | Fonti: GitHub + docs NVIDIA + config.example.toml cc-connect

---

## NemoClaw (NVIDIA)

NemoClaw è un reference stack NVIDIA per far girare OpenClaw in sandbox sicure usando OpenShell runtime. Alpha dal 16 marzo 2026.

### 1. Security Model — Sandbox & Isolation

**Come funziona:** Ogni agent gira in un container OpenShell con Landlock + seccomp + network namespace. Zero accesso di default. Filesystem confinato a `/sandbox` e `/tmp` (rw), system paths read-only. Blueprint hardened con capability drops e least-privilege network rules.

- **Essenziale per il router:** L'idea di policy dichiarative YAML per network egress. Possiamo implementare un `allowed_hosts.yaml` nel router che blocca/consente endpoint per agent.
- **Nice-to-have:** Sandbox container completo (noi non ne abbiamo bisogno, giriamo su macOS nativo).
- **Non serve:** Landlock/seccomp (Linux kernel-level, non applicabile al nostro setup macOS).

### 2. Privacy Router / Inference Routing

**Come funziona:** L'agent nel sandbox non ha mai le credenziali API. Le richieste inference passano dal gateway OpenShell che inietta le credenziali al volo. `Agent → OpenShell gateway → Provider`. Supporta NVIDIA Endpoints, OpenAI, Anthropic, Gemini, Ollama.

- **Essenziale:** **Credential injection a livello gateway.** Il nostro router potrebbe fare lo stesso: le API key non vanno mai nei prompt/agent, il router le inietta. Questo è il pattern più utile di tutto NemoClaw.
- **Essenziale:** **Provider routing trasparente** — l'agent chiede "un modello" e il gateway decide dove mandarlo. Noi già lo facciamo parzialmente, ma possiamo formalizzarlo.
- **Nice-to-have:** SSRF validation (checks IP + DNS prima di fare richieste esterne).
- **Non serve:** Il loro specifico blueprint system con OCI registry e digest verification.

### 3. Multi-agent

**Come funziona:** Ogni agent ha il proprio sandbox isolato. Non c'è un vero orchestratore multi-agent — è più "N sandbox indipendenti" che un sistema di coordinamento.

- **Non serve per il router:** Il nostro multi-agent è gestito da OpenClaw stesso (subagents, sessions). NemoClaw non aggiunge niente qui.

### 4. Enterprise Features

**Come funziona:**
- Network policy con approval TUI: quando l'agent tenta un endpoint non in whitelist, l'operatore vede un prompt nel terminale e approva/nega per la sessione corrente.
- Blueprint versioning con digest verification.
- State management con credential stripping per migrazioni.
- Logging via `nemoclaw logs --follow`.

- **Essenziale:** **Network approval flow.** Un meccanismo dove il router logga tutti gli endpoint chiamati e permette allow/deny. Implementabile come middleware nel router.
- **Nice-to-have:** Audit logging strutturato di tutte le richieste inference.
- **Non serve:** Blueprint lifecycle, OCI registry, digest verification (overengineered per noi).

---

## cc-connect

Bridge Go/npm che connette AI coding agents (Claude Code, Codex, Gemini CLI, etc.) a 10 piattaforme chat. Config in TOML.

### 1. Multi-platform Bridge

**Come funziona:** Un singolo processo gestisce N `[[projects]]`, ognuno con il proprio agent + piattaforme. Ogni piattaforma ha un adapter (WebSocket per Feishu/Discord/Slack, long polling per Telegram, HTTP per LINE). La maggior parte non richiede IP pubblico.

- **Essenziale:** **Pattern multi-project in un processo.** La struttura `[[projects]]` con `work_dir`, `agent`, e piattaforme indipendenti è pulita. Il nostro router potrebbe adottare una config simile per definire routing rules per progetto/contesto.
- **Nice-to-have:** Platform capability matrix — sapere cosa supporta ogni piattaforma (streaming, voice, files) per adattare il formato.
- **Non serve:** I 10 adapter specifici (OpenClaw già gestisce Telegram/Discord/Slack/WhatsApp nativamente).

### 2. Auto-compress

**Come funziona:** Monitora i token stimati della sessione. Quando superano `max_tokens` (es. 12000), triggera automaticamente `/compress`. Ha un `min_gap_mins` (default 30) per evitare compressioni troppo frequenti.

```toml
[projects.auto_compress]
enabled = true
max_tokens = 12000
min_gap_mins = 30
```

- **Essenziale:** **Il concetto di threshold + cooldown.** OpenClaw ha già la compaction, ma l'idea di un trigger configurabile per progetto con cooldown è elegante. Il router potrebbe esporre questo come config.
- **Non serve:** L'implementazione specifica (noi usiamo la compaction nativa di OpenClaw che è più sofisticata).

### 3. Cron with Boundaries

**Come funziona:**
- `session_mode`: `"reuse"` (usa sessione attiva) o `"new_per_run"` (sessione fresh ogni volta)
- Timeout per job per evitare runaway tasks
- Notifica opzionale all'avvio (`silent = false`)

```toml
[cron]
silent = false
session_mode = "reuse"  # o "new_per_run"
```

- **Essenziale:** **`session_mode = "new_per_run"`** — ogni cron job in sessione pulita. Il nostro router dovrebbe avere questo come default per i cron, evita contaminazione di contesto.
- **Essenziale:** **Timeout per job.** Cron senza timeout = rischio di agent bloccati che consumano risorse.
- **Nice-to-have:** Il flag `silent` per sopprimere notifiche di avvio.

### 4. Session Management

**Come funziona:**
- **Fork-on-continue:** Quando fai `--continue` dal bridge, NON erediti la sessione CLI locale — cc-connect forka in una nuova sessione bridge. Evita che una sessione terminale half-finished contamini il bridge.
- **reset_on_idle_mins:** Dopo N minuti di inattività utente, auto-switcha a sessione fresh.
- **idle_timeout_mins:** Se l'agent non produce eventi per 120 min, la sessione è considerata stuck.
- Slash commands: `/new`, `/list`, `/sw` per gestire sessioni da chat.

- **Essenziale:** **Fork-on-continue** — nel nostro router, quando un messaggio arriva su una sessione vecchia, valutare se continuare o forkare.
- **Essenziale:** **idle_timeout_mins** — kill automatico di sessioni stuck. Il router dovrebbe monitorare e terminare sessioni zombie.
- **Nice-to-have:** `reset_on_idle_mins` per auto-refresh.
- **Non serve:** Gli slash commands (OpenClaw li ha già).

### 5. Streaming Replies

**Come funziona:**
```toml
[stream_preview]
enabled = true
interval_ms = 1500
min_delta_chars = 30
max_chars = 2000
```
Edit-in-place del messaggio su Telegram/Discord/Feishu con intervallo configurabile. Mostra output progressivo tipo "typing indicator" evoluto.

- **Nice-to-have:** I parametri di tuning (`interval_ms`, `min_delta_chars`) sono ben pensati. OpenClaw fa già streaming nativo, ma potremmo esporre tuning simile nel router per controllare la frequenza di update.
- **Non serve:** L'implementazione (già coperta da OpenClaw).

### 6. Config System

**Come funziona:** TOML con struttura gerarchica:
- Globale: `language`, `data_dir`, `log.level`
- Display: `thinking_max_len`, `tool_max_len`, `tool_messages`
- Rate limiting: sliding window per sessione (`max_messages`/`window_secs`)
- Outgoing rate limit: per piattaforma con burst
- Per-project: `[[projects]]` con override di tutto
- Cron, auto-compress, relay, webhook — tutto in sezioni dedicate

- **Essenziale:** **Rate limiting bi-direzionale** — incoming (utente→bot) E outgoing (bot→piattaforma). Il nostro router dovrebbe avere entrambi, specialmente outgoing per evitare ban.
- **Essenziale:** **Config per-project con override.** Struttura pulita per definire comportamenti diversi per contesto.
- **Nice-to-have:** Admin whitelist (`admin_from = "alice,bob"`) per comandi privilegiati.
- **Non serve:** i18n, display truncation settings (OpenClaw gestisce già).

---

## Sintesi: Cosa Portare nel Router

### 🔴 Essenziale (da implementare)

| Feature | Fonte | Descrizione |
|---------|-------|-------------|
| **Credential injection** | NemoClaw | API key iniettate dal router, mai esposte all'agent |
| **Network allowlist** | NemoClaw | YAML di endpoint consentiti, logging di quelli bloccati |
| **Cron session isolation** | cc-connect | `new_per_run` come default per cron jobs |
| **Cron timeout** | cc-connect | Max durata per job, kill se supera |
| **Session zombie detection** | cc-connect | `idle_timeout_mins` per sessioni stuck |
| **Rate limiting bidirezionale** | cc-connect | Incoming + outgoing con sliding window |
| **Fork-on-continue logic** | cc-connect | Valutare fresh session vs continuare |

### 🟡 Nice-to-have

| Feature | Fonte | Descrizione |
|---------|-------|-------------|
| SSRF validation | NemoClaw | Check IP/DNS prima di richieste esterne |
| Audit logging strutturato | NemoClaw | Log JSON di ogni richiesta inference |
| Auto-compress threshold | cc-connect | Trigger compaction su soglia token configurabile |
| Streaming tuning params | cc-connect | `interval_ms`, `min_delta_chars` configurabili |
| Platform capability matrix | cc-connect | Adattare formato per piattaforma |
| Idle auto-reset | cc-connect | Fresh session dopo inattività utente |
| Admin whitelist | cc-connect | Comandi privilegiati solo per utenti specifici |

### ⚪ Non serve

- Sandbox container/Landlock/seccomp (Linux-only, noi su macOS)
- Blueprint lifecycle con OCI registry
- 10 platform adapters (OpenClaw li ha nativamente)
- i18n / display truncation
- Multi-agent orchestration di NemoClaw (è solo N sandbox isolati)
