# Jarvis — Setup & Operations

## Prerequisites
- Node.js (nvm, >= v20) + tsx
- Python 3.11+ (homebrew)
- Claude Code CLI
- ffmpeg, whisper-cli, pdftotext

## Quick Start
```bash
# Start core services via launchctl (Router, ChromaDB, OMEGA)
launchctl load ~/Library/LaunchAgents/com.jarvis.router.plist
launchctl load ~/Library/LaunchAgents/com.jarvis.chroma.plist
launchctl load ~/Library/LaunchAgents/com.jarvis.omega.plist

# Tray app (manages start/stop/restart of services)
~/.claude/jarvis/tray-app/.build/release/JarvisTray &
```

## Build Tray App
```bash
cd ~/.claude/jarvis/tray-app
swift build -c release
cp .build/release/JarvisTray ~/bin/jarvis-tray
```

## Services

Core (always present, hardcoded):

| Service | Port | LaunchAgent | Health |
|---------|------|-------------|--------|
| Router | 3340/3341 | com.jarvis.router | `curl localhost:3340/api/stats` |
| ChromaDB | 3342 | com.jarvis.chroma | `curl localhost:3342/health` |
| OMEGA | 3343 | com.jarvis.omega | `curl localhost:3343/health` |

Extra services: add a `services:` section in `router/config.yaml` (see `config.example.yaml`).
They appear in the dashboard and are managed by the tray if they provide `launchd:`.

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

### ChromaDB/OMEGA down
```bash
curl localhost:3342/health
curl localhost:3343/health
# Restart:
launchctl kickstart -k gui/$(id -u)/com.jarvis.omega
launchctl kickstart -k gui/$(id -u)/com.jarvis.chroma
```

### OMEGA DB locked
OMEGA uses SQLite; concurrent writers can occasionally leave a stray lock.
Stop the service and let it restart cleanly:
```bash
launchctl stop com.jarvis.omega
rm -f ~/.omega/omega.db-journal
launchctl start com.jarvis.omega
```

### WhatsApp disconnected (Bad MAC)
Normal during reconnection. If persistent, delete `wa-auth/` and re-run pairing.

### Tray app crash
Usually `shell()` called on the main thread. All shell ops must run in the background.
```bash
pkill JarvisTray
~/.claude/jarvis/tray-app/.build/debug/JarvisTray &
```

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

# Reindex ChromaDB
curl -X POST localhost:3342/reindex

# Search memories
curl "localhost:3343/search?q=example&user_id=business"

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
Used for: nothing mandatory. Both ChromaDB and OMEGA use local ONNX embeddings.
Set via env in `.env`: `OPENAI_API_KEY=sk-...`.
Models (local): `all-MiniLM-L6-v2` (ChromaDB), `bge-small-en-v1.5` (OMEGA).

## Whisper
- Binary: `/opt/homebrew/bin/whisper-cli`
- Model: download `ggml-large-v3.bin` and point the router at the file
- Used for: voice messages on all channels
