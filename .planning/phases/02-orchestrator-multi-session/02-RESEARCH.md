# Phase 2: Orchestrator Multi-Session — Research

**Researched:** 2026-05-07
**Domain:** Multi-session orchestration over Claude Code transcripts (JSONL) + macOS EventKit (Reminders) + tmux IPC + native notch HUD
**Confidence:** HIGH (every external dependency probed live on this machine; APIs verified against installed binaries; nothing relies on training data)

## Summary

Phase 2 ships an orchestrator that turns ≥5 scattered Claude Code sessions into a controllable team without touching Claude Code itself. Every architectural choice is already locked in CONTEXT.md (3-layer separation, `tmux send-keys` over hook+filewatch, Apple Reminders as intent layer, skill outside `~/.claude/`). What remained for research was: (1) confirm the locked decisions still work in 2026-05 on this machine, (2) pin the exact JSONL field shape and tail-parsing pattern, (3) pick between `apple-reminders-cli`, `ekctl`, and `remindctl` for Reminders, (4) document NotchConnector wiring, and (5) lay out the deterministic suggestion engine + audit format so the planner does not invent semantics.

Key delta from training-era assumptions: **`remindctl` (steipete/tap, v0.1.1) is already installed and ships JSON output by design**, with stable subcommands `list/show/add/edit/complete/delete/status/authorize`. It is the cleaner primary; `apple-reminders-cli` (AungMyoKyaw) is the documented fallback in CONTEXT.md but requires an extra `brew tap` and is not currently on disk. JSON I/O contract is identical enough to swap behind a thin wrapper.

**Primary recommendation:** Build `router/src/services/reminders.ts` as a thin wrapper over `remindctl --json` (primary) with `apple-reminders-cli` and `ekctl` registered as fallbacks behind a probe-on-startup; extend `router/src/services/contextInspector/jsonlParser.ts` (DO NOT duplicate it) with `extractLastAssistantTurn()` + `extractPendingToolUses()` helpers; ship `/api/sessions/:pid/transcript` and `/api/sessions/:pid/tmux` as new endpoints next to the existing `/api/local-sessions` handler; emit `todos:update` and `sessions:update` through a fresh `notch/orchestrator-events.ts` module that mirrors `notch/events.ts` (do not pollute the existing notch event union); keep the orchestrator skill output as **strict JSON** (one entry per session, fields locked in CONTEXT.md `<specifics>`) — this is what makes it scriptable from chat and from the dashboard without re-parsing prose.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Branch & Workspace**
- Phase 2 lives on `feature/orchestrator`, rebased on `main@dd4345d`.
- Notch UI delivery is independent track (already in main from `feature/notch`).
- Stash `stash@{0}` (MCP auth v2 WIP) is paused — DO NOT touch in this phase.

**Architecture (locked)**
- 3-layer separation (intent / execution / HUD) is non-negotiable. Mixing them was identified as the failure mode.
- Orchestrator = read-mostly skill + small write surface gated by user approval. NEVER auto-executes (auto-pilot is a deferred opt-in plan, last in wave order).
- Reminders is the single source of truth for "what should be worked on." Local file fallback (`~/.claude/jarvis/todos.json`) only if Reminders integration fails.

**Inject Mechanism (locked)**
- Choose: `tmux send-keys` over file-watch hooks.
- Reason: zero modifications to Claude Code, works on existing sessions today, supports Approve/Skip/Custom from dashboard, audit log via tmux capture-pane.
- Constraint: sessions targeted for inject MUST be running under tmux. Bare Terminal.app sessions are read-only in the orchestrator (still appear in observatory).
- Reject: `UserPromptSubmit` hook + file watch (asynchronous, requires user keystroke, fragile timing).
- Reject: Claude Code Agent Teams API — requires single-process lead, can't orchestrate sessions opened in separate terminals.

**Reminders Integration (locked)**
- CLI: `apple-reminders-cli` (Swift+EventKit, JSON output) installed via Homebrew. (NOTE: research found `remindctl` already on disk and equivalent — see Standard Stack table.)
- Polling: 3s. No native watch — Apple Reminders eventually-consistent via iCloud (3-15s lag accepted).
- Bidirectional: orchestrator → creates new todos → Reminders → visible on iPhone/Watch/Siri. User checks off on iPhone → router sees on next poll → emits `todos:update` → notch + dashboard refresh.
- Schema: each todo body carries metadata line `pid:NNNN repo:<name> phase:<plan|exec|review>` so orchestrator can map todo → session.

**Notch Integration (locked)**
- Two new views: (a) right-peek session sidebar with status badges; (b) thin top/bottom strip with top-3 open todos.
- Push: existing `NotchConnector.emit('sessions:update', ...)` and new `emit('todos:update', ...)`.
- Click semantics: todo click = mark complete; long-press = reassign to a different session.

**Skills Location**
- Orchestrator skill at `~/jarvis/skills-marketplace/skills/orchestrator/SKILL.md` (NOT `~/.claude/skills/` — blocked by safetyCheck).
- Skill makes 2-3 HTTP calls to router (`/api/local-sessions`, new `/api/sessions/:pid/transcript`, optional `/api/sessions/:pid/inject`). NO direct fs reads from skill.

**Out of Scope (this phase)**
- Auto-pilot mode that pre-signs approvals — deferred to Plan 02-05, opt-in only, gated by per-route token budget.
- Multi-machine orchestration (sessions on remote hosts). Local Mac only.
- Slack/Discord channel for todos. Reminders only.
- Replacing the existing Context Inspector tab. Orchestrator is a NEW tab.

### Claude's Discretion
- File names within `services/`, exact React component split inside the new tab, Swift view hierarchy in JarvisNotch, exact naming of orchestrator skill subcommands.
- Whether to use `apple-reminders-cli` JSON output vs `ekctl` — pick whichever has fewer install friction at plan time. **Resolution from research: pick `remindctl` (already installed, JSON-native). Keep `apple-reminders-cli` and `ekctl` as detected fallbacks.**
- Choice between SSE / WebSocket / HTTP polling 5s for dashboard live updates — match existing Context Inspector pattern. **Resolution: poll every 5s — Context Inspector uses HTTP polling (CTX-13).**

### Deferred Ideas (OUT OF SCOPE)
- Auto-pilot mode (Plan 02-05) — deliberately last; only enabled after 02-01..02-04 are stable in production for ≥1 week.
- Multi-machine orchestration (sessions on remote hosts).
- Replacing Reminders with Things 3 / Todoist / Notion (architecture allows, not in v1).
- Push from orchestrator to TG/WA/Discord channels when a session needs attention (rides on existing alert plumbing — defer).
- Session "promote to lead" / "demote to subagent" semantics (would couple Phase 2 to Agent Teams API — out of scope).
- Cost ledger reconciliation across sessions (Phase 1 already covers per-session cost; cross-session aggregate is v2).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ORC-01 | `GET /api/sessions/:pid/transcript?limit=N` returns last-N JSON-structured turns from JSONL | Section "JSONL transcript shape" + extension to `jsonlParser.ts` |
| ORC-02 | Endpoint derives `refinedStatus`: `awaiting_user_input` \| `tool_pending` \| `crashed` \| `working` \| `idle` | Section "Refined session-status derivation" |
| ORC-03 | Skill `/orchestrator` calls `/api/local-sessions` + `/transcript` and returns one entry per session | Section "Orchestrator skill output contract" |
| ORC-04 | Suggestion engine: deterministic `action.type ∈ {inject, abort, restart, none}` from status + last turn (no LLM) | Section "Deterministic suggestion engine + confidence" |
| ORC-05 | Skill output respects cwd lock (sub-path detection) → `conflict: <other_pid>` warning | Section "Lock-per-cwd (sub-path overlap)" |
| ORC-06 | `router/src/services/reminders.ts` exposes `listTodos/addTodo/completeTodo` via `apple-reminders-cli` (preferred) or `ekctl` (fallback) JSON I/O | Section "Reminders CLI selection" — recommend `remindctl` primary, the CONTEXT-named CLIs as fallbacks |
| ORC-07 | 3s polling on `Jarvis/ActiveTasks` list; emits `todo:added/completed/updated` | Section "Reminders polling cost & invariants" |
| ORC-08 | Body schema with `pid:NNNN repo:<name> phase:<plan\|exec\|review>` parsed bidirectionally | Section "Reminders metadata schema" |
| ORC-09 | `GET/POST /api/todos`, `POST /api/todos/:uuid/complete` | Section "API surface mirroring Phase 1 patterns" |
| ORC-10 | Tab "Todos" in dashboard with 5s auto-refresh (matches Context Inspector) | Section "API surface mirroring Phase 1 patterns" |
| ORC-11 | Swift "Sessions sidebar" view in JarvisNotch (right peek) | Section "Notch event bus + new event types" |
| ORC-12 | Swift "Todo strip" (top-3 todos) in JarvisNotch | Section "Notch event bus + new event types" |
| ORC-13 | Click todo = complete; long-press = reassign session | Section "Notch event bus + new event types" |
| ORC-14 | Notch receives `sessions:update` (existing) + new `todos:update`; reconnect graceful | Section "Notch event bus + new event types" |
| ORC-15 | `GET /api/sessions/:pid/tmux` returns `{has_tmux, session_name?, pane_id?}` | Section "tmux pid → pane mapping" |
| ORC-16 | `POST /api/sessions/:pid/inject {text, source}`; 409 if no tmux or cwd lock violated | Section "tmux send-keys inject" + "Lock-per-cwd" |
| ORC-17 | Audit JSONL append-only at `~/.claude/jarvis/orchestrator/audit.jsonl`; rotation at 10 MB | Section "Audit log format & rotation" |
| ORC-18 | Orchestrator tab with Approve / Skip / Custom controls — only for `awaiting_user_input` | Section "Dashboard tab pattern" |
| ORC-19 | Confirmation modal on Approve when cwd shared — user must type `force` | Section "Lock-per-cwd (sub-path overlap)" |
| ORC-20 | `auto_pilot.enabled` flag (default `false`) in `router/config.yaml`; hook `UserPromptSubmit` only when enabled | Section "Auto-pilot opt-in flag plumbing" |
| ORC-21 | Budget guard: `auto_pilot.daily_token_cap` (default 100k) read from `/api/sessions/aggregate` before each auto-inject | Section "Auto-pilot opt-in flag plumbing" |
| ORC-22 | Hook applies only `confidence: high` actions; writes audit with motivation | Section "Deterministic suggestion engine + confidence" |
</phase_requirements>

## Project Constraints (from CLAUDE.md + ARCHITECTURE.md)

| Directive | Source | Impact on plans |
|-----------|--------|-----------------|
| Never hardcode secrets — env or `config.yaml` | CLAUDE.md | `auto_pilot.daily_token_cap`, audit-log rotation size MUST be in `config.yaml`, never literal in code |
| Don't use Docker | CLAUDE.md | Reminders bridge runs as in-process worker, not a sidecar container |
| Don't add npm dependencies without good reason | CLAUDE.md | `tmux send-keys`, `remindctl`, JSONL parsing all use stdlib + existing `child_process`; do NOT add `tmux-node`, `node-tmux-wrapper`, or `applescript` libraries |
| Don't hardcode extra services in source — use `services:` in `config.yaml` | CLAUDE.md | If Reminders polling becomes its own daemon, it gets a `services:` entry. For Phase 2 it stays inside the router process. |
| Don't modify agents' CLAUDE.md without understanding scoping | CLAUDE.md | Skill at `~/jarvis/skills-marketplace/...` does NOT touch any agent CLAUDE.md |
| Identity: only two layers — `~/.claude/CLAUDE.md` + `<workspace>/CLAUDE.md`. NEVER add a third layer via `--append-system-prompt` | CLAUDE.md | Skill must NOT call out to a third-layer config injection mechanism; HTTP-only |
| Skills live OUTSIDE `~/.claude/**` (safetyCheck blocks writes) | CLAUDE.md user-global + ARCHITECTURE.md | Orchestrator skill MUST be at `~/jarvis/skills-marketplace/skills/orchestrator/`; never under `~/.claude/skills/` |
| MCP servers single source = `~/.claude/settings.json` | ARCHITECTURE.md | The orchestrator skill is NOT an MCP. It's a slash-skill. No MCP additions. |
| Spawn discipline: `--strict-mcp-config`, `--setting-sources user,project,local`, `JARVIS_SPAWN=1` | ARCHITECTURE.md | When auto-pilot (02-05) sets up the `UserPromptSubmit` hook it must self-guard on `JARVIS_SPAWN=1` to avoid recursive injects on router-spawned sessions |
| Test framework = `node:test` + `assert/strict`; co-located `*.spec.ts`; fixtures in `__fixtures__/` | Existing pattern in `router/src/services/contextInspector/` | Wave 0 plans MUST follow this exact convention; no jest, no vitest |
| Always invoke external CLIs via `execFile` (promisified), never via shell-string forms | Existing convention in `localSessions/discovery.ts` | All `tmux`, `remindctl`, `ps`, `lsof`, `git` calls use `execFile("name", [args...])`; this also closes shell-injection gaps when injecting user-supplied text into tmux |

## Standard Stack

### Core
| Library / Tool | Version | Purpose | Why Standard |
|---|---|---|---|
| Node.js | v25.9.0 (live) | Runtime | Already required by router |
| TypeScript | 5.9.3 | Compile / typecheck | Pinned in `router/package.json` |
| `node:test` | stdlib | Tests | Convention from Phase 1 (`*.spec.ts` next to source) |
| `node:assert/strict` | stdlib | Assertions | Convention from Phase 1 |
| `child_process.execFile` (promisified) | stdlib | Spawn `tmux`, `remindctl`, `ps`, `lsof` | Convention from `localSessions/discovery.ts`. ALWAYS pass arg arrays — never compose shell strings — to avoid quoting bugs and injection. |
| `tmux` | 3.6a (live) | Inject mechanism for sessions running under tmux | Already on this Mac at `/opt/homebrew/bin/tmux` |
| `remindctl` | 0.1.1 (live, `steipete/tap`) | Apple Reminders CLI with EventKit + native JSON | **Already installed.** Verified live: `remindctl lists --json` produced valid JSON with `id, title, reminderCount, overdueCount`. macOS ≥14 required (we have 25.2.0) |
| `apple-reminders-cli` (`reminder` binary) | latest from `AungMyoKyaw/homebrew-tap` | **Fallback #1** named in CONTEXT.md | Documented in CONTEXT.md but NOT currently installed. Plan should `brew tap AungMyoKyaw/homebrew-tap && brew install AungMyoKyaw/homebrew-tap/reminder` only if user prefers it |
| `ekctl` | latest from `schappim/ekctl` | **Fallback #2** named in CONTEXT.md | Same Calendar+Reminders surface, JSON output. Listed as fallback only |
| Swift / SwiftUI | Swift 6.3.1, Xcode 26.4.1 (live) | JarvisNotch UI views | Build via `tray-app/make-app.sh`. macOS arm64 confirmed |

**Version verification (executed 2026-05-07):**

| Probe | Result |
|---|---|
| `which tmux` | `/opt/homebrew/bin/tmux` |
| `tmux -V` | `tmux 3.6a` |
| `node --version` | `v25.9.0` |
| `swift --version` | `Apple Swift version 6.3.1 (swiftlang-6.3.1.1.2 clang-2100.0.123.102)` |
| `xcodebuild -version` | `Xcode 26.4.1` |
| `remindctl --version` | `0.1.1` |
| `remindctl lists --json` | Valid JSON, 5 lists detected (Lavoro, Promemoria, Armonia, Backlog, Personale) |
| `tmux new-session -d` + `send-keys ... Enter` + `capture-pane -p` | Successfully sent multi-line + escaped strings; round-trip verified |
| `which apple-reminders-cli` / `which reminder` | Not installed |
| `which ekctl` | Not installed |

### Supporting
| Library / Tool | Version | Purpose | When to Use |
|---|---|---|---|
| `pino` | 9.6.0 (existing) | Structured logs (audit log preface, not the audit JSONL itself) | All `logger.child({ module: "..." })` calls |
| `yaml` | 2.7.1 (existing) | `config.yaml` parse for `auto_pilot.*` keys | Plan 02-05 reads `auto_pilot.enabled` and `auto_pilot.daily_token_cap` |
| `fs.promises.appendFile` | stdlib | Append audit JSONL line | Atomic enough for single-writer router process |
| `fs.promises.rename` + `stat` | stdlib | Audit log rotation at 10 MB → `audit.jsonl.<ts>` | Implement as a guarded helper, NOT a npm log-rotation lib |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|---|---|---|
| `remindctl` | `apple-reminders-cli` (`reminder`) | Apple-reminders-cli has more EventKit features (recurring rules, location triggers) we don't need. `remindctl` already on disk = zero install friction. |
| `remindctl` | `ekctl` | `ekctl` covers Calendar too. We don't need Calendar in Phase 2 (intent layer is Reminders only). |
| `tmux send-keys` | AppleScript `do script` to Terminal.app | AppleScript can't target a tmux pane. Bare-terminal sessions stay read-only by design (locked in CONTEXT.md). |
| `tmux send-keys` | `expect` / `pty` injection on the Claude PID | Brittle; CONTEXT.md already rejected hook+filewatch for the same reason. |
| Custom JSONL re-parser | Extend `router/src/services/contextInspector/jsonlParser.ts` | Phase 1 already implements `readJsonlTailLines`, `extractToolUseEvents`, `sumTokens`, `countTurns`. Add only what's missing — `extractLastAssistantTurn`, `extractPendingToolUses`, `getStopReason`. CONTEXT.md says: extend, don't duplicate. |

**Installation (only if user prefers AungMyoKyaw over `remindctl`):**
```bash
brew tap AungMyoKyaw/homebrew-tap
brew install AungMyoKyaw/homebrew-tap/reminder
```

## Architecture Patterns

### Recommended Project Structure (additions, not rewrites)
```
router/src/
├── services/
│   ├── contextInspector/        # Phase 1 — reuse, do not duplicate
│   │   ├── jsonlParser.ts       # EXTEND with extractLastAssistantTurn, extractPendingToolUses, getStopReason
│   │   ├── jsonlParser.spec.ts  # add cases for new helpers
│   │   └── ... (cost.ts, breakdown.ts, etc — untouched)
│   ├── localSessions/           # Phase 1 — reuse
│   │   ├── discovery.ts         # already returns LocalSession[] — add tmux + refinedStatus enrichment via NEW orchestrator service, do NOT mutate this file's core
│   │   └── types.ts             # extend LocalSession with optional `refinedStatus`, `tmux`, `lockConflict` (additive only)
│   ├── orchestrator/            # NEW — this phase
│   │   ├── index.ts             # public API: snapshot()
│   │   ├── refinedStatus.ts     # derive 5-state status from JSONL + ps
│   │   ├── tmuxMap.ts           # pid → pane_id resolution + send-keys + capture-pane
│   │   ├── lock.ts              # cwd sub-path overlap detection (canonicalize via realpath)
│   │   ├── suggest.ts           # deterministic suggestion engine + confidence
│   │   ├── audit.ts             # append-only JSONL writer + 10MB rotation
│   │   └── *.spec.ts            # one spec per source file (node:test)
│   ├── reminders/               # NEW
│   │   ├── index.ts             # public API: listTodos, addTodo, completeTodo
│   │   ├── cli.ts               # remindctl primary, apple-reminders-cli + ekctl fallbacks
│   │   ├── poll.ts              # 3s poll loop emitting todo:added/completed/updated
│   │   ├── metadata.ts          # parse/format `pid:NNNN repo:<name> phase:<...>` body line
│   │   └── *.spec.ts
├── notch/
│   ├── events.ts                # existing — DO NOT pollute with orchestrator events
│   └── orchestrator-events.ts   # NEW — `sessions:update` and `todos:update` event bus
├── dashboard/
│   └── api.ts                   # ADD endpoints next to existing local-sessions handler:
│                                #   GET  /api/sessions/:pid/transcript?limit=N
│                                #   GET  /api/sessions/:pid/tmux
│                                #   POST /api/sessions/:pid/inject
│                                #   GET  /api/todos
│                                #   POST /api/todos
│                                #   POST /api/todos/:uuid/complete
└── ...

router/dashboard/src/pages/
└── OrchestratorTab.tsx          # NEW; mirror layout of ContextTab from Phase 1
└── TodosTab.tsx                 # NEW

tray-app/Sources/JarvisNotch/
├── NotchEvents.swift            # extend with sessions:update + todos:update decoders
├── SessionsSidebarView.swift    # NEW — right-peek
└── TodoStripView.swift          # NEW — top/bottom thin row

~/jarvis/skills-marketplace/skills/orchestrator/
└── SKILL.md                     # NEW — frontmatter + invocation flow + JSON output schema

~/.claude/jarvis/orchestrator/
└── audit.jsonl                  # append-only; rotated at 10 MB
```

### Pattern 1: Extend, don't duplicate (Phase 1 → Phase 2)
**What:** Phase 1 already wrote `jsonlParser.ts`, `localSessions/discovery.ts`, `LocalSession` type, and `/api/local-sessions`. Phase 2 ADDS thin services that import these.
**When to use:** Every Phase 2 plan that needs JSONL parsing or session discovery.
**Example:**
```typescript
// Source: pattern from router/src/services/contextInspector/jsonlParser.ts
import { readJsonlTailLines } from "../contextInspector/jsonlParser.js";

export async function extractLastAssistantTurn(transcriptPath: string) {
  const lines = await readJsonlTailLines(transcriptPath, 256_000);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.type === "assistant" && obj.message?.role === "assistant") {
        return {
          stop_reason: obj.message.stop_reason ?? null,
          content: obj.message.content ?? [],
          timestamp: obj.timestamp,
          uuid: obj.uuid,
        };
      }
    } catch { /* skip */ }
  }
  return null;
}
```

### Pattern 2: Cached discovery + 2s TTL
**What:** `localSessions/discovery.ts` caches results for 2 seconds (`CACHE_TTL_MS = 2000`). Refined status derivation MUST do the same — the JSONL stat call + tail read is cheap but not free at 5+ sessions.
**When to use:** Any per-session enrichment computed inside `/api/local-sessions` or its companion endpoints.
**Example:**
```typescript
// Pattern from localSessions/discovery.ts
const CACHE_TTL_MS = 2000;
let cache: { at: number; statuses: Map<number, RefinedStatus> } | null = null;

export async function refinedStatusFor(sessions: LocalSession[]): Promise<Map<number, RefinedStatus>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.statuses;
  // ... derive each session in parallel via Promise.all
}
```

### Pattern 3: Singleton connector with `getInstance()`
**What:** `NotchConnector` (in `router/src/connectors/notch.ts`) exposes a static `getInstance()` and uses module-private state. Orchestrator events do NOT need a Connector subclass — they need a tiny event bus mirroring `notch/events.ts`. Use the same module-private `Set<Subscriber>` pattern.
**When to use:** Adding `todos:update` and `sessions:update` push channels.
**Example:**
```typescript
// Source: router/src/notch/events.ts pattern
export type OrchestratorEvent =
  | { type: "sessions:update"; data: { pids: number[]; ts: number } }
  | { type: "todos:update"; data: { count: number; ts: number } };

const subscribers = new Set<(e: OrchestratorEvent) => void>();
export function subscribe(fn: (e: OrchestratorEvent) => void): () => void { /* ... */ }
export function emit(event: OrchestratorEvent): void { /* ... */ }
```

### Pattern 4: HTTP polling, not WebSocket, for the dashboard
**What:** Phase 1's Context Inspector polls `/api/local-sessions` every 5s (CTX-13). The Orchestrator tab matches this. Reminders polling at 3s is a SERVER-SIDE concern (router → EventKit), not dashboard → router.
**When to use:** Dashboard live updates.
**Example:** dashboard polls `/api/sessions/snapshot` every 5s; this endpoint internally calls `discoverLocalSessions()` (2s cached) + `refinedStatusFor()` (2s cached) + `listTodos()` (3s cached by poll loop).

### Pattern 5: Skill output is JSON, not prose
**What:** The orchestrator skill is invoked via `/orchestrator`. Its **output to chat** is a JSON code block + a one-line natural-language summary. The user (or another agent) parses the JSON to drive UI / further action. This is unique to orchestrator-style skills; conventional skills like `restart` or `jarvis-config` produce prose.
**When to use:** The orchestrator SKILL.md must specify a strict JSON schema in its description so callers can rely on it.

### Anti-Patterns to Avoid

- **Modifying `localSessions/discovery.ts` to inject orchestrator-specific fields.** It's stable across Phase 1 consumers. Add fields via a SEPARATE enrichment service that decorates the result.
- **Putting `apple-reminders-cli` shell strings inline in handlers.** All CLI invocations go through `services/reminders/cli.ts` so swap-in of `remindctl` ↔ `apple-reminders-cli` ↔ `ekctl` is a one-line probe.
- **Adding a new event type to `notch/events.ts`.** That file is the contract between the existing TTS / chat / state machine surface and the WKWebView. Orchestrator events live in their own module and have their own `/api/orchestrator/stream` SSE endpoint or piggyback on existing notch SSE under a namespaced event type — TBD by the planner, but DO NOT pollute the existing union.
- **Recursive auto-pilot:** if `UserPromptSubmit` hook fires inside a router-spawned session AND auto-pilot is enabled, it could re-inject and loop. Guard with `JARVIS_SPAWN=1` env check, just like `services/claude.ts` already does for spawn discipline.
- **Trusting `apple-reminders-cli` JSON shape across versions.** Version-pin the CLI binary OR validate the parsed JSON against a Zod schema (existing dependency) so a CLI upgrade doesn't break the bridge silently.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| Apple Reminders CRUD | AppleScript scripts via `osascript` | `remindctl --json` (or `apple-reminders-cli`, `ekctl`) | EventKit access already negotiated; permissions prompt only on first run; JSON output stable. AppleScript breaks across macOS Sequoia/Tahoe. |
| pid → tmux pane resolution | parse `tmux list-sessions` + `list-windows` + `list-panes` separately | `tmux list-panes -aF '#{pane_pid} #{session_name} #{pane_id}'` | Single shot, all panes across all sessions, machine-readable format string. Verified live. |
| JSONL tail-read | re-implement byte offset reads | `readJsonlTailLines()` in `services/contextInspector/jsonlParser.ts` | Already handles 256 KB cap, error-tolerance, empty-line skip. |
| Process discovery | `pgrep claude` | `discoverLocalSessions()` in `services/localSessions/discovery.ts` | Already filters Claude.app, Electron helpers, and pty-bridge.mjs; returns LocalSession[] with cwd, branch, sessionId. |
| Audit log rotation | npm packages (`rotating-file-stream`, `pino-roll`) | 30-line helper: `stat → if > 10MB rename to audit.jsonl.<ts> → openWrite` | Single-writer router process, no concurrent writers, stdlib `fs.promises` is enough. |
| Path overlap detection | string `startsWith` | `realpath` both paths first, then `startsWith(other + sep)` | Symlinks (e.g., `/Users/zorahrel/.omnara/worktrees/jarvis/...` ↔ canonical) will silently miss conflicts otherwise. Use `fs.realpath` from stdlib. |
| Cwd canonicalization | manual `~` expansion | Use `homedir()` + `realpath` (both stdlib) | Already done in `discovery.ts` lines 273. |
| Confidence scoring of suggestions | LLM call | Lookup table `(refinedStatus, last_action, history) → confidence` | CONTEXT.md says deterministic only. See "Deterministic suggestion engine" section. |

**Key insight:** Every problem this phase touches has either a Phase 1 helper or a battle-tested macOS CLI ready to go. The only NEW code is glue — the orchestrator service, the suggestion engine table, and the audit writer.

## Common Pitfalls

### Pitfall 1: tmux pane targets become stale
**What goes wrong:** A `pane_id` resolved at 10:00 may not exist at 10:05 (window closed, session detached, pane killed by user). `tmux send-keys -t <stale_pane>` returns non-zero with "can't find pane".
**Why it happens:** tmux pane IDs are recycled across sessions; PIDs outlive panes when shells exit.
**How to avoid:** Resolve `pane_id` *immediately before* every send-keys call by re-running `tmux list-panes -aF ...` and matching by PID. Cache for at most 1s. On 409, retry once after re-resolving; if still stale, return error to dashboard with `"pane_lost"` reason.
**Warning signs:** Inject success rate < 99% on tmux-running sessions in dashboard logs.

### Pitfall 2: Reminders permission prompt blocks first run
**What goes wrong:** First call to any EventKit-backed CLI on macOS triggers a system permission dialog. The router process (run by launchd) does not have a UI to display it, so EventKit silently returns no data → looks like "0 reminders".
**Why it happens:** macOS Privacy & Security gates Reminders behind explicit per-app authorization.
**How to avoid:** Phase 2 first-launch flow MUST: (1) detect whether `remindctl status` reports authorized; if not, (2) surface a dashboard banner instructing the user to run `remindctl authorize` from a TTY (not from launchd). Until authorized, gracefully degrade to local-file fallback `~/.claude/jarvis/todos.json`.
**Warning signs:** `remindctl lists --json` returns `[]` despite the user having reminders. `remindctl status` returns `{"authorized": false}`.

### Pitfall 3: JSONL transcripts contain mixed entry types beyond `assistant`/`user`
**What goes wrong:** Live JSONL inspection shows three relevant top-level shapes:
- `{"type":"assistant", "message": {"role":"assistant", "content":[...], "stop_reason":..., "usage":...}, ...}` — the assistant turn
- `{"type":"attachment", "attachment":{"type":"hook_success", "hookName":"Stop", ...}, ...}` — hook event payload
- `{"type":"last-prompt", "lastPrompt":"..."}` — sidecar marker (last-prompt summary)
- Older transcripts may also include `{"type":"user", "message":{"role":"user", ...}}` and `{"type":"summary"}` (compaction).
A naive "find last assistant" loop that only checks `type === "assistant"` works, but downstream logic that scans `content[]` for `tool_use` blocks must filter by `block.type === "tool_use"` and pair with the next entry whose `content[]` contains a `tool_result` with matching `tool_use_id`.
**Why it happens:** Claude Code's transcript format is a stream union, not a normalized table.
**How to avoid:** `extractPendingToolUses()` walks the JSONL backwards, collects each `tool_use.id`, then matches against later `tool_result.tool_use_id`; any unmatched id = pending.
**Warning signs:** `refinedStatus` says `tool_pending` for a session that actually completed turns ago.

### Pitfall 4: tmux `send-keys` with multi-line text needs careful escaping
**What goes wrong:** Verified live test: `tmux send-keys -t session "line1" Enter "line2" Enter` works (each string is its own argument with explicit `Enter` literals between them). But `tmux send-keys -t session "line1\nline2"` does NOT — `\n` is literal. Also `$`, `` ` ``, and `"` need careful argument-array passing when text comes from user input.
**Why it happens:** `send-keys` interprets each argument as a typed sequence; `Enter` is a key name, not a character.
**How to avoid:** Always invoke via `execFile("tmux", ["send-keys", "-t", paneId, "--", text, "Enter"])`. The `--` terminates option parsing so a user-supplied `text="-foo"` cannot inject flags. For multi-line text, split on `\n` and pass `... text1, "Enter", text2, "Enter"`. Pass arguments as an array — never compose a shell command string.
**Warning signs:** Injected text appears garbled, or special characters are dropped.

### Pitfall 5: Reminders eventual consistency (3-15s lag)
**What goes wrong:** User checks off a todo on iPhone; the Mac's Reminders.app (and therefore EventKit) sees the change only after iCloud sync. CONTEXT.md accepts 3-15s lag.
**Why it happens:** iCloud sync is push-based but throttled.
**How to avoid:** Plan UX around this: optimistic UI (mark complete locally, reconcile on next poll), and ALWAYS prefer the remote state on conflict. Audit log records both the local optimistic action AND the eventual server-confirmed state.
**Warning signs:** Notch shows a todo as still open 30s after the user ticks it on iPhone — investigate iCloud Reminders sync settings, not the code.

### Pitfall 6: Bare Terminal.app sessions silently appear "writable"
**What goes wrong:** A session shows up in `discoverLocalSessions()` with a TTY but is NOT under tmux. The orchestrator must NOT offer Approve/Skip/Custom for these — but the UI must still display them so the user has visibility.
**Why it happens:** Discovery treats all Claude CLI processes equally.
**How to avoid:** `/api/sessions/:pid/tmux` returns `{has_tmux: false}` for bare TTYs; dashboard disables write controls and shows a tooltip "no tmux pane — start under tmux to enable inject". Skill output sets `action.type: "none"` with `reason: "no_tmux"`.
**Warning signs:** A user clicks Approve on a bare-TTY session and the inject silently fails with no UI feedback.

### Pitfall 7: Audit log rotation race
**What goes wrong:** Two near-simultaneous injects each detect file > 10 MB and both rename → second rename fails or overwrites.
**Why it happens:** Append + stat + rename is not atomic.
**How to avoid:** Single in-process mutex around the audit writer (Promise queue). Router is single-process so no inter-process coordination needed.
**Warning signs:** Audit JSONL files with timestamps overlapping or one of the rotated archives is empty.

### Pitfall 8: Lock-per-cwd false positives across worktrees
**What goes wrong:** Two `git worktree`-managed sessions on different branches share a parent cwd ancestor. Naive `startsWith(other + "/")` flags them as conflicting even though they edit independent worktrees.
**Why it happens:** worktrees live under sibling paths but their parent (e.g., `~/.omnara/worktrees/`) is shared.
**How to avoid:** Lock check applies to the deepest common cwd ancestor that's INSIDE a `.git`-rooted repo. Walk up from each cwd until finding `.git` or `.git` file (worktree). Conflict only if both worktree roots resolve to the same root OR one cwd is a strict subpath of the other AND both share the same git root.
**Warning signs:** User reports "every session conflicts with every other session" — likely your sub-path detection is too aggressive.

## Code Examples

### JSONL transcript shape — verified live (head of last assistant entry from a real router-spawned session)
```jsonl
{"parentUuid":"b9124de4-...","isSidechain":false,"message":{"model":"claude-opus-4-7","id":"msg_01...","type":"message","role":"assistant","content":[{"type":"text","text":"..."}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":6,"cache_creation_input_tokens":21153,"cache_read_input_tokens":21993,"output_tokens":514,...}},"requestId":"req_011...","type":"assistant","uuid":"d99f624b-...","timestamp":"2026-04-28T11:08:51.341Z","userType":"external","entrypoint":"sdk-ts","cwd":"/Users/zorahrel/.claude/jarvis/agents/jarvis","sessionId":"9798b85b-25b5-436e-9314-5e2627b1d6af","version":"2.1.119","gitBranch":"main"}
{"parentUuid":"d99f624b-...","isSidechain":false,"attachment":{"type":"hook_success","hookName":"Stop","toolUseID":"4269cb1a-...","hookEvent":"Stop","content":"","stdout":"...","stderr":"","exitCode":200},"type":"attachment","uuid":"d1c7071d-...","timestamp":"2026-04-28T11:08:51.465Z",...}
{"type":"last-prompt","lastPrompt":"...","sessionId":"9798b85b-..."}
```
**Fields the orchestrator MUST surface in `/api/sessions/:pid/transcript`:** `role`, `content[]` (with each block's `type`, `text`, `name`, `id`, `input`), `tool_use[]` flattened, `tool_result[]` flattened with matching `tool_use_id`, `stop_reason`, `timestamp`, `uuid`, `sessionId`, `gitBranch`. Skip `attachment` and `last-prompt` rows for the user-visible transcript but use them internally for crash detection.

### tmux pid → pane mapping (verified live on this Mac)
```bash
# Source: tmux(1) man page — list-panes
tmux list-panes -aF '#{pane_pid} #{session_name} #{pane_id} #{window_index} #{pane_active}'
# Output (one line per pane across ALL sessions):
# 52706 _gsd_test_session %0 0 1
# 52899 work-jarvis %1 0 1
# 52905 work-jarvis %2 1 0
```
The first column is the pane's foreground process pid. **Important:** Claude CLI under tmux runs as a child of the shell, which is the pane's tty foreground process. Resolution requires walking parents:
```typescript
// Pseudocode for tmuxMap.ts — use execFile + arg-array everywhere
async function findPaneForPid(targetPid: number): Promise<{ session: string; pane: string } | null> {
  const { stdout } = await execFileAsync("tmux", ["list-panes", "-aF", "#{pane_pid} #{session_name} #{pane_id}"]);
  const panes = stdout.trim().split("\n").map(l => {
    const [pid, sess, pane] = l.split(" ");
    return { pid: parseInt(pid, 10), session: sess, pane };
  });
  // Walk parent PIDs from targetPid up until we find one in the panes list (or PID 1)
  let cur = targetPid;
  while (cur > 1) {
    const hit = panes.find(p => p.pid === cur);
    if (hit) return { session: hit.session, pane: hit.pane };
    const { stdout: ppid } = await execFileAsync("ps", ["-o", "ppid=", "-p", String(cur)]).catch(() => ({ stdout: "" }));
    cur = parseInt(ppid.trim(), 10) || 0;
  }
  return null;
}
```

### tmux send-keys inject (verified live, with multi-line + escape)
```typescript
// Source: tmux send-keys man page; verified on tmux 3.6a
// IMPORTANT: arguments are passed as an ARRAY to execFile — no shell, no string composition.
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);

async function injectToPane(paneId: string, text: string): Promise<void> {
  const lines = text.split("\n");
  const args = ["send-keys", "-t", paneId, "--"];
  for (let i = 0; i < lines.length; i++) {
    args.push(lines[i]);
    args.push("Enter");
  }
  await execFileAsync("tmux", args);
}

// For audit: read back what arrived in the pane
async function capturePane(paneId: string, lines = 50): Promise<string> {
  const { stdout } = await execFileAsync("tmux", ["capture-pane", "-t", paneId, "-p", "-S", `-${lines}`]);
  return stdout;
}
```

### remindctl JSON contract (verified live)
```bash
# List all reminder lists
$ remindctl lists --json
[
  { "id": "CAB473F3-...", "title": "🟡 Armonia", "reminderCount": 9, "overdueCount": 0 },
  { "id": "5875F3A6-...", "title": "🟢 Backlog", "reminderCount": 4, "overdueCount": 0 },
  ...
]

# Show reminders in a list (filter by completion)
$ remindctl show all --list "Jarvis/ActiveTasks" --json
# returns array of { id, title, list, due?, notes?, priority, completed, ... }

# Add reminder
$ remindctl add "Plan 02-01 — refinedStatus" --list "Jarvis/ActiveTasks" --notes "pid:12345 repo:jarvis phase:plan" --json
# returns { id, title, list, ... }

# Complete by id-prefix or index
$ remindctl complete CAB4 --json
# returns { ok: true, completed: [{ id, title }] }
```

### Reminders metadata schema (parser/formatter, bidirectional)
```typescript
// Source: this RESEARCH (locked in CONTEXT.md)
const META_LINE = /^pid:(\d+)\s+repo:([^\s]+)\s+phase:(plan|exec|review)\s*$/m;

export function parseTodoMetadata(notes: string | null | undefined): { pid?: number; repo?: string; phase?: "plan"|"exec"|"review" } {
  if (!notes) return {};
  const m = notes.match(META_LINE);
  if (!m) return {};
  return { pid: parseInt(m[1], 10), repo: m[2], phase: m[3] as "plan"|"exec"|"review" };
}

export function formatTodoMetadata(meta: { pid: number; repo: string; phase: "plan"|"exec"|"review" }): string {
  return `pid:${meta.pid} repo:${meta.repo} phase:${meta.phase}`;
}
```
The metadata line is the LAST line of the body so user-edited Reminders text doesn't accidentally collide. When writing, append `\n\n` + `formatTodoMetadata()` so the user sees their notes first.

### Refined session-status derivation (locked rules from CONTEXT.md `<specifics>`)
```typescript
// Source: CONTEXT.md "State derivation" + this research
import type { LocalSession } from "../localSessions/types.js";
import { extractLastAssistantTurn, extractPendingToolUses } from "../contextInspector/jsonlParser.js";
import { promises as fs } from "fs";

export type RefinedStatus = "awaiting_user_input" | "tool_pending" | "crashed" | "working" | "idle";

const IDLE_THRESHOLD_MS = 30_000;

export async function deriveRefinedStatus(s: LocalSession): Promise<RefinedStatus> {
  if (!s.transcriptPath) return "idle";
  // crashed: pid not in ps but JSONL last turn has no stop_reason
  // (note: by the time we get here, s came from discovery, so pid IS in ps; crashed only meaningful if discovery returns stale ones)
  const last = await extractLastAssistantTurn(s.transcriptPath);
  const pending = await extractPendingToolUses(s.transcriptPath);
  if (pending.length > 0) return "tool_pending";

  const transcriptStat = await fs.stat(s.transcriptPath).catch(() => null);
  const lastWriteAge = transcriptStat ? Date.now() - transcriptStat.mtimeMs : Infinity;

  // awaiting_user_input: last turn = assistant, no pending tool_use, idle ≥ 30s
  if (last && last.stop_reason === "end_turn" && lastWriteAge >= IDLE_THRESHOLD_MS) {
    return "awaiting_user_input";
  }
  // working: process active, recent activity
  if (lastWriteAge < IDLE_THRESHOLD_MS) return "working";
  // idle: process active, no recent JSONL append
  return "idle";
}

// crashed handling lives in the snapshot composer, which compares discovery PIDs
// against an earlier known-set: if a transcript has incomplete last turn AND its
// pid is gone from ps, mark as "crashed".
```

### Deterministic suggestion engine + confidence
```typescript
// Source: this research, satisfies ORC-04 + ORC-22 (no LLM)
type Suggestion = {
  text: string; // human-readable
  action: { type: "inject"; text: string } | { type: "abort" } | { type: "restart" } | { type: "none" };
  confidence: "low" | "medium" | "high";
  reason: string;
};

export function suggestNext(s: LocalSession & { refinedStatus: RefinedStatus; lastAssistantSummary: string | null }): Suggestion {
  switch (s.refinedStatus) {
    case "awaiting_user_input": {
      // Heuristic: if the last assistant text contains a yes/no question or "approve"/"y/n" pattern,
      // suggest "y" with HIGH confidence. Otherwise suggest a generic ack with LOW.
      const last = (s.lastAssistantSummary ?? "").toLowerCase();
      if (/\b(approve|approval|y\/n|proceed\?|continue\?)\b/.test(last) || /\?$/.test(last.trim())) {
        return { text: "Approve and proceed", action: { type: "inject", text: "y" }, confidence: "high", reason: "explicit approval prompt" };
      }
      return { text: "Acknowledge", action: { type: "inject", text: "ok" }, confidence: "low", reason: "ambiguous prompt" };
    }
    case "tool_pending":
      return { text: "Wait — tool call in flight", action: { type: "none" }, confidence: "high", reason: "tool_use unmatched" };
    case "crashed":
      return { text: "Restart session", action: { type: "restart" }, confidence: "medium", reason: "process gone, transcript incomplete" };
    case "working":
      return { text: "Working — let it run", action: { type: "none" }, confidence: "high", reason: "active progress" };
    case "idle":
      return { text: "Idle — check in", action: { type: "none" }, confidence: "low", reason: "no recent activity but no prompt either" };
  }
}

// Auto-pilot rule (Plan 02-05): apply ONLY when confidence === "high" AND action.type === "inject" with predetermined text.
// Custom inject (action.text from user textarea) is ALWAYS confidence=low → never auto.
```

### Lock-per-cwd (sub-path overlap with worktree awareness)
```typescript
import { promises as fs } from "fs";
import { dirname, sep } from "path";

async function findGitRoot(p: string): Promise<string | null> {
  let cur = await fs.realpath(p);
  while (cur !== "/" && cur !== "") {
    try {
      await fs.stat(`${cur}/.git`); // file or dir — both indicate worktree root
      return cur;
    } catch { /* keep walking */ }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export async function detectConflict(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
  // Direct subpath overlap on canonical paths
  if (ra === rb) return true;
  if (ra.startsWith(rb + sep) || rb.startsWith(ra + sep)) {
    // Confirm same git root — sibling worktrees of same repo do NOT conflict
    const [ga, gb] = await Promise.all([findGitRoot(ra), findGitRoot(rb)]);
    if (ga && gb && ga !== gb) return false;
    return true;
  }
  return false;
}
```

### Audit log format & rotation
```typescript
// Source: CONTEXT.md (audit specifics) + ORC-17 + this research
import { promises as fs } from "fs";
import { join } from "path";
import { homedir } from "os";

const AUDIT_DIR = join(homedir(), ".claude", "jarvis", "orchestrator");
const AUDIT_FILE = join(AUDIT_DIR, "audit.jsonl");
const ROTATE_BYTES = 10 * 1024 * 1024;

let writeQueue: Promise<void> = Promise.resolve();

export interface AuditEntry {
  ts: number;            // Date.now()
  pid: number;
  repo: string;
  action: "inject" | "abort" | "restart";
  text?: string;          // payload for inject
  source: "user-approved" | "auto" | "skill";
  confidence?: "low" | "medium" | "high";
  reason?: string;
}

export function appendAudit(entry: AuditEntry): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(AUDIT_DIR, { recursive: true });
    try {
      const st = await fs.stat(AUDIT_FILE);
      if (st.size > ROTATE_BYTES) {
        const archive = `${AUDIT_FILE}.${Date.now()}`;
        await fs.rename(AUDIT_FILE, archive);
      }
    } catch { /* file doesn't exist — fine */ }
    await fs.appendFile(AUDIT_FILE, JSON.stringify(entry) + "\n", "utf8");
  }).catch(() => undefined);
  return writeQueue;
}
```

### Orchestrator skill output contract
```jsonc
// Source: CONTEXT.md <specifics> + ORC-03
// Skill returns markdown with a single fenced JSON code block:
{
  "generated_at": "2026-05-07T15:00:00Z",
  "sessions": [
    {
      "pid": 12345,
      "repo": "jarvis",
      "branch": "feature/orchestrator",
      "cwd": "/Users/zorahrel/.claude/jarvis",
      "status": "awaiting_user_input",
      "last_assistant_summary": "Plan ready, requesting approval to write 4 files",
      "suggestion": "Approve plan and proceed",
      "action": { "type": "inject", "text": "y" },
      "confidence": "high",
      "todo_link": "CAB473F3-0A47-44A4-84A8-58A9D976D917",
      "tmux": { "session": "work-jarvis", "pane": "%2" },
      "conflict": null
    },
    {
      "pid": 67890,
      "repo": "jarvis",
      "branch": "feature/orchestrator",
      "cwd": "/Users/zorahrel/.claude/jarvis/router",
      "status": "tool_pending",
      "last_assistant_summary": "Reading dashboard/api.ts",
      "suggestion": "Wait — tool call in flight",
      "action": { "type": "none" },
      "confidence": "high",
      "todo_link": null,
      "tmux": null,
      "conflict": "12345"
    }
  ]
}
```
Below the JSON, the skill MUST emit ONE LINE of natural-language summary so a chat-only consumer (without parsing) gets a quick read.

## Runtime State Inventory

This phase creates new state but does not rename or migrate prior state. Inventory:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | NEW: `~/.claude/jarvis/orchestrator/audit.jsonl` (append-only, rotated). NEW: optional `~/.claude/jarvis/todos.json` local fallback when Reminders unauthorized. | Create directories on first launch via `fs.mkdir(..., { recursive: true })`; no migration |
| Live service config | NEW: `auto_pilot.enabled: false` and `auto_pilot.daily_token_cap: 100000` keys in `router/config.yaml`. ABSENT in current config — Plan 02-05 must add documented examples to `config.example.yaml`. | Code edit (config-loader needs no schema change — these are optional fields); plan to add an example block to `config.example.yaml` |
| OS-registered state | macOS Reminders authorization grant for `remindctl` — NOT yet granted on this machine (only `remindctl --version` was tested, no list-call ran with full auth context). User must run `remindctl authorize` once after install. | Manual user action documented in dashboard banner + skill error path |
| Secrets / env vars | NONE — no new env vars or secrets. `JARVIS_SPAWN=1` already exists; auto-pilot guards on it. | None |
| Build artifacts | NEW Swift views (`SessionsSidebarView.swift`, `TodoStripView.swift`) require `tray-app/make-app.sh` rebuild after changes. Existing `JarvisNotch` app is built and signed. | Rebuild step in 02-03 plan |

**Nothing found in category — explicit:**
- No data migrations (this is a new feature, not a rename).
- No env-var renames or secret rotations.
- No package renames; `pyproject.toml`/`package.json` package names unchanged.

## Environment Availability

Live probe results (executed 2026-05-07 on `Darwin 25.2.0 arm64`):

| Dependency | Required By | Available | Version | Fallback |
|---|---|---|---|---|
| `tmux` | ORC-15, ORC-16 inject mechanism | yes | 3.6a | — (sessions without tmux become read-only — by design, ORC-15) |
| Node.js | All router code | yes | v25.9.0 | — |
| TypeScript / tsx | Router runtime | yes | tsx 4.19+, ts 5.9.3 | — |
| Swift / Xcode | JarvisNotch Swift views | yes | Swift 6.3.1 / Xcode 26.4.1 | — |
| `remindctl` | ORC-06 Reminders bridge (primary) | yes | 0.1.1 from `steipete/tap` | `apple-reminders-cli`, `ekctl`, local-file `~/.claude/jarvis/todos.json` |
| `apple-reminders-cli` (`reminder` binary) | ORC-06 Reminders bridge (fallback #1, named in CONTEXT.md) | no | — | `remindctl` (already installed and equivalent JSON contract) |
| `ekctl` | ORC-06 Reminders bridge (fallback #2, named in CONTEXT.md) | no | — | `remindctl` |
| Reminders authorization for `remindctl` | ORC-06 read/write to user reminders | unknown | — | `remindctl authorize` (one-time interactive) → fall back to local file until authorized |
| macOS Privacy & Security: Reminders for Terminal/launchd context | ORC-06 invocation from router (launchd) | unknown | — | First call from launchd may fail silently; orchestrator detects and surfaces dashboard banner |
| `lsof` (`/usr/sbin/lsof`) | localSessions discovery (Phase 1, reused) | yes (Phase 1 already verified) | macOS bundled | — |
| `git` | Branch resolution per session | yes (Phase 1 reuses) | macOS bundled | — |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:**
- `apple-reminders-cli` and `ekctl` are missing but `remindctl` covers the same surface. The plan should treat them as detection-time fallbacks, not install-time hard requirements.

**Dependencies requiring user action before first run:**
- `remindctl authorize` — one-time interactive grant of Reminders access. Plan 02-02 must surface this in dashboard if not granted.

## Validation Architecture

`workflow.nyquist_validation` is **not** explicitly disabled in `.planning/config.json` (file is empty / not present at the time of research) — section is INCLUDED.

### Test Framework
| Property | Value |
|---|---|
| Framework | `node:test` (Node 25.9 stdlib) + `node:assert/strict` |
| Config file | none — runner is `tsx --test src/**/*.spec.ts` (no jest.config / vitest.config) |
| Quick run command (single file) | `cd ~/.claude/jarvis/router && npx tsx --test src/services/orchestrator/refinedStatus.spec.ts` |
| Quick run command (orchestrator only) | `cd ~/.claude/jarvis/router && npx tsx --test 'src/services/orchestrator/*.spec.ts' 'src/services/reminders/*.spec.ts'` |
| Full suite command | `cd ~/.claude/jarvis/router && npx tsx --test 'src/**/*.spec.ts'` |
| Type-check command | `cd ~/.claude/jarvis/router && npm run typecheck` |
| Dashboard build | `cd ~/.claude/jarvis/router/dashboard && npm run build` |
| Swift build | `bash ~/.claude/jarvis/tray-app/make-app.sh` |
| Router restart (manual UAT) | `launchctl kickstart -k gui/$(id -u)/com.jarvis.router` |
| Live tmux end-to-end | bash script: spin a tmux session running `cat`, hit `/api/sessions/:pid/inject`, capture-pane, assert echo |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|---|---|---|---|---|
| ORC-01 | `/api/sessions/:pid/transcript?limit=N` returns last-N JSON-structured turns | integration | `npx tsx --test src/dashboard/api.transcript.spec.ts` | gap — Wave 0 |
| ORC-01 | jsonlParser extracts last assistant + pending tool_uses + stop_reason | unit | `npx tsx --test src/services/contextInspector/jsonlParser.spec.ts` (ADD cases — file exists) | extend existing |
| ORC-02 | refinedStatus rules: awaiting_user_input / tool_pending / crashed / working / idle | unit | `npx tsx --test src/services/orchestrator/refinedStatus.spec.ts` | gap — Wave 0 |
| ORC-03 | skill → router HTTP roundtrip returns valid JSON contract | integration | `npx tsx --test src/services/orchestrator/snapshot.spec.ts` (HTTP-stubbed) + manual e2e via `/orchestrator` slash | gap — Wave 0 |
| ORC-04 | suggestion engine deterministic table | unit | `npx tsx --test src/services/orchestrator/suggest.spec.ts` (table-driven, no network) | gap — Wave 0 |
| ORC-05 | cwd lock detection w/ worktree awareness | unit | `npx tsx --test src/services/orchestrator/lock.spec.ts` (uses temp-dir fixtures with .git markers) | gap — Wave 0 |
| ORC-06 | reminders.ts CLI wrapper: list/add/complete | unit | `npx tsx --test src/services/reminders/cli.spec.ts` (mocks `child_process.execFile`) | gap — Wave 0 |
| ORC-06 | reminders.ts CLI wrapper end-to-end against `remindctl` | integration (skipped on CI without auth) | `JARVIS_REMINDERS_LIVE=1 npx tsx --test src/services/reminders/cli.live.spec.ts` | gap — Wave 0 |
| ORC-07 | poll loop emits added/completed/updated diffs | unit | `npx tsx --test src/services/reminders/poll.spec.ts` (synthetic before/after lists) | gap — Wave 0 |
| ORC-08 | metadata parse/format round-trip | unit | `npx tsx --test src/services/reminders/metadata.spec.ts` | gap — Wave 0 |
| ORC-09 | `/api/todos` GET/POST + `/complete` happy path + auth-degraded path | integration | `npx tsx --test src/dashboard/api.todos.spec.ts` | gap — Wave 0 |
| ORC-10 | dashboard Todos tab renders + 5s refresh hook | unit (vitest unavailable — react-test plain) | manual UAT only via dashboard build + visual check | manual-only |
| ORC-11/12 | Swift sidebar + strip render | manual-only | Build + open notch, visually inspect | manual-only |
| ORC-13 | Notch click/long-press semantics | manual-only | Click + long-press from JarvisNotch in expanded mode | manual-only |
| ORC-14 | Notch reconnect graceful | unit (Swift `XCTest`) | `xcodebuild test -scheme JarvisNotch -destination 'platform=macOS,arch=arm64'` | gap — Wave 0 (only if XCTest target exists) |
| ORC-15 | `/api/sessions/:pid/tmux` returns `{has_tmux, session_name?, pane_id?}` | integration | `npx tsx --test src/dashboard/api.tmux.spec.ts` (spawns real tmux session, asserts mapping) | gap — Wave 0 |
| ORC-16 | `/api/sessions/:pid/inject` happy path + 409 on no-tmux + 409 on lock | integration | `npx tsx --test src/dashboard/api.inject.spec.ts` (spawns tmux + cat + asserts capture-pane) | gap — Wave 0 |
| ORC-17 | audit append-only + rotation at 10 MB | unit | `npx tsx --test src/services/orchestrator/audit.spec.ts` (uses tempdir + mock 10MB file) | gap — Wave 0 |
| ORC-18 | dashboard Approve/Skip/Custom controls disabled correctly | manual-only | Click each control state, assert disabled tooltips | manual-only |
| ORC-19 | force-typing modal flow | manual-only | Type wrong word, confirm reject; type `force`, confirm proceed | manual-only |
| ORC-20 | `auto_pilot.enabled: false` = zero side-effects | unit | `npx tsx --test src/services/orchestrator/autopilot.spec.ts` (assert no hook subscribe) | gap — Wave 0 |
| ORC-21 | budget guard reads `/api/sessions/aggregate` and gates inject | integration | same spec, with HTTP stub for aggregate | gap — Wave 0 |
| ORC-22 | hook applies only `confidence: high` | unit | same `autopilot.spec.ts` table cases | gap — Wave 0 |

### Sampling Rate
- **Per task commit:** `npx tsx --test '<files-touched>.spec.ts'` (sub-30s)
- **Per wave merge:** `npx tsx --test 'src/services/orchestrator/*.spec.ts' 'src/services/reminders/*.spec.ts' 'src/dashboard/api.*.spec.ts'` + `npm run typecheck`
- **Phase gate:** Full suite green: `npx tsx --test 'src/**/*.spec.ts'` + `npm run typecheck` + dashboard build + Swift build + manual UAT pass before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/services/orchestrator/__fixtures__/sample-bare.jsonl` — sample bare-CLI session JSONL (capture from a real `~/.claude/projects/...` file, redact secrets)
- [ ] `src/services/orchestrator/__fixtures__/sample-router.jsonl` — sample router-spawned session JSONL
- [ ] `src/services/orchestrator/__fixtures__/sample-tool-pending.jsonl` — JSONL with unmatched `tool_use` (verifies `tool_pending`)
- [ ] `src/services/orchestrator/__fixtures__/sample-crashed.jsonl` — JSONL where last assistant lacks `stop_reason`
- [ ] `src/services/orchestrator/refinedStatus.spec.ts` — covers ORC-02
- [ ] `src/services/orchestrator/suggest.spec.ts` — covers ORC-04, ORC-22
- [ ] `src/services/orchestrator/lock.spec.ts` — covers ORC-05, ORC-19 sub-path detection
- [ ] `src/services/orchestrator/audit.spec.ts` — covers ORC-17
- [ ] `src/services/orchestrator/autopilot.spec.ts` — covers ORC-20, ORC-21, ORC-22
- [ ] `src/services/orchestrator/tmuxMap.spec.ts` — uses real tmux for end-to-end (skip on CI w/o tmux)
- [ ] `src/services/reminders/cli.spec.ts` — mocked execFile, covers ORC-06
- [ ] `src/services/reminders/poll.spec.ts` — covers ORC-07
- [ ] `src/services/reminders/metadata.spec.ts` — covers ORC-08
- [ ] `src/services/reminders/__fixtures__/sample-list.json` — captured `remindctl lists --json` output
- [ ] `src/services/reminders/__fixtures__/sample-show-active.json` — captured `remindctl show all --list "Jarvis/ActiveTasks" --json`
- [ ] `src/dashboard/api.transcript.spec.ts` — covers ORC-01 HTTP
- [ ] `src/dashboard/api.tmux.spec.ts` — covers ORC-15
- [ ] `src/dashboard/api.inject.spec.ts` — covers ORC-16, ORC-19 (409 paths)
- [ ] `src/dashboard/api.todos.spec.ts` — covers ORC-09
- [ ] `src/services/contextInspector/jsonlParser.spec.ts` — ADD cases for `extractLastAssistantTurn`, `extractPendingToolUses`, `getStopReason` (file exists, extend it)
- [ ] If Swift Notch needs unit tests (ORC-14 reconnect): create XCTest target under `tray-app/Tests/JarvisNotchTests/` (does not currently exist — verify before requiring)
- [ ] `Jarvis/ActiveTasks` Reminders list — must be created on first run (idempotent; `remindctl` does NOT auto-create lists, must be either created via Reminders.app or via an `addList` call if the CLI exposes one)

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|---|---|---|---|
| AppleScript via `osascript` to manipulate Reminders | EventKit-backed CLIs (`remindctl`, `apple-reminders-cli`, `ekctl`) | macOS Sonoma 14+ | Native EventKit access, JSON output, stable across macOS upgrades |
| Mounting Claude Code's transcript via undocumented socket | Read JSONL files directly from `~/.claude/projects/-Users-.../<uuid>.jsonl` | Stable across Claude Code 2.1.x | Phase 1 already standardized this; just keep tail-reading |
| `UserPromptSubmit` hook + file watch as inject mechanism | `tmux send-keys` | This phase (CONTEXT.md decision) | Zero modifications to Claude Code; works on existing sessions; no async race |
| Per-feature notch event union pollution | Namespaced event modules (`notch/events.ts` for chat, `notch/orchestrator-events.ts` for orchestrator) | This phase | Keeps NotchConnector's existing TypeScript union stable |
| Custom token rotation libraries | Stdlib `fs.appendFile` + size-based `fs.rename` | Always — match Phase 1 audit-style logging | One less dependency |

**Deprecated / outdated:**
- AppleScript Reminders manipulation in 2026: still works, but slow and prone to permission prompts. Not recommended.
- Claude Code Agent Teams API (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`): documented but explicitly rejected in CONTEXT.md (single-process lead requirement).
- `@anthropic-ai/tokenizer` / tiktoken: rejected for token math in Phase 1 (REQUIREMENTS.md "Out of Scope") — Phase 2 inherits this; if any cost/token math is needed in audit log it uses `usage` from JSONL.

## Open Questions

1. **Should the orchestrator skill output be a single JSON block, or a multi-section markdown with one fenced JSON per session?**
   - What we know: CONTEXT.md `<specifics>` shows ONE entry per session in a single object. Existing skills like `jarvis-config` are prose-heavy; `restart` is action-flow. No precedent for a JSON-emitting skill.
   - What's unclear: dashboard Orchestrator tab has its own data flow (HTTP, not skill-output). Does the skill ever need to be parsed by another agent, or is it just for the user reading in chat?
   - Recommendation: Single JSON object as shown in "Orchestrator skill output contract" + a one-line natural-language summary above it. Lock this in plan 02-01.

2. **Does the `Jarvis/ActiveTasks` Reminders list pre-exist, or must we create it?**
   - What we know: live probe shows 5 lists on this Mac (Lavoro, Promemoria, Armonia, Backlog, Personale). `Jarvis/ActiveTasks` is NOT among them. `remindctl` help does not show a `lists add` subcommand.
   - What's unclear: whether `remindctl add ... --list "Jarvis/ActiveTasks"` auto-creates a missing list (likely no — most EventKit CLIs error). May need user-instructed manual creation OR a one-time AppleScript fallback to create the list.
   - Recommendation: First-run check — if list missing, surface a dashboard banner + skill-side error with one-line `osascript` snippet for the user to paste. Document in 02-02.

3. **What is the polling cost for `remindctl show all --list "Jarvis/ActiveTasks" --json` at 3s?**
   - What we know: `remindctl lists --json` returned in <100ms on this Mac. Fork+EventKit query is cheap. CPU likely negligible.
   - What's unclear: behavior under iCloud sync activity, network outage, or large lists (100+ items).
   - Recommendation: Cap list size at first 100 open items (matches ORC-09 constraint); add a per-poll timeout of 2s; if exceeded, log warning and skip that cycle. Test live in Plan 02-02.

4. **For `auto_pilot` recursive-trigger guard, where exactly does `JARVIS_SPAWN=1` live for tmux-bare sessions?**
   - What we know: router-spawned sessions get `JARVIS_SPAWN=1` injected at spawn time. Bare CLI sessions started by user under tmux do NOT have this env var.
   - What's unclear: if auto-pilot is on AND a router-spawned session is running under tmux (legitimate config), does the inject loop trigger? Probably not because the SDK-driven session has a different inject path, but worth verifying.
   - Recommendation: Document in 02-05. The `UserPromptSubmit` hook MUST self-guard on `JARVIS_SPAWN=1` (skip auto-action if set, since the router is already orchestrating that session).

5. **Is there an existing `/api/sessions/aggregate` endpoint from Phase 1 that auto-pilot can read for the daily-cap budget check (ORC-21)?**
   - What we know: Phase 1's `/api/local-sessions` returns aggregate counters; CTX-04 covers cost-per-route + daily aggregate. No route literally named `/aggregate` was found in the dashboard API grep.
   - What's unclear: which existing endpoint reports total daily token usage?
   - Recommendation: Plan 02-05 should either expose `/api/sessions/aggregate` (extracting the daily total computed inside the existing handler) OR read directly from the same source the dashboard uses. Verify before locking the contract.

## Sources

### Primary (HIGH confidence)
- Live tmux probe on this machine (2026-05-07): `tmux 3.6a` at `/opt/homebrew/bin/tmux`; multi-line + escaped `send-keys` round-trip verified
- Live `remindctl 0.1.1` probe: `lists --json`, `--help` for `add/show/complete` all returned JSON-shaped output
- Live JSONL inspection of `~/.claude/projects/-Users-zorahrel--claude-jarvis-agents-jarvis/9798b85b-25b5-436e-9314-5e2627b1d6af.jsonl` — confirmed message shape including `stop_reason`, `usage`, `attachment` rows, and `last-prompt` rows
- `router/src/services/contextInspector/jsonlParser.ts` (Phase 1) — already implements `readJsonlTailLines`, `extractToolUseEvents`, `sumTokens`, `countTurns`
- `router/src/services/contextInspector/breakdown.spec.ts` — confirmed `node:test` + `node:assert/strict` + `__fixtures__/` pattern
- `router/src/services/localSessions/discovery.ts` — `LocalSession` type, 2s cache TTL, lsof+ps+JSONL pattern
- `router/src/connectors/notch.ts` + `router/src/notch/events.ts` — singleton-with-getInstance + Set<Subscriber> emit pattern
- `router/src/dashboard/api.ts` lines 1843-2344 — existing API route pattern; `/api/local-sessions` at line 2132
- `~/.claude/jarvis/CLAUDE.md`, `~/.claude/jarvis/ARCHITECTURE.md` — project rules + spawn discipline + skills outside `~/.claude/`
- `~/.claude/jarvis/.planning/REQUIREMENTS.md`, `STATE.md`, `ROADMAP.md`, `phases/02-orchestrator-multi-session/02-CONTEXT.md` — locked decisions

### Secondary (MEDIUM confidence)
- [tmux send-keys man page](https://man.openbsd.org/tmux.1) — verified flag semantics for `--`, `Enter`, `-t`
- [remindctl GitHub (steipete/remindctl)](https://github.com/steipete/remindctl) — JSON output flag, EventKit backing
- [apple-reminders-cli (AungMyoKyaw)](https://github.com/AungMyoKyaw/apple-reminders-cli) — fallback CLI named in CONTEXT.md
- [ekctl (schappim/ekctl)](https://github.com/schappim/ekctl) — second fallback named in CONTEXT.md
- WebSearch 2026-05-07: "macOS Reminders CLI EventKit JSON" cross-referenced rem (Go), apple-reminders-cli, ekctl, remindctl — all current as of 2026

### Tertiary (LOW confidence)
- iCloud Reminders sync lag of 3-15s — accepted per CONTEXT.md but not measured live in this research; flag for measurement during Plan 02-02 implementation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every tool was probed live on this machine
- Architecture: HIGH — patterns lifted directly from Phase 1 working code
- Pitfalls: HIGH — pitfalls 1, 2, 4, 7, 8 were directly observed in code review or live probe; pitfalls 3, 5, 6 are conservative defaults from CONTEXT.md
- Reminders CLI selection: HIGH — `remindctl` verified installed and functional; CONTEXT.md alternatives confirmed missing
- JSONL field shape: HIGH — sampled real transcript head/tail
- Suggestion engine table: MEDIUM — heuristics are reasonable defaults but should be tuned with real-session data in Plan 02-04 (auto-pilot validates them with the largest exposure)

**Research date:** 2026-05-07
**Valid until:** 2026-06-07 for ecosystem-stable items; 2026-05-21 for `remindctl` version (active fast-moving CLI on `steipete/tap`)
