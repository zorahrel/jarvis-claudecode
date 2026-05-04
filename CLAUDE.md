# Jarvis Router

Multi-channel AI router: Telegram, WhatsApp, Discord → Claude Code CLI.
Dashboard: http://localhost:3340 | Config: `router/config.yaml`

## Ports
3340: Router HTTP | 3341: Router HTTPS | 3342: ChromaDB | 3343: OMEGA

## Operations
- Restart: `launchctl kickstart -k gui/$(id -u)/com.jarvis.router`
- Logs: `~/.claude/jarvis/logs/router.log`
- Config edits: edit YAML, restart router. Don't write JS config loaders.
- Dashboard is a React SPA (`router/dashboard/`) — rebuild with `npm run build` before restart.

## Rules
- Never hardcode secrets — use env vars or config.yaml
- Don't use Docker
- Don't add npm dependencies without good reason
- Don't hardcode extra services in source — use `services:` in config.yaml
- Don't modify agents' CLAUDE.md without understanding the scoping
- Identity: two layers only — `~/.claude/CLAUDE.md` (user-global) + `<workspace>/CLAUDE.md` (agent). NEVER add a third layer via `--append-system-prompt`.

## Developer guide
See `DEVELOPMENT.md` for spawn discipline, build steps, contributing upstream.
