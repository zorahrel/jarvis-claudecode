# Distilled — skill auto-apprese (alla Hermes)

Workflow ripetuti, distillati in tool eseguibili ed esposti via MCP come
`distilled__<nome>` (child del gateway, zero righe nel contesto base).

## Struttura
```
distilled/
  _drafts/<nome>/     ← proposte del distillatore, NON esposte
  <nome>/             ← distillati live, esposti come tool
    manifest.json     { name, description, inputSchema?, timeoutMs? }
    run               eseguibile: args JSON su stdin → risultato su stdout
    RATIONALE.md      perché esiste: pattern rilevato, occorrenze, fonti
```

## Ciclo di vita
1. Il cron **distiller** (settimanale, agente `agents/distiller`) analizza i
   `task_completion` di OMEGA (:3343), individua pattern ripetuti (≥3) e
   scrive un draft in `_drafts/`.
2. Attilio approva: `~/.claude/jarvis/mcp-servers/distilled/approve.sh <nome>`
   (scan SkillSpector inclusa). **Mai promuovere in autonomia.**
3. Remount del child (`gateway_unmount` + `gateway_mount` di `distilled`, o
   kickstart di `com.jarvis.gateway`) → il tool è live in tutte le sessioni.

## Regole
- Criterio: scriptabile → distillato MCP · richiede giudizio LLM → SKILL.md nel marketplace.
- `run` non deve contenere segreti: usare env/Keychain.
- Nome tool: `^[a-z0-9][a-z0-9_-]{0,63}$`.
