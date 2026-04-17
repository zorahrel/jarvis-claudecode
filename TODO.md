# Jarvis — TODO & Roadmap

## Done
- [x] ChromaDB server (:3342) — doc RAG
- [x] OMEGA server (:3343) — conversation memory
- [x] Dashboard Memory section (search, docs, memories, stats, 3D force graph)
- [x] Voice/images/files on all channels (Telegram, WhatsApp, Discord)
- [x] Quoted messages context
- [x] Native LaunchAgents (router, chroma, omega)
- [x] macOS tray app (SwiftUI popover, SF Symbols, health checks)
- [x] Vision via Claude content blocks
- [x] Per-route configurable MCP
- [x] Visible/editable capabilities per route
- [x] Dashboard Services section (live health checks)
- [x] CLI session tracking via hooks
- [x] Health endpoint: `GET /api/services`
- [x] Bidirectional file upload — Claude Write/Edit → auto-sent as attachment
- [x] Secrets in `.env` — keys out of source
- [x] YAML config env interpolation — `$ENV_VAR` expanded automatically
- [x] Dashboard React SPA (replaced inline Alpine.js)
- [x] Memory v2 UI: view mode toggle Graph/List/Grid, scope chips, quick-add modal, keyboard shortcuts
- [x] Memory v2: Related panel in preview (top-5 semantically similar docs)
- [x] Semantic search: word highlight, skeleton loading, click-to-open document
- [x] Skills marketplace (`~/jarvis/skills-marketplace/`) — lets remote-channel agents create skills
- [x] Dashboard drill-downs + unified tooltips (portaled `Tooltip`, shared primitives)
- [x] Dashboard WebSocket activity stream (`/ws`) — push updates with polling fallback
- [x] Telegram slash-command menu — publishes Claude Code commands to Telegram's native `/`-menu
- [x] Cron jobs runtime: schedule Claude tasks from `config.yaml` with channel delivery (JSONL run history, agent-inherited config, ASCII footer, conversation-cache seeding)

## In Progress
- [ ] Tray popover positioning (multi-display)
- [ ] Tray status refresh after start/stop (more responsive)

## Next Up
- [ ] Sub-agents from chat — "do X in background" → spawn Claude task
- [ ] Log rotation for service logs
- [ ] Periodic config.yaml backup
- [ ] Extended config-driven services (the `services:` section in config.yaml is already wired in)

## Future
- [ ] Auto-update Claude CLI
- [ ] Dashboard auth (when exposed outside tailscale/LAN)
- [ ] Location-aware responses

## Known Issues
- Tray popover appears far from the icon on multi-display
- WhatsApp "Bad MAC" errors (normal reconnection, not a bug)
