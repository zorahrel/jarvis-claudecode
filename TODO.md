# Jarvis — TODO & Roadmap

## Done
- [x] ChromaDB server (:3342) — doc RAG
- [x] Mem0 server (:3343) — conversation memory
- [x] Dashboard sezione Memory (search, docs, memories, stats, 3D force graph)
- [x] Vocali/immagini/file su tutti i canali (Telegram, WhatsApp, Discord)
- [x] Quoted messages context
- [x] LaunchAgents nativi (router, chroma, mem0)
- [x] Tray app macOS (SwiftUI popover, SF Symbols, health checks)
- [x] Vision via Claude content blocks
- [x] MCP per-route configurabile
- [x] Capabilities visibili/editabili per route
- [x] Mem0 stale Qdrant lock auto-cleanup on startup
- [x] Dashboard sezione Services (health check live)
- [x] CLI session tracking via hooks
- [x] Health endpoint: `GET /api/services`
- [x] File upload bidirezionale — Claude Write/Edit → auto-send come allegato
- [x] Secrets in `.env` — chiavi fuori dal codice
- [x] Config YAML env interpolation — `$ENV_VAR` espanso automaticamente
- [x] Dashboard React SPA (da inline Alpine.js)
- [x] Memory v2 UI: view mode toggle Graph/List/Grid, scope chips, quick-add modal, keyboard shortcuts
- [x] Memory v2: Related panel nel preview (top-5 docs semanticamente simili)
- [x] Semantic search: highlight parole, skeleton loading, click-to-open documento

## In Progress
- [ ] Tray popover positioning (multi-display)
- [ ] Tray status refresh after start/stop (più reattivo)

## Next Up
- [ ] Sub-agents da chat — "fai X in background" → spawna Claude task
- [ ] Slash commands custom — /clear, /scope, /status
- [ ] Log rotation per i service logs
- [ ] Backup config.yaml periodico
- [ ] Cron jobs runtime: schedule Claude tasks da `config.yaml` con delivery su canale
- [ ] Services config-driven estesi (sezione `services:` in config.yaml già prevista)

## Future
- [ ] Auto-update Claude CLI
- [ ] Auth sulla dashboard (se esposta fuori da tailscale/LAN)
- [ ] Location-aware responses

## Known Issues
- Tray popover appears far from icon on multi-display
- WhatsApp "Bad MAC" errors (normal reconnection, not a bug)
