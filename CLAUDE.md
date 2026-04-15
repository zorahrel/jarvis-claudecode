# Jarvis Router — Project CLAUDE.md

## What is this
Multi-channel AI assistant router. Connects Telegram, WhatsApp, Discord to Claude Code CLI
with per-route agents, capabilities, memory (ChromaDB + OMEGA), media processing, and a web dashboard.

## Key files
- `ARCHITECTURE.md` — full system architecture, ports, directory structure
- `SETUP.md` — how to start, troubleshoot, useful commands
- `TODO.md` — roadmap and known issues
- `router/config.yaml` — route configuration (source of truth)
- `router/src/` — TypeScript source
- `agents/*/CLAUDE.md` — per-agent system prompts
- `tray-app/` — macOS menu bar app (Swift)

## Working on this project
- Runtime: Node.js + tsx, NOT Bun
- Use `import { spawn } from "child_process"`, NOT `Bun.spawn`
- TypeScript: check with `npx tsc --noEmit` before restart
- Restart: `launchctl kickstart -k gui/$(id -u)/com.jarvis.router` (router runs under launchd, not pm2)
- Dashboard changes require router restart
- Tray app: `cd tray-app && swift build && pkill JarvisTray && .build/debug/JarvisTray &`

## Rules
- Never hardcode secrets in source — use env vars or config.yaml
- Don't break existing routes when adding features
- Spawn discipline (see `services/claude.ts` `buildSpawnArgs()`):
  - `--strict-mcp-config` always (nothing leaks from user scope)
  - `--setting-sources user,project,local` by default; `project,local` when agent.yaml sets `inheritUserScope: false` (external/client agents that must not see `~/.claude/CLAUDE.md`, hooks, or global skills)
  - `--mcp-config` inline, filtered per-route tools (or all shared servers when `fullAccess`)
  - `JARVIS_SPAWN=1` env var so user hooks can self-guard (see `~/.claude/notify.sh`)
  - `fileAccess:readonly` → `acceptEdits` + `--disallowed-tools "Write Edit NotebookEdit ..."` (bypassPermissions would skip the disallowed list)
- Identity: TWO layers only, no extras:
  - `~/.claude/CLAUDE.md` = user-global common layer (loaded automatically by Claude Code)
  - `<workspace>/CLAUDE.md` = agent-specific identity (auto-loaded from cwd)
  - NEVER add a third layer via `--append-system-prompt` — it will fight agent-specific rules (language, scope, branding).
- All shell operations in tray app MUST be on background thread (main thread = crash)
- Config edits: edit YAML, restart router. Don't write JS config loaders.
- Test media pipeline end-to-end after changes (send voice/image on TG)
- Dashboard is a React SPA in `router/dashboard/` (Vite) — run `npm run build` there before restarting router

## Port map
3340: Router HTTP | 3341: Router HTTPS | 3342: ChromaDB | 3343: OMEGA

Extra services (any port) are user-configurable under `services:` in `config.yaml`.

## Don't
- Don't use Docker
- Don't add npm dependencies without good reason
- Don't hardcode extra services in source — use the `services:` section of `config.yaml`
- Don't modify agents' CLAUDE.md without understanding the scoping
