# Jarvis Router — Architecture

## Overview
Multi-channel router connecting Telegram, WhatsApp, and Discord to the Claude Code CLI.
Each channel has routes with per-agent capabilities and scoping.

## Stack
- **Runtime**: Node.js + tsx (TypeScript)
- **CLI Backend**: Claude Code CLI (`~/.local/share/claude/versions/<version>`)
- **Process model**: 1 persistent process per session key, serial queue, timeout/fallback
- **Config**: YAML (`config.yaml`)
- **Dashboard**: HTTP :3340, HTTPS :3341 (self-signed)

## Core Services (always present)

| Servizio | Porta | Processo | Path |
|----------|-------|----------|------|
| Router | 3340/3341 | com.jarvis.router (launchd) | `~/.claude/jarvis/router/` |
| ChromaDB | 3342 | com.jarvis.chroma (launchd) | `scripts/chroma-server.py` |
| Mem0 | 3343 | com.jarvis.mem0 (launchd) | `scripts/mem0-server.py` |
| Tray App | — | JarvisTray | `~/.claude/jarvis/tray-app/` |

Extra services can be added via a `services:` section in `router/config.yaml`
(see `router/config.example.yaml`). They show up in the dashboard and can be
managed by the tray app if they provide a `launchd:` config.

## Directory Structure
```
~/.claude/jarvis/
├── router/                    # Main router
│   ├── src/
│   │   ├── index.ts          # Entry point
│   │   ├── connectors/       # TG, WA, Discord
│   │   ├── services/
│   │   │   ├── claude.ts     # Persistent process manager
│   │   │   ├── handler.ts    # Message handler + media compose
│   │   │   ├── media.ts      # Whisper, vision, file extract
│   │   │   ├── memory.ts     # ChromaDB + Mem0 client
│   │   │   ├── router.ts     # Route matching
│   │   │   ├── services.ts   # Service registry + launchd plist builder
│   │   │   ├── config-loader.ts
│   │   │   └── logger.ts
│   │   ├── dashboard/
│   │   │   └── server.ts     # Dashboard + API
│   │   └── types/
│   │       ├── config.ts     # AgentConfig, ServiceDef, Capabilities
│   │       └── message.ts    # IncomingMessage, Media
│   ├── scripts/
│   │   ├── chroma-server.py  # ChromaDB HTTP API
│   │   └── mem0-server.py    # Mem0 HTTP API
│   ├── config.yaml           # Route config (gitignored)
│   ├── certs/                # Self-signed TLS
│   └── wa-auth/              # WhatsApp session
├── agents/                   # Per-agent workspaces (gitignored)
├── memory/                   # Markdown memory (gitignored)
├── tray-app/                 # macOS menu bar app (Swift/SwiftUI)
├── media/                    # Temp media files (gitignored)
├── logs/                     # Service logs (gitignored)
├── chroma-data/              # ChromaDB persistence (gitignored)
├── mem0-data/                # Qdrant vectors (gitignored)
└── mem0-history.db           # Mem0 SQLite (gitignored)
```

## Routing

Routes are thin matchers that map (channel, from/group/guild) to an agent
defined in `agents/<name>/`. Agent behavior (model, tools, MCP, fullAccess,
effort) lives in `agents/<name>/agent.yaml`, not in `config.yaml`.

Routes are evaluated in order: first match wins. Include a catch-all
`{ channel: "*", action: "ignore" }` to drop unmatched messages.

### Capabilities per route
```
vision, voice, email, calendar, subagents, fileAccess,
webSearch, memory, documents, config, launchAgents, mcp
```

## Media Pipeline
```
Connector receives media
  → download to ~/.claude/jarvis/media/
  → process:
    voice/audio → ffmpeg → whisper-cli (large-v3) → text
    image → base64 → Claude vision (content blocks)
    document → pdftotext / readFile → text
    video → ffmpeg extract audio → whisper → text
  → compose full message with [Voice: ...], [Image: ...], [Quoted: ...]
  → send to Claude persistent process
  → cleanup temp files
```

## Memory System
- **ChromaDB** (localhost:3342): indexes `.md` files scoped by agent
- **Mem0** (localhost:3343): extracts facts from conversations, auto-saved after each reply
- **Embeddings**: OpenAI text-embedding-3-small
- **LLM for facts**: OpenAI gpt-4.1-nano

## Process Model
- 1 persistent Claude CLI process per session key
- Serial queue per key (no concurrent messages)
- 5 min message timeout, 15 min inactivity kill, 2h max lifetime
- Model fallback: opus → haiku on rate limit
- Crash recovery: respawn on next message

## LaunchAgents
Core (always present) in `~/Library/LaunchAgents/`:
- `com.jarvis.router` — KeepAlive
- `com.jarvis.chroma` — KeepAlive
- `com.jarvis.mem0` — KeepAlive
- `com.jarvis.tray` — RunAtLoad

User services from `config.yaml` generate their own `com.<user>.<name>.plist`.

## Key Decisions
- Claude Code CLI as backend (not SDK) — OAuth subscription, no API key needed
- launchd per service management (no pm2, no Docker)
- Spawn discipline (see `services/claude.ts` `buildSpawnArgs()`):
  - `--strict-mcp-config` always so nothing leaks from user scope
  - `--setting-sources user,project,local` to inherit the CLI ecosystem (hooks, commands, agents, skills, plugins)
  - `--mcp-config` inline, filtered per-route tool list, or all shared servers when `fullAccess`
  - `JARVIS_SPAWN=1` env var so user hooks can self-guard
- Identity (two layers only — no extra append):
  - `~/.claude/CLAUDE.md` → user-global common layer
  - `<workspace>/CLAUDE.md` → agent-specific identity (auto-loaded from cwd)
- MCP servers live in `~/.claude/settings.json` — single source of truth between the interactive CLI and Jarvis
- MCP only on routes that require it (per-route filter via `mcp:<name>` tool entries, or all via `fullAccess: true`)
- No Docker — fully native (embedded Qdrant, SQLite)
- OpenAI for embeddings only (cheap), Claude for everything else
- Vision via Claude content blocks (not GPT-4 Vision)
