# Jarvis

> Multi-channel AI assistant router that connects Telegram, WhatsApp and Discord to Claude Code CLI.

Jarvis is a personal AI gateway. Incoming messages across chat platforms are matched against per-route agents, each with its own identity (CLAUDE.md), tool scope, memory and model. A persistent Claude Code process runs per session key, so conversations retain context across messages.

## Features

- **Channels**: Telegram, WhatsApp (via Baileys), Discord
- **Per-route agents**: each agent lives in `agents/<name>/` with its own `agent.yaml` + `CLAUDE.md`
- **Media pipeline**: voice → Whisper, images → Claude vision, PDFs/docs → text, quoted replies as context
- **Memory**: ChromaDB (document RAG) + Mem0 (conversation fact extraction)
- **Dashboard**: React SPA at `http://localhost:3340` — routes, agents, tools, memory, costs, logs
- **macOS tray app**: SwiftUI menu bar app to start/stop/restart services
- **Config-driven services**: add extra services to `config.yaml` and they show up in the dashboard + tray
- **Native launchd**: no Docker, no pm2 — services are managed as LaunchAgents

## Requirements

- macOS (tested on 15+) — tray app is macOS-only; the router itself is cross-platform
- Node.js >= 20 (via [nvm](https://github.com/nvm-sh/nvm) recommended) + `tsx`
- Python 3.11+ (for ChromaDB and Mem0 servers)
- [Claude Code CLI](https://docs.claude.com/en/docs/claude-code)
- `ffmpeg`, `whisper-cli` (whisper.cpp), `pdftotext` for media processing
- An OpenAI API key (used only for embeddings and Mem0 fact extraction)

## Install

```bash
git clone https://github.com/<you>/jarvis.git ~/.claude/jarvis
cd ~/.claude/jarvis/router

# Install deps
npm install

# Copy example configs
cp .env.example .env
cp config.example.yaml config.yaml

# Edit .env with your bot tokens and OpenAI key
# Edit config.yaml with your phone number / telegram ID / discord ID / routes

# Copy agent template
mkdir -p ../agents
cp -r ../agents.example/default ../agents/default
# Edit ../agents/default/CLAUDE.md and agent.yaml
```

Then either run directly:

```bash
cd ~/.claude/jarvis/router
npm start
```

Or install as a LaunchAgent so it auto-starts on login:

```bash
# Example plist at ~/Library/LaunchAgents/com.jarvis.router.plist
# (see SETUP.md for the full template)
launchctl load ~/Library/LaunchAgents/com.jarvis.router.plist
```

Open the dashboard at <http://localhost:3340>.

## Configuration

Two files you own:

- **`router/.env`** — secrets (bot tokens, OpenAI key). Never commit.
- **`router/config.yaml`** — routes, channels, rate limits, extra services, cron jobs.

Agents live in `~/.claude/jarvis/agents/<name>/` and are referenced from `config.yaml` routes via `use: <name>`. See `agents.example/default/` for a template.

### Extra services

Add any service to the dashboard ribbon + tray app by listing it under `services:` in `config.yaml`:

```yaml
services:
  - name: MyService
    port: 3335
    healthUrl: http://localhost:3335/health
    linkUrl: http://localhost:3335       # optional
    launchd:                              # optional — enables tray management
      label: com.example.myservice
      args:
        - node
        - ~/path/to/app.js
      cwd: ~/path/to
```

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full system overview, directory structure, and design decisions. See [`SETUP.md`](SETUP.md) for operational commands and troubleshooting.

## Project layout

```
.
├── router/          # TypeScript router (entry point, channels, dashboard API)
│   ├── src/
│   ├── dashboard/   # React SPA (Vite)
│   ├── scripts/     # ChromaDB + Mem0 Python servers
│   └── config.example.yaml
├── agents.example/  # Agent template (copy to agents/<name>/)
├── tray-app/        # macOS SwiftUI menu bar app
├── research/        # Notes comparing adjacent projects
├── ARCHITECTURE.md
├── SETUP.md
├── CLAUDE.md        # Project instructions for Claude Code contributors
└── TODO.md
```

## License

[MIT](LICENSE)
