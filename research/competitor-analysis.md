# Competitor Analysis: ClaudeClaw (sbusso) / OpenClaw / ClaudeClaw (moazbuilds) vs Jarvis Router

Data analisi: 2026-04-12

---

## Overview

| | **Jarvis Router** | **ClaudeClaw (sbusso)** | **OpenClaw** | **ClaudeClaw (moazbuilds)** |
|---|---|---|---|---|
| Repo | privato | [sbusso/claudeclaw](https://github.com/sbusso/claudeclaw) | [openclaw/openclaw](https://github.com/openclaw/openclaw) | [moazbuilds/claudeclaw](https://github.com/moazbuilds/claudeclaw) |
| Stars | — | 104 | 355K | 868 |
| Filosofia | Router multi-canale con Claude Code CLI | Orchestrator con Agent SDK in sandbox | Assistente personale multi-provider | Plugin leggero per Claude Code |
| Runtime | Node.js + tsx | Node.js | Node.js (pnpm) | Bun |
| Agent engine | Claude Code CLI spawn | Claude Agent SDK `query()` | Pi (runtime proprietario) | Claude Code CLI spawn (`Bun.spawn`) |
| Modelli | Claude only | Claude only | Multi-provider | Claude only (con model router) |
| Canali | Telegram, WhatsApp, Discord | Telegram, WhatsApp, Slack | 23+ canali | Telegram, Discord |
| Isolamento | `--strict-mcp-config` + `--disallowed-tools` | `@anthropic-ai/sandbox-runtime` (kernel) | Docker containers (default-deny network) | `--dangerously-skip-permissions` (cosmetico) |
| Memory | ChromaDB + Mem0 | Filesystem + grep | SQLite + FTS5 + sqlite-vec (hybrid) | Claude sessions + CLAUDE.md |
| Config | YAML (`config.yaml`) | SQLite + `.env` | Typed config (zod) + wizard | JSON (`settings.json`) |
| Dashboard | HTML inline in server.ts | — (TUI in roadmap) | Control UI + macOS menu bar | Web UI locale (porta 4632) |
| Cost tracking | No | Per-run in SQLite | Per-session + OTEL export | No |
| Plugin system | MCP servers per-route | `registerExtension()` | ClawHub (13.7K skill) + SDK | Claude Code plugin marketplace |
| Distribuzione | launchd daemon | Standalone | Gateway daemon (launchd/systemd) | Claude Code plugin |

---

## DA COPIARE

### Priorita Alta

| # | Feature | Fonte | Cosa | Effort | Perche |
|---|---|---|---|---|---|
| 1 | **Sandbox runtime** | ClaudeClaw (sbusso) | `@anthropic-ai/sandbox-runtime` — wrap `spawn("claude",...)` con isolamento kernel. Network proxy con domain allowlist, filesystem deny-by-default. Seatbelt su macOS, bubblewrap su Linux | Medio | Complementare ai nostri flag. `--disallowed-tools` blocca cosa Claude *sceglie*; SRT blocca cosa il *processo* puo fare. <10ms overhead, no Docker |
| 2 | **Cost tracking** | ClaudeClaw (sbusso) + OpenClaw | `--output-format stream-json`, parsare `usage` per riga, loggare in SQLite con `estimated_cost_usd`, model, duration, route | Basso | Visibilita zero sui costi oggi. Essenziale per capire quanto costa ogni route/canale |
| 3 | **Env var sanitization** | OpenClaw | Bloccare forwarding di `*API_KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*` agli agenti. Allowlist solo vars safe (PATH, HOME, TERM, LANG, NODE_ENV). Blocco anche base64-encoded credentials | Basso | Oggi gli agenti ereditano tutto l'environment. Rischio reale se un agente viene prompt-injected |
| 4 | **Hybrid memory search** | OpenClaw | SQLite + FTS5 + sqlite-vec per ricerca ibrida (0.7 vector + 0.3 BM25). Sostituirebbe ChromaDB+Mem0 con zero servizi esterni. Supporta embeddings da OpenAI, Gemini, Voyage, Ollama, GGUF locale | Medio-Alto | Elimina 2 servizi (ChromaDB porta 3342, Mem0 porta 3343). Stessa qualita, zero maintenance, tutto in-process |
| 5 | **Agentic model router** | ClaudeClaw (moazbuilds) | Classificare prompt in "planning" vs "implementation" e routare a modelli diversi (Opus per ragionamento, Sonnet per codice). Heuristica keyword-based, no LLM overhead | Basso | Ottimizzazione costi immediata. Non tutti i messaggi richiedono Opus. Possiamo implementarlo per-route come override |

### Priorita Media

| # | Feature | Fonte | Cosa | Effort | Perche |
|---|---|---|---|---|---|
| 6 | **Webhook trigger** | ClaudeClaw (sbusso) | `POST /webhook/:route` con HMAC-SHA256 sul nostro HTTPS server (porta 3341). Rate limit 10 req/min per route | Basso | Triggerare agenti da GitHub events, Stripe, cron esterni. 40 righe di middleware |
| 7 | **PreCompact hook** | ClaudeClaw (sbusso) | Salvare transcript prima della compaction del context, con summary nel daily log | Basso | Evita perdita di contesto in sessioni lunghe |
| 8 | **DM pairing security** | OpenClaw | Utenti sconosciuti ricevono un pairing code da approvare prima di poter interagire | Basso | Oggi chiunque scriva al bot viene servito. Pattern semplice per whitelist dinamica |
| 9 | **Active Memory injection** | OpenClaw | Sub-agente blocking che cerca in memory *prima* di ogni risposta e inietta contesto rilevante come system context nascosto. Query modes: last message, recent tail, full conversation | Medio | Migliora la qualita delle risposte senza che l'agente debba esplicitamente cercare in memoria |
| 10 | **OTEL export** | OpenClaw | Metriche (`openclaw.tokens`, `openclaw.cost.usd`, `openclaw.run.duration_ms`) + trace via OTLP/HTTP. Compatibile Grafana/Prometheus/Datadog | Medio | Monitoring esterno senza reinventare la ruota |
| 11 | **Discord thread isolation** | ClaudeClaw (moazbuilds) | Sessioni Claude Code indipendenti per ogni Discord thread, con processing parallelo tra thread e seriale dentro il thread | Basso | Modello pulito per conversazioni multiple su Discord. Noi oggi non isoliamo per thread |
| 12 | **Auto-compact** | ClaudeClaw (moazbuilds) | Warning a 25 turn, auto-compact su timeout (exit 124), retry automatico dopo compact | Basso | Gestione graceful delle sessioni lunghe senza intervento |
| 13 | **GLM fallback** | ClaudeClaw (moazbuilds) | Switch automatico a modello fallback quando il primario raggiunge rate limit | Basso | Resilienza senza downtime per l'utente |

### Priorita Bassa

| # | Feature | Fonte | Cosa | Effort | Perche |
|---|---|---|---|---|---|
| 14 | **Conditional tool gates** | OpenClaw | Abilitare MCP server solo se un binario/env var e presente (pattern `requires.bins`, `requires.env`) | Basso | Graceful degradation per route con tool opzionali |
| 15 | **Per-route cost limits** | ClaudeClaw (sbusso) spec + OpenClaw gap | Hard cap USD per-route per-run, kill agent se supera budget | Medio | Nessuno dei tre lo implementa davvero. Opportunita di fare meglio |
| 16 | **Dreaming/consolidation** | OpenClaw | Background sweep che promuove fatti da daily notes a MEMORY.md con scoring | Basso | Opt-in anche in OpenClaw. Nice-to-have per agenti long-running |
| 17 | **Heartbeat system** | ClaudeClaw (moazbuilds) | Check-in periodici autonomi con prompt configurabili e quiet hours (giorno + fascia oraria) | Basso | Utile per agenti proattivi, ma rischio rumore |

---

## DA NON COPIARE

| Feature | Fonte | Perche no |
|---|---|---|
| **Agent SDK diretto** | ClaudeClaw (sbusso) | Perdiamo skills, hooks, MCP management, identity layering di Claude Code CLI |
| **SQLite message bus + polling** | ClaudeClaw (sbusso) | +2s latenza. I nostri webhook diretti sono push, non pull |
| **Filesystem IPC** | ClaudeClaw (sbusso) | Stdout/stderr streaming e piu veloce e semplice |
| **Single-process + GroupQueue** | ClaudeClaw (sbusso) | Cap a 5 agenti concorrenti = collo di bottiglia artificiale |
| **Extension system formale** | ClaudeClaw (sbusso) | Over-engineering. `config.yaml` + handler basta |
| **Filesystem-only memory + grep** | ClaudeClaw (sbusso) | Non scala, perde semantica. Inferiore a qualsiasi soluzione con embeddings |
| **Docker sandbox** | OpenClaw | Cold start 2-5s, richiede Docker daemon. SRT fa lo stesso a <10ms |
| **Multi-provider** | OpenClaw | Non ci serve. Claude-only by design |
| **23+ canali** | OpenClaw | Complessita enorme per canali inutilizzati. On-demand e meglio |
| **Plugin SDK formale** | OpenClaw | YAGNI. MCP per-route copre il caso d'uso |
| **Pi runtime** | OpenClaw | Proprietario. Claude Code CLI da di piu |
| **ClawHub skill registry** | OpenClaw | Formato proprietario (SKILL.md). MCP e lo standard |
| **`--dangerously-skip-permissions`** | ClaudeClaw (moazbuilds) | Sicurezza cosmetica. Ogni livello bypassa i permessi di Claude Code. Tool filtering senza enforcement reale |
| **`--append-system-prompt` per identita** | ClaudeClaw (moazbuilds) | Non persiste con `--resume`. Il nostro two-layer CLAUDE.md e nativo e persistente |
| **Bun runtime** | ClaudeClaw (moazbuilds) | Noi siamo Node.js + tsx. Bun ha incompatibilita con alcune dipendenze |
| **Plugin preflight bootstrap** | ClaudeClaw (moazbuilds) | Hardcoded GitHub URLs, fragile. Il nostro config.yaml e piu stabile |
| **Security via system prompt** | ClaudeClaw (moazbuilds) | Directory scoping enforced solo da prompt instruction, non da filesystem restriction. Bypassabile da qualsiasi bash command |
| **Zero memory infrastructure** | ClaudeClaw (moazbuilds) | Tutto delegato a Claude sessions + CLAUDE.md. Non scala, non ha search, non ha cross-session recall |

---

## DA VALUTARE (watch)

| Feature | Fonte | Pro | Contro | Decisione |
|---|---|---|---|---|
| **QMD (local reranking)** | OpenClaw | BM25 + vector + LLM re-ranking locale con GGUF. Zero API calls | Non maturo. Dipende da node-llama-cpp | Watch — potrebbe sostituire embedding APIs |
| **Memory Wiki** | OpenClaw plugin | KB strutturata con claims, contradiction tracking, freshness | Complessita elevata | Watch — per agenti knowledge-heavy |
| **CLAUDE.md come durable memory** | ClaudeClaw (sbusso) | Zero-cost injection, recall perfetto per fatti stabili | Cresce linearmente | Ibrido: gia lo usiamo per identita. Valutare `memory.md` per-route |
| **Whisper STT locale** | ClaudeClaw (moazbuilds) | whisper.cpp locale, zero API calls per voice-to-text | Noi gia gestiamo voice su Telegram | Valutare se sostituire la nostra pipeline STT con whisper.cpp per ridurre latenza/costi |

---

## Matrice di sicurezza comparativa

| Dimensione | Jarvis | ClaudeClaw (sbusso) | OpenClaw | ClaudeClaw (moazbuilds) |
|---|---|---|---|---|
| Permission model | `--strict-mcp-config` | `bypassPermissions` in SDK | Tool allow/deny + sandbox policy | `--dangerously-skip-permissions` |
| Isolamento processo | Nessuno (same user) | Kernel (Seatbelt/bwrap) | Docker container | Nessuno |
| Network | Nessuna restrizione | Proxy con domain allowlist | Default-deny in container | Nessuna restrizione |
| Filesystem | `--disallowed-tools` per route | Kernel deny-by-default | Mount control + symlink check | System prompt only |
| Env vars | Ereditati tutti | Passati via env (ma in sandbox) | Sanitizzati (pattern match) | Ereditati tutti |
| Secrets | config.yaml (non in source) | `.env` file | Sanitizzazione automatica | Plaintext settings.json |
| **Voto complessivo** | **B** | **A-** | **A** | **D** |

---

## Piano d'azione finale

```
Sprint 1 — Quick wins [~1 giorno]:
  1. Env var sanitization in buildSpawnArgs()           [2h]
  2. Cost tracking con --output-format stream-json       [4h]
  3. Webhook POST /webhook/:route con HMAC-SHA256        [2h]

Sprint 2 — Security [~2 giorni]:
  4. @anthropic-ai/sandbox-runtime per route sensibili   [1d]
  5. DM pairing / whitelist dinamica                     [4h]
  6. Agentic model router (Opus/Sonnet per tipo task)    [4h]

Sprint 3 — Memory upgrade [~3 giorni]:
  7. Valutazione SQLite+FTS5+sqlite-vec vs ChromaDB      [research 1d]
  8. Active Memory injection pre-risposta                [1d]
  9. PreCompact hook per transcript persistence           [2h]
  10. Auto-compact + GLM fallback                         [4h]

Sprint 4 — Observability [~2 giorni]:
  11. OTEL export per metriche e trace                   [1d]
  12. Per-route cost limits con hard cap                  [4h]
  13. Discord thread isolation                            [4h]
```

**Risultato atteso:** Jarvis passa da voto B ad A in sicurezza, guadagna visibilita sui costi, elimina 2 servizi esterni (ChromaDB/Mem0), e aggiunge resilienza (model fallback, auto-compact). Effort totale: ~8 giorni di lavoro.
