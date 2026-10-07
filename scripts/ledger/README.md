# ledger — nessun task perso tra sessioni e harness

Una riga per sessione di Claude Code, Codex, Muse e jcode (`scan`), lo scheletro di una sessione
senza output dei tool (`skeleton <id>`), il contesto compatto per riprenderla su un altro harness
(`handoff <id>`), e il giro automatico: ogni sessione di lavoro morta su quota o errore API diventa
una card «Ripresa» sulla board Topics del suo repo (`sweep`), o su `inbox` se nata in ~ senza repo.

- Barra: `python3 ledger.py check --days 7` esce 1 se una sessione morta su limite/errore non ha la sua card viva.
- Launchd: `com.jarvis.ledger-sweep` ogni 30 min (`com.jarvis.ledger-sweep.plist.example`), log in `logs/ledger-sweep.*.log`.
- Stato (`carded.json`) e output in `state/ledger/` (gitignorata: dentro ci sono prompt e nomi di progetto).
- Le card nascono in backlog: senza status esplicito Topics le mette in todo e l'auto-dispatch lancia un agente.
- Mai registrare ~ come progetto Topics: il path entra nell'allowlist dei file (routes/projects.ts).
