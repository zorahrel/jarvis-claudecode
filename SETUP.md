# Jarvis — Setup & Operations

## Prerequisites
- Node.js (nvm, >= v20) + tsx
- Python 3.11+ (homebrew)
- Claude Code CLI
- ffmpeg, whisper-cli, pdftotext

## Quick Start
```bash
# Start core services via launchctl (Router, docs-index)
launchctl load ~/Library/LaunchAgents/com.jarvis.router.plist
launchctl load ~/Library/LaunchAgents/com.jarvis.docs-index.plist
```

## Services

Core (always present, hardcoded):

| Service | Port | LaunchAgent | Health |
|---------|------|-------------|--------|
| Router | 3340/3341 | com.jarvis.router | `curl localhost:3340/api/stats` |
| Docs-index | 3342 | com.jarvis.docs-index | `curl localhost:3342/health` |
| Moondream (optional) | 2020 | com.jarvis.moondream | `moondream --selftest` |

OMEGA (3343) dismesso il 28/09/2026: plist in `LaunchAgents/disabled/`, memorie in `memory/projects/`. Rollback in `memory/tools/memory.md`.

Extra services: add a `services:` section in `router/config.yaml` (see `config.example.yaml`).
They appear in the dashboard.

All launchd services use `KeepAlive: true` (auto-restart on crash).

## Key Paths
- Config: `~/.claude/jarvis/router/config.yaml`
- Dashboard: http://localhost:3340
- Logs: `~/.claude/jarvis/logs/`
- Memory: `~/.claude/jarvis/memory/`
- LaunchAgents: `~/Library/LaunchAgents/com.jarvis.*.plist`

## Troubleshooting

### Bot not replying on Telegram
```bash
tail -30 ~/.claude/jarvis/logs/router.log
# If timeout:
launchctl kickstart -k gui/$(id -u)/com.jarvis.router
```

### Docs-index down
```bash
curl localhost:3342/health
# Restart:
launchctl kickstart -k gui/$(id -u)/com.jarvis.docs-index
```

### WhatsApp disconnected (Bad MAC)
Normal during reconnection. If persistent, delete `wa-auth/` and re-run pairing.

### Router PID lock stuck
If the router won't start ("Another instance is already running"):
```bash
rm ~/.claude/jarvis/router/jarvis-router.pid
launchctl kickstart -k gui/$(id -u)/com.jarvis.router
```

## Useful Commands
```bash
# Check all services health (from dashboard API)
curl localhost:3340/api/services

# Reindex the docs-index
curl -X POST localhost:3342/reindex

# Search docs
curl "localhost:3342/search?q=query+terms&scope=business"

# Memory stats
curl localhost:3340/api/memory/stats

# Kill a stuck Claude process
curl -X POST localhost:3340/api/kill/telegram:<chat-id>

# CLI sessions
curl localhost:3340/api/cli-sessions
```

## Config Changes
Edit `config.yaml` → restart router (`launchctl kickstart -k gui/$(id -u)/com.jarvis.router`)
Edit `CLAUDE.md` agents → process auto-reads on next spawn
Edit dashboard → `npm run build` inside `router/dashboard/` and restart the router

## OpenAI Key
Used for: nothing mandatory. The docs-index uses local ONNX embeddings.
Set via env in `.env`: `OPENAI_API_KEY=sk-...`.
Models (local): `all-MiniLM-L6-v2` ONNX (docs-index, in `state/models/`, venv `router/scripts/docs-env`).

## Whisper
- Binary: `/opt/homebrew/bin/whisper-cli`
- Model: download `ggml-large-v3.bin` and point the router at the file
- Used for: voice messages on all channels

## Channel caveats

- **Telegram / Discord** — both officially support bots. Create a bot via
  @BotFather / the Discord developer portal, keep the token in `router/.env`.
- **WhatsApp (Baileys)** — Baileys is an **unofficial** WhatsApp Web client
  (reverse-engineered protocol). Meta's Terms of Service don't allow automated
  clients on consumer accounts, and connecting your main number carries a
  non-zero risk of a ban. For anything beyond personal experimentation, or any
  client-facing / commercial use, migrate to the official [WhatsApp Business
  Platform / Cloud API](https://developers.facebook.com/docs/whatsapp). Also
  remember that bots on any channel should disclose that they are AI powered
  by Claude (see `README.md` → Responsible use).
