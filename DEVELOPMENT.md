# Jarvis Router — Developer Guide

> For working on the router codebase. NOT loaded at agent runtime (this file is not CLAUDE.md).

## Working on this project
- Runtime: Node.js + tsx, NOT Bun
- Use `import { spawn } from "child_process"`, NOT `Bun.spawn`
- TypeScript: check with `npx tsc --noEmit` before restart
- Restart: `launchctl kickstart -k gui/$(id -u)/com.jarvis.router`
- Dashboard changes require router restart

## Key files
- `ARCHITECTURE.md` — full system architecture, ports, directory structure
- `SETUP.md` — how to start, troubleshoot, useful commands
- `TODO.md` — roadmap and known issues
- `router/config.yaml` — route configuration (source of truth)
- `router/src/` — TypeScript source
- `agents/*/CLAUDE.md` — per-agent system prompts

## Spawn discipline (`services/claude.ts` `buildSpawnArgs()`)
- `--strict-mcp-config` always (nothing leaks from user scope)
- `--setting-sources user,project,local` by default; `project,local` when `inheritUserScope: false`
- `--mcp-config` inline, filtered per-route tools (or all when `fullAccess`)
- `JARVIS_SPAWN=1` env var so user hooks can self-guard (see `~/.claude/notify.sh`)
- `fileAccess:readonly` → `acceptEdits` + `--disallowed-tools "Write Edit NotebookEdit ..."` (bypassPermissions would skip the disallowed list)

## Identity model
TWO layers only:
- `~/.claude/CLAUDE.md` = user-global common layer
- `<workspace>/CLAUDE.md` = agent-specific identity
- NEVER add a third layer via `--append-system-prompt` — it fights agent-specific rules.

## Changelog
Update `CHANGELOG.md` → `[Unreleased]` on user-facing changes. Skip internal refactors, typos, gitignored files.

## Contributing back upstream
Upstream-worthy (ask user first, then open PR to `zorahrel/jarvis-claudecode:main`):
- Bugs in `router/src/`, `router/dashboard/`, `router/scripts/*.py`
- New channels, capabilities, tools, dashboard features
- Setup / CI / docs fixes, new agent templates under `agents.example/`

Never upstream: `router/.env`, `router/config.yaml`, `agents/<name>/*`, `memory/*`, `chroma-data/*`, `wa-auth/*`, logs, anything with phone numbers / IDs / tokens.

Workflow: `git checkout -b fix/<slug>` → commit → `npx tsc --noEmit` → `npm run build` (dashboard if changed) → PR. Always confirm with user before pushing.
