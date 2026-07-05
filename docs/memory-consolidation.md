# Consolidamento memoria — design (go/no-go)

> Stato: **FLIPPATO 2026-07-05** — `:3342` è ora `docs-server.py` (zero chromadb). Preparato 2026-07-04, rivisto v2 e implementato 2026-07-05.
> Deploy: (A) drop-in su :3342 · embedding MiniLM invariato · OMEGA non toccato.

## 0. Esito (verificato)
- **Shadow-compare (:3352 vs :3342 Chroma): 10/10 query con ordine top-5 identico, max |Δscore| = 0.000000** — replica embedding bit-exact. `/documents` identico su tutti gli scope (152/110/42 file).
- Reindex incrementale: **0.10 s** (vs 10-30 s full re-embed di Chroma); boot: snapshot servito subito da cache (233 chunk, 0 ri-embeddati al restart).
- Flip: swap `ProgramArguments` nel plist (label `com.jarvis.chroma` invariata), bootout+bootstrap, `/health /stats /search` verdi, shape JSON conforme a `DocResult` di `memory.ts` (zero modifiche router).
- Rollback pronto: `~/.claude/backups/memory-consolidation-20260705/com.jarvis.chroma.plist.bak` + `chroma-server.py` e `chroma-data/` intatti.
- **Cleanup fatto (2026-07-05, ok di Attilio):** `chromadb 1.5.7` disinstallato dal venv (736→680 MB; zero reverse-deps verificate, `omega-memory` richiede solo numpy/onnxruntime/sqlite-vec/tokenizers — tutti restano). `~/.cache/chroma` (166 MB) nel Cestino (modello già copiato in `state/models/`). OMEGA riavviato sul venv snellito: health+search verdi.
- Rollback ora = `pip install -c constraints.txt chromadb==1.5.7` nel venv + restore plist da `~/.claude/backups/memory-consolidation-20260705/` (`chroma-server.py` e `chroma-data/` mai toccati).

## 1. Perché
Manteniamo **due** vector store separati + una dipendenza pesante:
- `chromadb 1.5.7` + rust bindings ≈ **100 MB** in `router/scripts/omega-env`, daemon Python dedicato (:3342, `chroma-server.py`), launchd `com.jarvis.chroma`.
- `omega-memory` **pinnato 1.4.7** (no 1.5.x per Pro-gating), daemon Python (:3343, `omega-server.py`), launchd `com.jarvis.omega`.

Due engine, due embedding stack, due processi per fare in sostanza la stessa cosa (retrieval semantico locale). Il dolore acuto — l'iniezione rumorosa per-turno di OMEGA — è **già risolto** (push→pull, commit `cf0460a`). Resta il peso strutturale.

## 2. Stato reale (verificato 2026-07-04)
| | :3342 ChromaDB wrapper | :3343 OMEGA |
|---|---|---|
| Ruolo | RAG sui doc curati `memory/*.md` | memoria episodica auto-catturata |
| Consumer | `router/src/services/memory.ts` → `searchDocs()` (canali Telegram/WA/Discord, scoped) | CLI recall (pull `omega__omega_search`) + router `searchMemories()` |
| Contenuto | 221 chunk / 142 file, scope global(81)/business(140) | 210 memorie |
| Engine | ChromaDB, embedding `all-MiniLM-L6-v2` (onnxruntime, 384-dim) | `omega.SQLiteStore` (sqlite + sqlite-vec + onnx) |
| Storage | `chroma-data/` | `~/.omega/omega.db` (2.6 MB) |
| API | `/search?q=&limit=&scope=` · `/stats` · `/documents` · `/reindex` | `/search` · `/stats` · `/memories` · `/add` · `DELETE` |

**Nota chiave:** :3342 NON è Chroma raw — è un wrapper con un suo contratto HTTP. `memory.ts` dipende dalla *forma* di quelle risposte (`DocResult` con `metadata.file/path/scope/first_line/...`), non da Chroma.

## 3. Già fatto (non ripetere)
- OMEGA recall push→**pull** (hook per-turno disattivato, tool `omega_search` on-demand). Cattura automatica su Stop resta attiva.
- Gateway lazy-mount: figli domain-specific parked, `omega` montabile a nome.

## 4. Tesi & non-goal
**Tesi:** sostituire **solo il backend** dietro :3342 (ChromaDB) con un docs-server `sqlite-vec` che serve lo **stesso identico contratto** API → `memory.ts` **zero modifiche**. Elimina `chromadb 1.5.7` + 100 MB di bindings + un daemon/venv, unificando sullo stesso stack di OMEGA.

**Non-goal:**
- NON fondere i due *corpus* in un unico pool (doc vs episodico servono caller e shape diversi). Restano logicamente separati anche se un giorno un solo daemon.
- NON toccare OMEGA ora: i suoi "problemi" erano il rumore, già risolto. Riscrivere il suo engine adesso = churn senza payoff.
- NON cambiare `memory.ts`: se cambia, non è drop-in.

## 5. Architettura target (v2 — rivista dopo lettura integrale di `chroma-server.py`)
Nuovo `router/scripts/docs-server.py` (~250 righe, zero chromadb):
- **Embedding:** replica esatta di `ONNXMiniLM_L6_V2` di Chroma (tokenizers + onnxruntime + mean-pooling + L2-norm, max_len 256) → stessi vettori di oggi, zero drift. Modello copiato in `state/models/all-MiniLM-L6-v2/` (86 MB, jarvis-owned — niente dipendenza dal cache `~/.cache/chroma`). Deps già nel venv (onnxruntime 1.24.4, tokenizers, numpy 2.4.4).
- **Store (v2):** sqlite semplice (`state/docs-index.db`) come *cache* di embedding keyed su content-hash; a runtime i vettori vivono in RAM (221×384 ≈ 340 KB) e la search è **brute-force cosine esatta** via numpy. Niente sqlite-vec né HNSW: a questa scala l'esatto è più semplice E più corretto dell'approssimato. Bonus: **reindex incrementale** (ri-embedda solo i chunk cambiati; oggi Chroma ricalcola tutto, 10-30 s).
- **Score:** `score = 1 − distanza_coseno = cosine similarity`, identico al wrapper attuale (verificato nel codice). Brute-force esatto vs HNSW approssimato → possibili micro-differenze *a favore* dell'esatto; le quantifica lo shadow-compare.
- **Chunking/scoping:** identici (`content[i:i+6000] step 5500`, id `md5(path)[_ci]`, `get_scope` + env `MEMORY_SCOPES_MAP`, `CHROMA_EXTRA_DIRS`, esclusione `/archive/`).
- **API:** contratto :3342 byte-per-byte (`/search /stats /documents /health /reindex`, stesse chiavi, `text[:500]`, CORS, reindex serializzato con lock + skip, `ThreadingHTTPServer`, index in background al boot).

Deploy: **(A) daemon separato su :3342** — si rimpiazza solo `ProgramArguments` nel plist. **La label launchd resta `com.jarvis.chroma`** (unica reference: `services.ts:43` → zero modifiche router; rename cosmetico rimandabile). Opzione (B) daemon unico con OMEGA: rimandata.

## 6. Piano di migrazione (staged, reversibile)
1. **Build unwired.** Scrivo `docs-server` come file nuovo; NON tocco `chroma-server.py`, il plist, né :3342 live.
2. **Shadow-compare.** Su porta alternativa (:3352), indicizzo lo stesso `memory/*.md` e confronto top-k con :3342 su un set di query reali (canali router). Diff di ranking accettabile → vai.
3. **Flip.** Swap del `LaunchAgents/com.jarvis.chroma.plist` per puntare al nuovo server su :3342. `chroma-server.py` + plist vecchio restano come **rollback** (nessuna cancellazione — coerente con "park > delete").
4. **Verify.** `curl :3342/search|/stats|/documents`, poi router live (una query per canale) + `performance/spec.md` se tocca latenza.
5. **Cleanup (solo dopo giorni di stabilità + tuo ok):** rimuovere `chromadb` dal venv, parcheggiare la config vecchia in `relocated-servers.json`.

## 7. Rischi & rollback
- **Drift di ranking:** mitigato tenendo lo stesso modello di embedding + shadow-compare pre-flip.
- **Shape JSON divergente:** mitigato dai test di contratto su `memory.ts` (nessuna modifica lato router = test è "il router funziona uguale").
- **Router è live (Attilio ci lavora ogni giorno):** perciò flip solo dopo shadow-compare, e rollback = ripristina un plist (secondi).
- **Rollback completo:** nulla è cancellato fino al passo 5; il vecchio stack resta avviabile.

## 8. Decisioni per Attilio (go/no-go)
1. **Si fa?** Sostituire il backend :3342 (ChromaDB → sqlite-vec, drop-in). *[Raccomando: sì — è la vera fonte di peso, ed è reversibile.]*
2. **Deploy:** (A) daemon docs separato su :3342 *[raccomandato]* vs (B) fondere in un unico daemon con OMEGA.
3. **Embedding:** tenere `MiniLM-L6-v2` per zero-drift *[raccomandato]* vs passare a `bge-small`.
4. **OMEGA engine:** lasciarlo com'è *[raccomandato]* — nessuna urgenza dopo il push→pull.

> Al tuo "vai" implemento §6.1–6.2 (build + shadow-compare, **niente live toccato**) e ti porto il diff di ranking prima di qualsiasi flip.
