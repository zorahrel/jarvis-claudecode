# Phase 2: Orchestrator Multi-Session — Context

**Gathered:** 2026-05-10
**Status:** Ready for planning
**Source:** Conversation with user (this session) → distilled into locked decisions

<domain>
## Phase Boundary

Build a unified control plane that turns 5+ scattered Claude Code sessions (router-spawned + bare CLI in terminals) into an orchestrable "team" the user can pilot from one place. The orchestrator does NOT execute work itself — it observes session state, suggests next steps, and (with approval) injects the chosen action into the target session.

Three layers, separated:
- **Intent layer** = Apple Reminders list `Jarvis/ActiveTasks` (what the user wants done; syncs to iPhone/Watch/Siri).
- **Execution layer** = `/api/local-sessions` + extended transcript reads (what the sessions are actually doing).
- **HUD layer** = JarvisNotch (always-visible top-3 todos + live session badges).
- **Bridge** = the `/orchestrator` skill + new dashboard tab translating intent ↔ execution.

This phase delivers infrastructure + read-only orchestrator + Reminders sync + notch HUD. Inject control (write side) is gated behind a separate plan with explicit user approval per action.

</domain>

<decisions>
## Implementation Decisions

### Branch & Workspace
- Phase 2 lives on `feature/orchestrator`, rebased on `main@dd4345d`.
- Notch UI delivery is independent track (already in main from `feature/notch`).
- Stash `stash@{0}` (MCP auth v2 WIP) is paused — DO NOT touch in this phase.

### Architecture (locked)
- **3-layer separation** (intent / execution / HUD) is non-negotiable. Mixing them was identified as the failure mode.
- Orchestrator = read-mostly skill + small write surface gated by user approval. NEVER auto-executes (auto-pilot is a deferred opt-in plan, last in wave order).
- Reminders is the single source of truth for "what should be worked on." Local file fallback (`~/.claude/jarvis/todos.json`) only if Reminders integration fails.

### Inject Mechanism (locked)
- **Choose:** `tmux send-keys` over file-watch hooks.
- **Reason:** zero modifications to Claude Code, works on existing sessions today, supports Approve/Skip/Custom from dashboard, audit log via tmux capture-pane.
- **Constraint:** sessions targeted for inject MUST be running under tmux. Bare Terminal.app sessions are read-only in the orchestrator (still appear in observatory).
- **Reject:** `UserPromptSubmit` hook + file watch (asynchronous, requires user keystroke, fragile timing).
- **Reject:** Claude Code Agent Teams API (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) — requires single-process lead, can't orchestrate sessions opened in separate terminals.

### Reminders Integration (locked)
- CLI: `apple-reminders-cli` (Swift+EventKit, JSON output) installed via Homebrew.
- Polling: 3s. No native watch — Apple Reminders eventually-consistent via iCloud (3-15s lag accepted).
- Bidirectional:
  - Orchestrator → creates new todos → Reminders → visible on iPhone/Watch/Siri.
  - User checks off on iPhone → router sees on next poll → emits `todos:update` → notch + dashboard refresh.
- Schema: each todo body carries metadata line `pid:NNNN repo:<name> phase:<plan|exec|review>` so orchestrator can map todo → session.

### Notch Integration (locked)
- Two new views: (a) right-peek session sidebar with status badges; (b) thin top/bottom strip with top-3 open todos.
- Push: existing `NotchConnector.emit('sessions:update', ...)` and new `emit('todos:update', ...)`.
- Click semantics: todo click = mark complete; long-press = reassign to a different session.

### Skills Location
- Orchestrator skill at `~/jarvis/skills-marketplace/skills/orchestrator/SKILL.md` (NOT `~/.claude/skills/` — blocked by safetyCheck).
- Skill makes 2-3 HTTP calls to router (`/api/local-sessions`, new `/api/sessions/:pid/transcript`, optional `/api/sessions/:pid/inject`). NO direct fs reads from skill.

### Out of Scope (this phase)
- Auto-pilot mode that pre-signs approvals — deferred to Plan 02-05, opt-in only, gated by per-route token budget.
- Multi-machine orchestration (sessions on remote hosts). Local Mac only.
- Slack/Discord channel for todos. Reminders only.
- Replacing the existing Context Inspector tab. Orchestrator is a NEW tab.

### Claude's Discretion
- File names within `services/`, exact React component split inside the new tab, Swift view hierarchy in JarvisNotch, exact naming of orchestrator skill subcommands.
- Whether to use `apple-reminders-cli` JSON output vs `ekctl` — pick whichever has fewer install friction at plan time.
- Choice between SSE / WebSocket / HTTP polling 5s for dashboard live updates — match existing Context Inspector pattern.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project rules
- `CLAUDE.md` — root project rules (spawn discipline, MCP guardrails, agent identity layers)
- `ARCHITECTURE.md` — router architecture, directory layout, services list
- `.planning/STATE.md` — branch, decisions log, open stashes
- `.planning/ROADMAP.md` — current milestone + Phase 1 status
- `.planning/REQUIREMENTS.md` — existing CTX-01..CTX-15 (Phase 1) + ORC-XX to be added

### Existing infrastructure to extend (not rewrite)
- `router/src/services/localSessions/discovery.ts` — `LocalSession` type, ps+lsof discovery
- `router/src/services/localSessions/types.ts` — interfaces
- `router/src/dashboard/api.ts` line ~1983 — `GET /api/local-sessions` handler
- `router/src/services/contextInspector/breakdown.ts` — JSONL parser pattern (8-category)
- `router/dashboard/src/api/client.ts` line ~633 — `localSessions()` typed client
- `router/dashboard/src/pages/` — existing Context tab as the layout reference
- `tray-app/Sources/JarvisTray/` — Swift menu bar app (build via `tray-app/make-app.sh`)
- Notch event bus: `NotchConnector.emit/subscribe` pattern (already used for TTS streaming, abort, inject on single session)
- Hook events on disk: `~/.claude/jarvis/events/<pid>.json`
- Claude Code session JSONLs: `~/.claude/projects/-Users-.../<uuid>.jsonl` (parse last-N turns)

### External tools / libs
- `apple-reminders-cli` — https://github.com/AungMyoKyaw/apple-reminders-cli (Swift+EventKit, JSON)
- `ekctl` — https://github.com/schappim/ekctl (alt CLI, JSON output)
- `tmux send-keys` — built-in tmux command for inject
- Claude Code Agent Teams docs (reference, not used) — https://code.claude.com/docs/en/agent-teams

### Skills marketplace
- `~/jarvis/skills-marketplace/skills/` — install location for `/orchestrator` (path is OUTSIDE `~/.claude/`, required because Claude Code blocks writes to `~/.claude/**`)

</canonical_refs>

<specifics>
## Specific Ideas

### State derivation (per session)
For each `LocalSession` from `/api/local-sessions`, the orchestrator derives a refined status by reading the JSONL tail:
- `awaiting_user_input`: last turn role = `assistant`, no pending tool_use, process idle ≥30s
- `tool_pending`: last assistant message contains `tool_use` with no matching `tool_result`
- `crashed`: pid not in `ps`, but JSONL last turn is incomplete (no `stop_reason`)
- `working`: process active, no idle marker
- `idle`: process active, no recent JSONL append (>30s)

### Suggested next-step format
The skill returns JSON with one entry per session:
```json
{
  "pid": 1234,
  "repo": "topics",
  "branch": "feature/x",
  "status": "awaiting_user_input",
  "last_assistant_summary": "Plan ready, requesting approval to write 4 files",
  "suggestion": "Approve plan and proceed",
  "action": {"type": "inject", "text": "y"},
  "todo_link": "<reminders-uuid-or-null>"
}
```
The user reviews this output (in chat or dashboard) and confirms before any inject runs.

### Audit log
Every inject must persist to `~/.claude/jarvis/orchestrator/audit.jsonl` with `{ts, pid, repo, action, source: "user-approved|auto"}`. Auto-pilot mode never writes without `source: "auto"` and must respect a daily token budget cap read from `config.yaml`.

### Lock per repo path
If two sessions target the same repo cwd (or sub-paths), the orchestrator MUST refuse simultaneous inject and surface the conflict. Mirrors the file-locking behavior of Agent Teams.

</specifics>

<deferred>
## Deferred Ideas

- Auto-pilot mode (Plan 02-05) — deliberately last; only enabled after 02-01..02-04 are stable in production for ≥1 week.
- Multi-machine orchestration (sessions on remote hosts).
- Replacing Reminders with Things 3 / Todoist / Notion (architecture allows, not in v1).
- Push from orchestrator to TG/WA/Discord channels when a session needs attention (rides on existing alert plumbing — defer).
- Session "promote to lead" / "demote to subagent" semantics (would couple Phase 2 to Agent Teams API — out of scope).
- Cost ledger reconciliation across sessions (Phase 1 already covers per-session cost; cross-session aggregate is v2).

</deferred>

---

*Phase: 02-orchestrator-multi-session*
*Context gathered: 2026-05-10 from interactive conversation + recon, no PRD file*
