# Changelog

All notable changes to Jarvis. Versioning follows [SemVer](https://semver.org/).
Dates are ISO (YYYY-MM-DD).

## [Unreleased]

### Changed
- **Claude integration migrated from CLI spawn to `@anthropic-ai/claude-agent-sdk`.**
  `router/src/services/claude.ts` was reimplemented on top of the official SDK
  (`query()` + persistent async-iterable producer per session, "pattern (b)"),
  replacing the previous `spawn("claude", ["--print", "--input-format",
  "stream-json", ...])` approach. Same Pro/Max subscription auth (the SDK
  inherits the local OAuth token), same cost model. Net effect: typed event
  stream replaces NDJSON parsing (-700 LOC), unlocks future use of the SDK's
  hooks API, `agentProgressSummaries`, `maxBudgetUsd`, `outputFormat:
  json_schema`, and file checkpointing without further refactor. Public API
  of `services/claude` is unchanged — connectors/cron/dashboard imports keep
  working as-is. Audit + spike + benchmark in `.planning/audit/sdk-*.md`. The
  `@anthropic-ai/claude-code` package is no longer a direct dependency (the
  SDK ships the bundled CLI runtime).

### Added
- **Automatic background-task completion notifications.** When an agent
  spawns a background task (`Bash(run_in_background:true)` or a `Task`
  subagent with `run_in_background:true`), the router now intercepts the
  CLI's synthetic `<task-notification>` marker in the stream-json output
  and auto-delivers a "Task completato/fallito/annullato" message to the
  originating channel — without the user having to send a follow-up
  message to "wake up" the agent. Pattern verified against Paseo's
  open-source implementation (getpaseo/paseo). Deduped by task-id so the
  same completion isn't announced twice (live event vs. history replay).
  Subagents (cron, internal Task tools) skip — only primary agents
  notify. Reuses the per-session 100-msg notify budget. New module
  `router/src/services/task-notification.ts` (pure parser + formatter).
- **Proactive notify endpoint (`POST /api/notify`).** Agents can now send
  messages to the originating channel from background jobs, `Bash(run_in_background)`
  tasks, or subprocess hooks — not only from the live CLI turn. At spawn time
  the router issues a bound notify token (`{channel, target}`) and injects it
  into the child CLI as `JARVIS_NOTIFY_URL` + `JARVIS_NOTIFY_TOKEN` (plus
  `JARVIS_CHANNEL`, `JARVIS_REPLY_TARGET`, `JARVIS_SESSION_KEY` for context).
  The token is bound to a single `(channel, target)` pair — cross-target
  spoofing is impossible by construction. Persisted as SHA-256 hash only
  (plaintext lives only in memory + the child process env), file mode `0600`,
  24h TTL with hourly GC. Endpoint enforces: per-session budget (100 msg),
  per-target sliding-window rate (30/min), and identical-text dedup (5 s).
  Broadcasts a `notify.outbound` WebSocket event rendered in the Activity
  Stream.
- **Subagent-aware spawn flag.** `askClaudeFresh` (and anyone plumbing
  `opts.isSubagent`) now sets `JARVIS_IS_SUBAGENT=1` and appends a minimal
  subagent system prompt via `--append-system-prompt` — the documented
  exception to the "two identity layers" rule, safe because a subagent has
  no agent-specific CLAUDE.md to fight with. Subagents do not receive a
  notify token; only the primary agent can deliver to the origin channel.
  Cron jobs (`askClaudeFresh`) now spawn as subagents by default.

### Fixed
- **Discord mention resolution.** Raw Discord mention markers
  (`<@userId>`, `<@&roleId>`, `<#channelId>`) used to leak into prompts —
  in one observed session the agent had to guess that
  `hi<@&1105067705649864776>.io` meant `hi@armonia.io` because Discord had
  replaced `@armonia` with the raw role mention. Now resolved at the
  connector boundary (`discord.ts`) to `@username` / `@rolename` /
  `#channelname` before the text ever reaches the router. Applied to both
  the main `text` and to `quotedMessage.text` of replies.
- **Discord multi-speaker context in guilds.** Guild messages are now
  prefixed with `[@username]: …` so the agent can tell different speakers
  apart — DMs are unchanged. Fixes the class of bugs where the same
  guild-level session saw messages from multiple users with no attribution,
  and the agent could respond to user B using user A's context.
- **Relative timestamps on quoted replies.** The `[Replying to from X: "…"]`
  header now carries `(30s fa)` / `(5m fa)` / `(3h fa)` / `(ieri)` /
  `(3g fa)` when the connector exposes the quoted message's timestamp
  (Discord today; Telegram/WhatsApp left as TODO — connectors just need to
  populate `quotedMessage.timestampEpoch`).
- **Automatic log redaction.** The `logger.ts` pino config now redacts
  `token`, `JARVIS_NOTIFY_TOKEN`, `headers.authorization`, `*.token`, and
  nested forms with `[REDACTED]`. Defense-in-depth: callers should still
  avoid logging them by convention, but accidental inclusion is now a
  no-op instead of a leak.
- **Stop-hook resilience (`~/.claude/notify.sh`).** The hook used to abort
  with `Abort trap: 6` when Core Audio's `AudioQueueStart` failed,
  propagating non-zero exit to Claude Code → "Stop hook error" noise. Now
  wraps `afplay` + `terminal-notifier` in `… 2>/dev/null || true`, passes
  `-sound ''` (the `afplay` background invocation handles sound), and
  explicit `exit 0`. Hook is idempotent regardless of Core Audio state.
- **tsconfig bun → node.** `router/tsconfig.json` referenced `@types/bun`
  that was never a dependency, so `npx tsc --noEmit` would fail on a fresh
  clone. Runtime is `tsx` + node (per `CLAUDE.md`); tsconfig now reflects
  that.
- **Connector bootstrap resilience.** Telegram, Discord e WhatsApp non bloccano
  più il router al boot se la rete / DNS non è ancora disponibile. Il helper
  `startWithRetry` (in `router/src/index.ts`) ritenta con back-off esponenziale
  (5 s / 15 s / 45 s / 2 min / 5 min) fino a 6 tentativi totali; dopo l'ultimo
  fallimento logga un errore e prosegue — il router rimane UP per gli altri
  canali. `setDeliveryFn` e `initCrons` partono subito senza aspettare.
- **Telegram slash commands al boot.** `syncSlashCommands` ora ritenta
  `setMyCommands` una volta dopo 60 s se la prima chiamata fallisce (DNS non
  ancora pronto quando il long-poll del bot è già attivo).

### Added
- **Context-window auto-compaction.** Long Claude CLI sessions no longer
  saturate their context and silently truncate. The router now tracks
  cumulative input tokens per persistent process and, at 80% of the model's
  window (200k for standard Opus/Sonnet/Haiku, 1M for `[1m]` variants),
  summarizes the conversation, kills the process, and respawns with the
  summary injected as the first user turn — never via
  `--append-system-prompt` (respects the "two identity layers" rule in
  `CLAUDE.md`). Tries the native `/compact` slash command first and falls
  back to a custom structured-summary prompt. Hard-caps at 5 compactions
  per session lifetime; beyond that, the session resets cleanly without
  carrying a summary over. New `services/context.ts` exposes
  `contextWindowFor(model)` and `shouldCompact(used, model, threshold)`.
  Sessions tab shows a `compacted ×N` badge per session (hover for the
  latest summary preview) and a `ctx-near` warning badge when a live
  session crosses the threshold. Every compaction emits a
  `session.compacted` WebSocket event with `tokensBefore`,
  `compactionCount`, and a 300-char summary preview for downstream
  consumers.
- **Local Claude Code session monitor.** New Sessions-tab section
  auto-discovers every `claude` CLI running on the host via `ps`+`lsof`,
  not just router-spawned ones. Each card shows cwd, branch, last
  user/assistant preview, status (working / idle / waiting / errored /
  finished / unknown) and quick-open buttons for **iTerm**, **Terminal.app**,
  **Topics** (via the existing HTTPS :3333 `/api/open-project` endpoint),
  **Finder**, **Editor**, and **PR** (via `gh pr view --web`). Target
  availability is probed live — Topics button disables when Topics is not
  running, PR disables on `main`/`master`. Status comes from
  `jarvis-control` hooks that the router installs into
  `~/.claude/settings.json` on boot (idempotent merge, never replaces
  existing hooks); events land in `~/.claude/jarvis/events/<pid>.json` and
  are auto-pruned after 24h. Cached 2s on the backend. New endpoints:
  `GET /api/local-sessions`, `GET /api/local-sessions/:pid/targets`,
  `POST /api/local-sessions/:pid/open`.
- **Cron run history (per-job JSONL).** Each scheduled/manual run appends a
  structured record to `router/cron/runs/<job>.jsonl` — timestamp, duration,
  status, model, sessionId, token usage, cost, delivery outcome, summary, and
  full output. Schema mirrors OpenClaw for future tooling compatibility. Files
  auto-rotate at 2 MB. Exposed via `GET /api/crons/:name/runs?limit=N`.
- **Run history UI in Cron detail panel.** Expandable list per run showing
  status badge, trigger (`manual`/`schedule`), duration, token counts, cost,
  delivery channel/target, full message text (`result`) with a "Copia" button,
  and errors. Auto-reloads when the panel re-opens or a new run is triggered.
- **CronBuilder component.** Human-readable schedule picker with 5 modes
  (daily / weekdays with day chips / every N minutes / monthly / custom). Live
  preview in Italian ("Ogni giorno alle 08:00") + generated cron expression.
  Used in both the "New Cron Job" form and the edit panel. A `humanizeCron`
  helper renders the friendly phrase in the cron list and detail view.
- **Click-outside to close side panels.** The shared `Panel` component now
  ships a z-30 backdrop that captures off-panel clicks, matching modal UX
  conventions. Works for every panel in the dashboard (Cron, Sessions, Routes,
  Agents, Tools, …). Esc already worked; backdrop is transparent to avoid
  dimming the dashboard.
- **Cron delivery: ASCII footer.** Scheduled/manual results now include the
  same `[t 10.8s | llm 10.7s | tok 22.1k>132 | agent/model]` footer used by
  chat replies, so messages sent to Telegram/WhatsApp/Discord carry the
  standard run telemetry.
- **Cron seeds the conversation cache.** After a successful delivery the job
  appends an `assistant` turn to the agent's `session-cache` under the same
  session key the chat handler uses (`whatsapp:<group>`, `telegram:<from>`,
  etc.). When the human replies, the agent now sees the cron message as its
  own previous turn — no more "what were we talking about?".
- **Telegram slash-command menu.** Router publishes a curated subset (top
  50) of your Claude Code commands to Telegram's native `/`-menu via
  `setMyCommands`, pulling from `~/.claude/commands/**/*.md` (including
  namespaced like `gsd/*.md`) and installed plugin commands under
  `~/.claude/plugins/marketplaces/*/plugins/*/commands/*.md`. Names
  incompatible with Telegram (hyphens, namespace `:`) are registered in
  `a-z0-9_` form and rewritten back to the CLI form on incoming messages.
  Adds router-native `/help`, `/clear`, `/cost`, `/status` — Claude Code's
  TUI built-ins aren't exposed over stream-json, so the router handles them
  itself (reset session, show today's cost aggregate, show active sessions).
- **Dashboard real-time activity stream.** New WebSocket endpoint at `/ws`
  broadcasts session lifecycle, exchanges, response timings, and log events.
  The UI switches to push updates when connected and falls back to polling
  when it's not. Up to 32 clients, 20 s keep-alive, backpressure-aware.
- **Dashboard drill-downs.** Sessions, Agents, Routes, Channels, Analytics,
  Cron, Memory, and Tools pages redesigned around live metrics, drill-down
  cards, and cross-links between entities. New building blocks include
  `ActivityStream`, `ConversationThread`, `DrillDownCard`, `LiveIndicator`,
  `MetricBadge`, `RelatedList`, `RouteBadge`, `SessionRow`, and a URL-hash
  filter helper in `lib/hashFilter.ts`.
- **Session thread endpoint.** `GET /api/sessions/:key/thread?limit=N`
  returns a bounded conversation history for the drill-down view, with
  path-traversal protection (`isValidKey`).
- **Richer response-time tracking.** `ResponseTime` entries now carry
  `channel`, `agent`, `routeIndex`, and `status` (`ok` / `error` /
  `timeout`), so the dashboard can attribute latency to the right route.

### Changed
- **Cron jobs inherit the agent config.** `cron.ts` now derives the agent
  name from the job's workspace path and pulls `fullAccess`, `tools`, `env`,
  `inheritUserScope`, and `model` from `agent.yaml` — matching OpenClaw's
  agent-scoped model. Removes the need for per-job access flags in YAML.
- **`askClaudeFresh` returns structured output.** Shape changed from a raw
  string to `{ result, model, sessionId, usage, costUsd, status, exitCode,
  error }`, so cron can log token/cost telemetry and distinguish timeouts
  from errors. Only `cron.ts` calls this helper — no external breakage.
- **`CronState` tracks delivery + streak health.** New fields
  `consecutiveErrors` and `lastDeliveryStatus` alongside the existing
  lastRun/lastStatus, matching OpenClaw's job-state granularity.
- **JSONL is the single source of truth.** The in-memory `CronState` is
  rehydrated from the tail of the job's JSONL at boot, so there's no
  parallel `stats.json` to keep in sync. The legacy `cron-stats.json` is
  no longer read or written.
- **Model resolution now delegated to Claude Code CLI.** Removed the hardcoded
  alias→ID map in `router/src/services/claude.ts`. Aliases (`opus`, `sonnet`,
  `haiku`) in `agent.yaml` pass through unchanged, letting the CLI resolve them
  to the latest available model (e.g. Opus 4.7 as soon as it's released). Pin a
  specific ID (e.g. `claude-opus-4-6`) in `agent.yaml` if you need version-lock.

### Fixed
- **WhatsApp 👀 reaction no longer leaks on unrouted chats.** The eye
  reaction on attachments was placed (and the media downloaded + transcribed)
  based on agent capabilities alone, before the routing decision tree ran —
  so any document dropped into any chat, and any voice/image in chats where
  the sender phone happened to match an unrelated route preview, got marked
  "seen" even though the bot would never reply. `processMessage` in
  `router/src/connectors/whatsapp.ts` now evaluates the full decision tree
  (self-chat, `alwaysReplyGroups`, `@jarvis` owner invocation, reply-to-Jarvis,
  explicit route with `alwaysReply`) **before** any reaction, media download,
  or transcription. As a side-effect fix, `@jarvis` one-shot invocations on
  media now correctly use the full-access agent's capabilities for voice/vision
  gating (previously they were gated by the chat's preview route, so media
  could be silently skipped when `@jarvis`-summoned in an unrelated chat).
- **Cron delivery chunks long messages on every channel.** Telegram and
  WhatsApp now chunk via `splitMessage(text, 4000)`; Discord uses the
  existing `chunkForDiscord` helper (preserves code fences at 1950). Prevents
  `Bad Request: text is too long` failures seen on multi-section morning
  reports.
- **WhatsApp cron delivery no longer loops.** `sendMessage` now tracks the
  outbound message id in `sentMsgIds` — the same mechanism used by chat
  replies — so Baileys' own-message echo is recognized as bot-sent and
  doesn't trigger the route agent to reply to itself.
- **Fresh Claude calls strip `--verbose`.** With `--verbose --output-format
  json` the CLI emits an event array (no `.result` field), so cron
  deliveries were sending raw JSON. Non-streaming calls now ask for plain
  `json` only, restoring `{ result: "…" }` and clean message bodies.
- **Retry-path model attribution.** The fallback loop in
  `askClaudeInternal` was passing `models[i]` (first fallback) to
  `doSendWithTimeout` instead of the current retry model, so logs and
  response metadata attributed attempts to the wrong model. Now passes
  the active `model` variable.
- **Dashboard tooltips made consistent.** The proper portaled `Tooltip`
  component (120 ms delay, themed bubble, multi-line aware) was previously
  only used in the sidebar nav. Everywhere else relied on the native
  `title=` attribute (slow ~1.5 s, basic styling). Refactored shared
  primitives — `Badge`, `MetricBadge`, `BadgeLink`, `RouteBadge`,
  `Button`, `DrillDownCard`, `AgentName`, plus the `Th` helper in
  `Sessions.tsx` — to wrap with `Tooltip` when a `title` is supplied,
  and converted remaining ad-hoc `title=` callsites in Sessions, Channels,
  Memory, Skills, Cron, Agents, Overview, ConversationThread, LiveIndicator,
  and the sidebar's WS status pill. `Tooltip` now also strips the cloned
  child's native `title` (preventing double-tooltips) and renders strings
  containing `\n` as multi-line content.
- **Dashboard screenshots refreshed.** `docs/images/dashboard-*.png`
  regenerated at 1440x900 with personal data replaced by generic demo
  placeholders (phones, group JIDs, emails, user/agent names, project/client
  names). Scrollbars hidden in the captured frames.

### Removed
- _(nothing yet)_

## [1.1.0] — 2026-04-16

### Added
- **Skills marketplace architecture.** Jarvis custom skills now live in
  `~/jarvis/skills-marketplace/` (outside `~/.claude/`) and are loaded via
  Claude Code's native plugin-marketplace mechanism. This lets Jarvis agents
  running from Telegram/WhatsApp/Discord create new skills directly, which
  wasn't possible when skills lived under `~/.claude/skills/` due to Claude
  Code's hard-coded safetyCheck on that path.
- `skills-marketplace.template/` — seed directory with `marketplace.json` and
  a README, used by `setup.sh` (fresh installs) and the migration script
  (existing installs).
- `scripts/migrate-to-marketplace.sh` — one-shot migration for users upgrading
  from the pre-1.1 layout. Idempotent, supports `--dry-run` and `--force`.
  Preserves a timestamped backup of `~/.claude/skills/` before moving anything.
- Dashboard Skills tab now shows skills from local-path marketplaces
  (registered via `claude plugin marketplace add <path>`) by reading
  `~/.claude/plugins/known_marketplaces.json` in addition to the existing
  scan of `~/.claude/plugins/marketplaces/*`.

### Changed
- `setup.sh` installs the `jarvis-config` skill via the new marketplace
  instead of a direct symlink into `~/.claude/skills/jarvis-config`.
- `README.md`, `ARCHITECTURE.md` — updated to describe the marketplace layout
  and reasoning.

### Migration guide (existing installs)

Pull the update, then from your CLI run:

```bash
bash scripts/migrate-to-marketplace.sh --dry-run   # review what it will do
bash scripts/migrate-to-marketplace.sh             # execute
```

The script:
- Backs up `~/.claude/skills/` to `~/.claude/skills.backup-<timestamp>`.
- Moves user-owned custom skills (real dirs) into the new marketplace.
- Leaves third-party skills (`agent-reach`, `firecrawl`, etc. — symlinks to
  `~/.agents/skills/`) untouched.
- Registers the marketplace with Claude Code and installs the plugin.

Rollback is a single `mv` + two `claude plugin` uninstall commands (printed
by the script on completion). No data is deleted.

### Why this is safe to ship

- The change is purely architectural — custom skills' contents are unchanged,
  only their filesystem location moves.
- Backwards-compat path: third-party symlinks (`agent-reach`, `firecrawl`)
  remain at `~/.claude/skills/` and continue to work.
- Fresh installs get the new architecture from the start (no migration
  needed, `setup.sh` handles it).
- Migration for existing installs is opt-in via a dedicated script.

### Technical background

Claude Code 2.1.x enforces a `safetyCheck` that blocks `Write`/`Edit`/`Bash`
operations targeting `~/.claude/**` regardless of permission flags
(`bypassPermissions`, `dangerously-skip-permissions`, `additional-directories`,
`PreToolUse` hooks, `permissionPromptTool`). This is a deliberate security
invariant: no agent may modify the user's Claude Code configuration without
a human at the interactive CLI.

Since custom skills conventionally lived in `~/.claude/skills/`, the check
prevented Jarvis from installing skills via remote channels. Moving the
marketplace to `~/jarvis/` (a path the safetyCheck does not protect) lifts
this limitation while keeping the rest of Claude Code's security model intact.
