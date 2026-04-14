# Jarvis — Setup & Operations

## Prerequisites
- Node.js (nvm, >= v20) + tsx
- Python 3.11+ (homebrew)
- Claude Code CLI
- ffmpeg, whisper-cli, pdftotext

## Quick Start
```bash
# Start core services via launchctl (Router, ChromaDB, Mem0)
launchctl load ~/Library/LaunchAgents/com.jarvis.router.plist
launchctl load ~/Library/LaunchAgents/com.jarvis.chroma.plist
launchctl load ~/Library/LaunchAgents/com.jarvis.mem0.plist

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

Core (sempre presenti, hardcoded):

| Service | Port | LaunchAgent | Health |
|---------|------|-------------|--------|
| Router | 3340/3341 | com.jarvis.router | `curl localhost:3340/api/stats` |
| ChromaDB | 3342 | com.jarvis.chroma | `curl localhost:3342/health` |
| Mem0 | 3343 | com.jarvis.mem0 | `curl localhost:3343/health` |

Servizi extra: aggiungi una sezione `services:` in `router/config.yaml` (vedi `config.example.yaml`).
Vengono mostrati nel dashboard e gestiti dalla tray se forniscono `launchd:`.

Tutti i servizi launchd usano `KeepAlive: true` (auto-restart on crash).

## Key Paths
- Config: `~/.claude/jarvis/router/config.yaml`
- Dashboard: http://localhost:3340
- Logs: `~/.claude/jarvis/logs/`
- Memory: `~/.claude/jarvis/memory/`
- LaunchAgents: `~/Library/LaunchAgents/com.jarvis.*.plist`

## Troubleshooting

### Bot non risponde su TG
```bash
tail -30 ~/.claude/jarvis/logs/router.log
# Se timeout:
launchctl kickstart -k gui/$(id -u)/com.jarvis.router
```

### ChromaDB/Mem0 down
```bash
curl localhost:3342/health
curl localhost:3343/health
# Restart:
launchctl kickstart -k gui/$(id -u)/com.jarvis.mem0
launchctl kickstart -k gui/$(id -u)/com.jarvis.chroma
```

### Mem0 Qdrant lock error
`mem0-server.py` auto-clears stale locks at startup. Se insiste:
```bash
launchctl stop com.jarvis.mem0
rm ~/.claude/jarvis/mem0-data/.lock
launchctl start com.jarvis.mem0
```

### WhatsApp disconnected (Bad MAC)
Normale durante reconnection. Se persistente, cancella `wa-auth/` e ri-esegui il pairing.

### Tray app crash
Di solito `shell()` chiamata dal main thread. Tutte le shell op devono girare in background.
```bash
pkill JarvisTray
~/.claude/jarvis/tray-app/.build/debug/JarvisTray &
```

### Router PID lock stuck
Se il router non parte ("Another instance is already running"):
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
Edit dashboard → `npm run build` dentro `router/dashboard/` e restart router

## OpenAI Key
Usato per: ChromaDB embeddings, Mem0 embeddings/LLM.
Set via env in `.env`: `OPENAI_API_KEY=sk-...`.
Modelli: `text-embedding-3-small` (embeddings), `gpt-4.1-nano` (Mem0 fact extraction).

## Whisper
- Binary: `/opt/homebrew/bin/whisper-cli`
- Model: scarica `ggml-large-v3.bin` e punta il router al file
- Usato per: voice messages su tutti i canali
