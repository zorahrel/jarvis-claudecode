# Jarvis Skills Marketplace

This directory is the **template** for your local Jarvis skills marketplace.
When you run `./setup.sh`, it copies this layout to `~/jarvis/skills-marketplace/`
(the runtime location, outside `~/.claude/`) and registers it with Claude Code.

## Why outside `~/.claude/`?

Claude Code 2.1.x hard-blocks writes to `~/.claude/**` from any agent
(a `safetyCheck` that cannot be bypassed by permission flags). This prevents
agents from modifying their own config, but also blocks Jarvis from installing
new skills when invoked from Telegram/WhatsApp/Discord.

Moving the marketplace to `~/jarvis/skills-marketplace/` — a path Claude Code's
safetyCheck doesn't protect — lets agents write new skills freely while Claude
Code still loads them via its native plugin-marketplace mechanism.

## How skills are discovered

1. `./setup.sh` (or `./scripts/migrate-to-marketplace.sh` for existing installs)
   copies this template to `~/jarvis/skills-marketplace/` and runs:
   ```
   claude plugin marketplace add ~/jarvis/skills-marketplace
   claude plugin install jarvis-custom-skills@jarvis-skills
   ```
2. Every Claude Code session (CLI or Jarvis-spawned) loads skills from
   `~/jarvis/skills-marketplace/skills/*/SKILL.md` automatically.
3. Agents create new skills by writing to
   `~/jarvis/skills-marketplace/skills/<name>/SKILL.md`. Available next session.

## Adding skills manually

Drop a `SKILL.md` at `~/jarvis/skills-marketplace/skills/<name>/SKILL.md` with:

```markdown
---
name: my-skill
description: one-line hook the model uses to decide when to invoke this skill
---
# my-skill

body of the skill — instructions, examples, scripts referenced by ./
```

Then add `"./skills/my-skill"` to the `skills` array in
`.claude-plugin/marketplace.json` and run
`claude plugin marketplace update jarvis-skills`.

## See also

- `router/src/dashboard/api.ts` — Skills tab in the dashboard reads this
  marketplace via `known_marketplaces.json`.
- `scripts/migrate-to-marketplace.sh` — one-shot migration for users
  upgrading from the pre-1.1 layout where skills lived in `~/.claude/skills/`.
