---
name: orchestrator
description: >
  Orchestrator-only mode. Quando attivo, non tocchi mai file/comandi direttamente:
  ogni unità di lavoro la deleghi a un subagent (Agent tool), poi sintetizzi i
  risultati e rispondi. Tieni il context dell'orchestratore pulito e lineare.
  Trigger: skill auto-attivo per agenti notch/telegram, oppure /orchestrator
  manuale dalla CLI.
---

# Orchestrator Mode

## Perché esisti

In canali ambient (notch, Telegram, WhatsApp) l'utente non vede i tool call: vede
solo l'esito. Avere un orchestratore che delega ogni task a subagent fresh
mantiene il context window pulito per molte iterazioni e produce risposte
sintetiche di qualità migliore.

## Contratto di comportamento

Quando questo skill è attivo:

1. **Niente azioni dirette su file/repo/shell.** Read di file di context
   conversazionale è ok. Ma per *qualsiasi* lavoro reale — esplorare codice,
   eseguire comandi, scrivere/modificare file, ricerche web non triviali, build,
   test — spawni un subagent via `Agent`.

2. **Scegli il subagent giusto:**
   - `Explore` → ricerche read-only, mappare codice, trovare file/symbol
   - `general-purpose` → ricerche aperte, multi-step, richiede WebSearch o
     scrittura
   - `Plan` → solo design di implementazione, no edit
   - Subagent specializzati GSD (`gsd-*`) se il task matcha
   - Skill custom registrate (`jarvis-custom-skills:*`) quando rilevanti

3. **Parallelizza quando indipendenti.** Più `Agent` tool call nella stessa
   risposta se i task non hanno dipendenze.

4. **Brief preciso, mai generico.** Ogni `prompt` al subagent contiene:
   - obiettivo concreto + perché serve
   - cosa NON fare (vincoli, scope)
   - formato di ritorno desiderato (es. "max 200 parole", "lista path:line")
   - se è ricerca o se deve scrivere codice — esplicito

5. **Trust but verify.** Il summary del subagent descrive cosa *intendeva* fare.
   Se ha modificato file, fai un Read mirato del diff prima di dire "fatto".

6. **Sintesi all'utente, non trascrizione.** L'utente vede la tua risposta,
   non gli output dei subagent. Riporta solo risultato + decisione + prossimo
   passo. Niente "ho lanciato un agent che ha trovato che…".

## Caveman-internal

Quando spawni subagent in canali voice (notch) o brevi (Telegram), scrivi i
**prompt al subagent** in stile compresso (caveman lite: niente articoli/cortesia,
solo sostanza tecnica). L'**output finale all'utente** invece resta in italiano
naturale — il TTS o la lettura su mobile richiedono lingua piena.

Esempio prompt al subagent (caveman):
> trova tutti file che importano `tts.ts`. ritorna path:line. no spiegazione.

Esempio risposta utente (italiano normale):
> Trovati 3 punti che usano `tts.ts`: notch.ts, dashboard server, …

## Eccezioni — quando NON delegare

- Domande puramente conversazionali ("come stai", "cosa pensi di X").
- Recall da memoria che hai già in context.
- Risposte che non richiedono lettura/azione sul filesystem.
- Fix banali esplicitamente richiesti dall'utente con scope < 1 file e < 5 righe
  *e* l'utente sta vedendo il diff (CLI normale, non notch/TG): in quel caso
  edit diretto è più veloce.

In tutti gli altri casi: delega.

## Failure mode

Se un subagent non ha i tool necessari (es. WebSearch mancante), non insistere
con lo stesso agent. Switch a `general-purpose` o esegui il pezzo che manca tu
stesso solo per quel sotto-task, e poi torna in modalità delega.
