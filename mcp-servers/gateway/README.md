# gateway — configurazione locale

Il gateway **non vive qui**. Il codice è il pacchetto `mcp-hot-gateway`
(`~/Projects/mcp-hot-gateway`, repo pubblico `zorahrel/mcp-hot-gateway`, MIT),
collegato in `node_modules/` da `npm install`. Questa cartella tiene solo ciò
che è specifico di questa macchina.

| File | Cos'è |
|------|-------|
| `gateway-config.json` | L'elenco dei figli. Percorsi come `${HOME}/...` per restare portabili. |
| `.env` | I segreti referenziati come `${VAR}` nella config. Gitignorato. |
| `start.sh` | Carica `.env`, pinna `MCP_GATEWAY_CONFIG` e `MCP_GATEWAY_REGISTRY`, lancia il pacchetto. |
| `com.jarvis.gateway.plist` | Il LaunchAgent del daemon (porta 23371). |
| `introspect.mjs` | Dump dei tool per la dashboard del router. **Non** fa parte del pacchetto. |

## Modificare il gateway

Si edita `~/Projects/mcp-hot-gateway`, non questa cartella. `node_modules` è un
symlink, quindi la modifica è attiva al riavvio successivo — nessun reinstall.

```bash
npm test --prefix ~/Projects/mcp-hot-gateway     # la barra: esce non-zero se rompe
launchctl kickstart -k gui/$(id -u)/com.jarvis.gateway
tail -f ~/.claude/jarvis/logs/gateway.err.log
```

## Aggiungere un figlio

A caldo, dalla sessione: `gateway_mount {name, transport, command|url, ...}` —
viene persistito da solo in `gateway-config.json`. Per parcheggiarlo (resta in
config ma non parte al boot): `gateway_unmount {name}`.

## Trappola

`start.sh` **deve** esportare `MCP_GATEWAY_CONFIG` esplicitamente. Il default del
pacchetto è relativo alla posizione del suo `index.mjs`, che ora è
`~/Projects/mcp-hot-gateway/` — senza quella riga il daemon parte con zero figli.
