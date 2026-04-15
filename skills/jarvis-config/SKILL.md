---
name: jarvis-config
description: Add or modify Jarvis Claude Code channels, routes, agents, and cron jobs by editing router/config.yaml and scaffolding agents/<name>/. Use when the user wants to connect Telegram/WhatsApp/Discord, create a new agent, route a chat to an existing agent, schedule a cron, or expose extra services in the dashboard.
---

# Jarvis Config Skill

You edit Jarvis configuration for the user. Two files and one folder are your surface area:

- `router/.env` — bot tokens. Never commit, never print to chat.
- `router/config.yaml` — channels, routes, rate limits, crons, services.
- `agents/<name>/` — one folder per agent with `agent.yaml` + `CLAUDE.md`.

Routes are evaluated top-down, first match wins. A `channel: "*"` with `action: ignore` at the bottom is the catch-all.

## Workflows

Before editing anything, read the current `router/config.yaml` so the new entry fits the existing style and the route order stays correct.

### Add a Telegram bot

1. Ask the user for the bot token (from @BotFather) and their Telegram numeric user ID (from @userinfobot).
2. Write `TELEGRAM_BOT_TOKEN=<token>` into `router/.env`.
3. In `config.yaml`, ensure `channels.telegram.enabled: true`.
4. Insert a route above the catch-all: `{ channel: telegram, from: <id> } → use: <agent>`.
5. Tell the user to restart the router: `launchctl kickstart -k gui/$(id -u)/com.jarvis.router` (macOS) or stop/start `npm start`.

### Add a WhatsApp number

1. Ensure `channels.whatsapp.enabled: true`.
2. Add the user's phone (E.164, `+39...`) to `jarvis.allowedCallers` so they can @mention Jarvis in groups.
3. Add a route `{ channel: whatsapp, from: "+39..." } → use: <agent>` for DM, or `{ channel: whatsapp, group: "<jid>@g.us" }` for a group.
4. First launch will print a QR code in the router logs (`~/.claude/jarvis/logs/router.log`) — the user scans it from WhatsApp → Linked Devices.

### Add a Discord bot

1. Token from Discord Developer Portal → Bot → Reset Token. Write `DISCORD_BOT_TOKEN=<token>` into `router/.env`.
2. Ensure `channels.discord.enabled: true`.
3. Get the user's Discord numeric user ID (Settings → Advanced → Developer Mode → right-click self → Copy User ID).
4. DM route: `{ channel: discord, from: "<id>" } → use: <agent>`. Server route: `{ channel: discord, guild: "<guildId>" } → use: <agent>`.

### Create a new agent

Copy the template and edit:

```bash
cp -r agents.example/default agents/<name>
```

Then edit `agents/<name>/agent.yaml` (model, tools, fileAccess, memory scope, MCP servers) and `agents/<name>/CLAUDE.md` (identity, rules, tone, language). Route to it from `config.yaml` with `use: <name>`.

Agent `agent.yaml` essentials:

```yaml
model: opus                    # opus | sonnet | haiku
effort: high                   # low | medium | high | max
fallbacks: [haiku]             # on rate limit
# fullAccess: true             # DANGEROUS — unrestricted bash/file access
tools:
  - vision
  - voice
  - fileAccess:readonly        # readonly | full
  - memory:global              # scope name — business | global | custom
  - documents                  # ChromaDB doc search
  - email:personal             # gws-mail account name
  - mcp:context7               # any MCP server in ~/.claude/settings.json
inheritUserScope: false        # set for external/client agents — don't read ~/.claude/CLAUDE.md
```

### Schedule a cron

```yaml
crons:
  - name: daily-standup
    schedule: "0 9 * * *"          # cron expression
    timezone: Europe/Rome
    workspace: ./agents/default    # agent folder = cwd for the Claude session
    model: opus
    prompt: "Summarize today's calendar and unread email."
    timeout: 300                   # seconds
    delivery:
      channel: telegram
      target: "<chat-id>"
```

Each cron run is a fresh Claude Code session (clean context window).

### Register an extra service in the dashboard

```yaml
services:
  - name: MyService
    port: 3335
    healthUrl: http://localhost:3335/health
    linkUrl: http://localhost:3335
    launchd:                          # optional — enables tray app control
      label: com.example.myservice    # match ^[a-z][a-z0-9._-]{0,63}$
      args: [node, ~/path/to/app.js]
      cwd: ~/path/to
```

Core services (Router, ChromaDB, OMEGA) are automatic — don't list them.

## Rules

- Always read `router/config.yaml` before editing so you insert entries in the right place and don't duplicate.
- Keep the catch-all `{ channel: "*", action: ignore }` route last. New routes go above it.
- Never print secrets in chat. If a token shows up in tool output (e.g., `cat .env`), redact it.
- Never commit `.env`, `config.yaml`, or `agents/*` — they're gitignored.
- After edits, remind the user to restart the router. On macOS: `launchctl kickstart -k gui/$(id -u)/com.jarvis.router`.
- Don't add npm dependencies or modify `services/claude.ts` spawn logic for "config" tasks. If the request needs code changes, say so and stop.

## References

Canonical example with every field commented: `router/config.example.yaml`.
Agent template: `agents.example/default/`.
Deeper docs: `ARCHITECTURE.md`, `SETUP.md`.
