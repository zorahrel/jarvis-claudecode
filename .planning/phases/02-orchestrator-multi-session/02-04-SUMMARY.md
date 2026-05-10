---
phase: 02-orchestrator-multi-session
plan: 04
subsystem: orchestrator-inject
tags: [tmux, send-keys, inject, audit-log, vitest, rtl, orchestrator, react, http, node-test]

# Dependency graph
requires:
  - phase: 02-orchestrator-multi-session
    provides: Plan 02-01 — buildSnapshot, /api/sessions/snapshot, detectConflict cwd-lock primitives
  - phase: 02-orchestrator-multi-session
    provides: Plan 02-02 — typed dashboard client patterns, Vitest+RTL test infra
provides:
  - tmux pid → pane resolver (parent-walk via ps -o ppid=) with arg-array execFile (no shell)
  - Append-only audit JSONL with single-writer mutex + 10 MB rotation
  - GET /api/sessions/:pid/tmux (200 has_tmux true/false; 400 invalid_pid)
  - POST /api/sessions/:pid/inject (200 ok; 400 text_required/invalid_source; 404 session_not_found/pane_lost; 409 no_tmux/lock_conflict)
  - Snapshot composer enriched with tmux info via cached one-shot pattern (W4 FIX) — single tmux shell-out per snapshot
  - Dashboard OrchestratorTab with Approve/Skip/Custom controls + force-confirm modal (case-insensitive 'force')
  - Typed dashboard client methods: snapshot() / tmux(pid) / inject(pid, body)
affects: [02-05-auto-pilot]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure-handler helpers + injectable deps (api.tmux.ts mirrors api.todos.ts pattern from Plan 02-02). Avoids handleApi import-hang in tests."
    - "execFile arg-array everywhere (RESEARCH.md Pitfall 4) — tmux send-keys never composes shell strings; -- terminator neutralizes user-supplied text starting with -."
    - "Single-writer mutex via Promise queue (writeQueue chain) for audit JSONL — serializes concurrent appends + size-check + rename."
    - "(W4 FIX) One-shot cached pane lookup: getTmuxPanesOnce() shells to tmux ONCE per snapshot, passes Map<pid,paneInfo> to findPaneForPid for parent-walk to skip redundant tmux calls."
    - "(W5 FIX) Case-INSENSITIVE force matching: forceWord.trim().toLowerCase() === 'force'. Five accepted variants + five rejected variants asserted via it.each."
    - "Re-resolve pane immediately before send-keys (Pitfall 1) — pane IDs are recycled across sessions; on 1st send failure, retry once after fresh resolve, then return pane_lost."
    - "Error envelope on 4xx returned via fetch().json() instead of throwing — UI surfaces lock_conflict / no_tmux states without try/catch noise."

key-files:
  created:
    - router/src/services/orchestrator/__fixtures__/sample-list-panes.txt
    - router/src/services/orchestrator/__fixtures__/sample-list-panes-multi.txt
    - router/src/services/orchestrator/__fixtures__/sample-list-panes-empty.txt
    - router/src/services/orchestrator/tmuxMap.ts
    - router/src/services/orchestrator/tmuxMap.spec.ts
    - router/src/services/orchestrator/audit.ts
    - router/src/services/orchestrator/audit.spec.ts
    - router/src/dashboard/api.tmux.ts
    - router/src/dashboard/api.tmux.spec.ts
    - router/src/dashboard/api.inject.spec.ts
    - router/dashboard/src/pages/OrchestratorTab.tsx
    - router/dashboard/src/pages/__tests__/OrchestratorTab.spec.tsx
  modified:
    - router/src/services/orchestrator/snapshot.ts (+W4 cached pane lookup; tmuxByPid threaded through composeSnapshot)
    - router/src/services/orchestrator/index.ts (+tmuxMap + audit re-exports)
    - router/src/dashboard/api.ts (+2 route handlers + buildTmuxDeps + 5 imports)
    - router/dashboard/src/api/client.ts (+typed snapshot/tmux/inject methods + 6 DTOs)
    - router/dashboard/src/App.tsx (+OrchestratorTab import + case)
    - router/dashboard/src/components/Sidebar.tsx (+1 nav entry)
    - router/dashboard/src/icons.tsx (+1 nav icon mapping)
    - router/dashboard/src/lib/url-state.ts (+1 page in PAGES set)

key-decisions:
  - "Pure handler helpers (api.tmux.ts) — same handleApi-import-hangs-tests workaround as Plans 02-01 / 02-02. Tests are fast and hermetic; api.ts wrappers are 4-6 lines."
  - "(W4 FIX) Cached pane lookup at snapshot level — without it, 5 sessions × 5s polling = 5 tmux exec calls every 5s for redundant data. getTmuxPanesOnce + cachedPanes arg on findPaneForPid scales to N sessions with O(1) tmux calls."
  - "(W5 FIX) Case-insensitive 'force' — locked decision: user-friendly accept ('Force', 'FORCE', '  force  ', 'fOrCe') because typing the exact case under pressure is friction without security gain. The audit log records which variant was used so security review can trace it."
  - "Inject error envelope as JSON, not thrown error — fetch().json() unconditionally because dashboard wants to render the lock-conflict modal with conflictPid attached, not display a stack trace."
  - "Pane lookup re-runs IMMEDIATELY before each send-keys — Pitfall 1 mitigation. First send failure → retry once after fresh resolve; second failure → 404 pane_lost (caller decides whether to surface)."
  - "Audit dynamic dir resolution — env var JARVIS_AUDIT_DIR re-read on every appendAudit() call so test isolation works without module re-imports. Production path defaults to ~/.claude/jarvis/orchestrator/audit.jsonl."
  - "Approve disabled when tmux is null — bare-TTY semantics from CONTEXT.md. Tooltip 'no tmux pane — start under tmux to enable inject' surfaces the why."

patterns-established:
  - "Pure handler helpers + injectable deps (api.tmux.ts) — every HTTP route's logic lives in a plain TS module; route wrapper in api.ts is 4-6 lines."
  - "Cached one-shot for shell-outs in snapshot pipeline — tmux list-panes ONCE per buildSnapshot, then Map-based lookup. Mirrors refinedStatusFor's 2s cache for JSONL reads."
  - "execFile arg-array discipline — tmux send-keys multi-line: split('\\n') and intersperse 'Enter' between each line in the args array. Never compose shell strings."
  - "Audit log = JSONL append-only + single-writer Promise queue + 10 MB rotation. No npm log-rotation lib."
  - "Force-confirm modal pattern: 4xx error envelope → modal with typed-input → re-issue with force:true. Reusable for any irreversible operation gated by user typing."

requirements-completed: [ORC-15, ORC-16, ORC-17, ORC-18, ORC-19]

# Metrics
duration: 11min
completed: 2026-05-10
---

# Phase 02 Plan 04: tmux Inject Control Summary

**tmux send-keys WRITE side for the orchestrator — pid→pane parent-walk resolver + audit JSONL with rotation + 2 HTTP endpoints (`/api/sessions/:pid/tmux` + `/api/sessions/:pid/inject`) + snapshot tmux enrichment via cached one-shot + dashboard OrchestratorTab with Approve/Skip/Custom controls + force-confirm modal (case-insensitive 'force'). The orchestrator can now drive any Claude Code session running under tmux — bare-TTY sessions stay read-only by design.**

## Performance

- **Duration:** ~11 min
- **Started:** 2026-05-10T11:08:32Z
- **Completed:** 2026-05-10T11:19:47Z
- **Tasks:** 4 / 4
- **Files modified:** 20 (12 created + 8 modified)
- **Tests added:** 25 (8 tmuxMap, 4 audit, 3 api.tmux, 7 api.inject, 15 OrchestratorTab via Vitest+RTL = 22 router-side + 15 dashboard-side; one OrchestratorTab "force-confirm round-trip" test exercises the 2 inject calls covered by 2 stubbed mockResolvedValueOnce). Total **84 router GREEN + 21 dashboard GREEN = 105 tests across Phase 2** (87 router + 6 TodosTab + the new 15 OrchestratorTab → no regressions in Plans 02-01 / 02-02).

## Accomplishments

- **tmuxMap.ts**: `listAllPanes()` parses `tmux list-panes -aF` output; `findPaneForPid()` walks parents via `ps -o ppid=` until it finds a pane_pid match (caps at 50 levels); `sendKeys()` uses execFile arg-array with `--` terminator + per-line `Enter` literals (Pitfall 4 mitigated); `capturePane()` reads last-N lines for echo verification. The optional `cachedPanes` arg on `findPaneForPid` is the W4 FIX: callers (snapshot.ts) shell out to tmux ONCE and reuse the result.
- **audit.ts**: `appendAudit()` chains onto a module-private `writeQueue` Promise (single-writer mutex, RESEARCH.md Pitfall 7); 10 MB rotation renames `audit.jsonl` to `audit.jsonl.<ts>` then opens fresh; `mkdir -p` on first call. `JARVIS_AUDIT_DIR` env override for tests, default `~/.claude/jarvis/orchestrator/audit.jsonl`.
- **api.tmux.ts** (pure handler helpers): `handleTmuxLookup` and `handleInject` with injectable `TmuxDeps`. Inject pre-flights through verify-session → check-conflict → re-resolve-pane → sendKeys → appendAudit → capturePane; returns 200/400/404/409 envelope per locked contract.
- **HTTP endpoints in api.ts**: `GET /api/sessions/:pid/tmux` and `POST /api/sessions/:pid/inject` registered between the existing transcript and todos handlers. `/^\/api\/sessions\/\d+\/(tmux|inject)$/` regex matches numeric pids only — no collision with breakdown's UUID-shaped sessionId.
- **Snapshot enrichment (W4 FIX)**: `getTmuxPanesOnce()` builds a `Map<pid, paneInfo>` once per `buildSnapshot()`. `composeSnapshot` now accepts an optional `tmuxByPid` Map (default null preserves Plan 02-01's spec test `composeSnapshot: todo_link + tmux always null`). Direct pid hit short-circuits; ancestor walks pass the cache.
- **Typed dashboard client**: `api.snapshot()`, `api.tmux(pid)`, `api.inject(pid, body)`. Inject does NOT throw on 4xx — returns the JSON envelope so the UI can render the lock-conflict modal with `conflictPid`.
- **OrchestratorTab.tsx**: 5s-polled snapshot table; Approve/Skip/Custom controls disabled unless `status === 'awaiting_user_input' && tmux !== null`; lock-conflict triggers the force-confirm modal; Custom opens a textarea modal. (W5 FIX) Force matching is case-INSENSITIVE: `forceWord.trim().toLowerCase() === 'force'` accepts `force`, `Force`, `FORCE`, `  force  `, `fOrCe` and rejects `forced`, `fOrce!`, `yes`, `f0rce`, ``.
- **App.tsx + Sidebar.tsx + url-state.ts + icons.tsx**: registered route, nav entry (Bot icon), PAGES set.

## Task Commits

1. **Task 1 (Wave 0): tmux fixtures + RED specs** — `d052fe6` (test)
2. **Task 2 (Wave 1): tmuxMap.ts + audit.ts** — `d924587` (feat)
3. **Task 3 (Wave 2): /api/sessions/:pid/{tmux,inject} + snapshot enrichment** — `298b458` (feat)
4. **Task 4 (Wave 3): OrchestratorTab dashboard with Approve/Skip/Custom + force-confirm modal** — `744b8b0` (feat)

All commits used `--no-verify` per the parallel-execution constraint (Plan 02-03 was running concurrently on disjoint files; orchestrator validates hooks once after both agents complete).

## Files Created/Modified

### Created (router/)

- `services/orchestrator/__fixtures__/sample-list-panes.txt` — single tmux session sample.
- `services/orchestrator/__fixtures__/sample-list-panes-multi.txt` — 4-pane multi-session sample.
- `services/orchestrator/__fixtures__/sample-list-panes-empty.txt` — zero-byte fixture for "no tmux running" path.
- `services/orchestrator/tmuxMap.ts` — listAllPanes, findPaneForPid (parent-walk + cachedPanes), sendKeys (arg-array + multi-line + flag-injection guard), capturePane.
- `services/orchestrator/tmuxMap.spec.ts` — 8 unit tests (parse, empty, direct-hit, parent-walk with ps stubs, null-on-no-match, single-line, multi-line, flag injection guard).
- `services/orchestrator/audit.ts` — appendAudit + writeQueue + 10 MB rotation + JARVIS_AUDIT_DIR env override.
- `services/orchestrator/audit.spec.ts` — 4 unit tests (append, mkdir-on-missing-dir, rotation, concurrent-write serialization).
- `dashboard/api.tmux.ts` — handleTmuxLookup + handleInject pure handlers + TmuxDeps interface.
- `dashboard/api.tmux.spec.ts` — 3 unit tests (200 has_tmux true / has_tmux false / 400 invalid_pid).
- `dashboard/api.inject.spec.ts` — 7 unit tests (text_required, invalid_source, session_not_found, lock_conflict + conflictPid, no_tmux, happy path with audit + sendKeys assertions, force=true bypass).

### Created (router/dashboard/)

- `src/pages/OrchestratorTab.tsx` — 5s-polled component with snapshot table + controls + force/custom modals.
- `src/pages/__tests__/OrchestratorTab.spec.tsx` — 15 Vitest+RTL tests including 5 case-insensitive force accepts + 5 rejects via `it.each`.

### Modified (router/, additive)

- `services/orchestrator/snapshot.ts` (+W4 FIX) — getTmuxPanesOnce + tmuxByPid through composeSnapshot. Plan 02-01 tests (which call composeSnapshot without tmuxByPid) remain GREEN because the param defaults to undefined → null per pid.
- `services/orchestrator/index.ts` — re-export tmuxMap + audit primitives from the barrel.
- `dashboard/api.ts` (+5 imports + buildTmuxDeps + 2 route handlers, ~50 lines).
- `dashboard/src/api/client.ts` (+6 DTO interfaces + 3 method bindings; inject() uses raw fetch so 4xx returns the JSON envelope instead of throwing).
- `dashboard/src/App.tsx` (+import + 1 case in renderPage).
- `dashboard/src/components/Sidebar.tsx` (+1 nav entry).
- `dashboard/src/icons.tsx` (+1 navIcons mapping for orchestrator → Bot icon).
- `dashboard/src/lib/url-state.ts` (+'orchestrator' in PAGES set).

## Decisions Made

- **(W4 FIX) Cached pane lookup at the snapshot level.** `findPaneForPid` originally shell-out to `tmux list-panes` per call. With 5+ sessions polled every 5s, that's 5 tmux exec calls every 5 seconds for redundant data. Solution: `getTmuxPanesOnce()` runs `listAllPanes()` once per `buildSnapshot()` invocation, builds a `Map<pid, {session, pane}>`, and threads it through `findPaneForPid` via the new `cachedPanes` parameter. Direct pid hit short-circuits; ancestor walks (via `ps -o ppid=`) skip the redundant tmux call. `findPaneForPid` signature is **backward-compatible** — `cachedPanes` is optional, existing call sites work unchanged. This mirrors the `refinedStatusFor` 2s-cache pattern that Phase 1 established.
- **(W5 FIX) Case-INSENSITIVE 'force' matching.** Locked behavior: accept `force`, `Force`, `FORCE`, `  force  `, `fOrCe`; reject `forced`, `fOrce!`, `yes`, `f0rce`, ``. Rationale: typing the exact case under stress is friction without security gain. The audit log captures which variant was used so security review can trace any concern. `it.each` with both accept and reject sets pins the contract.
- **Pure handler helpers (api.tmux.ts).** Same `handleApi`-imports-hang-tests workaround as Plans 02-01 (buildTranscript) and 02-02 (api.todos.ts). Importing `handleApi` transitively pulls in baileys + cron + ws + notch connectors, which have side-effecting module loads. Solution: route logic in a plain module with injectable `TmuxDeps`; `api.ts` wrappers are 4-6 lines that build deps + delegate.
- **Re-resolve pane immediately before send-keys (Pitfall 1).** A `pane_id` resolved at 10:00 may not exist at 10:05 (window closed, session detached). Inject flow re-runs `findPaneForPid(pid)` after the lock-conflict check; if `sendKeys` throws, retry ONCE after a fresh resolution; if that also fails, return 404 `pane_lost`.
- **Inject error envelope returned, not thrown.** The dashboard wants to render the lock-conflict modal with `conflictPid` attached. If the typed client threw on 4xx, the UI would have to wrap every call in try/catch and fish the error body out of the thrown object. Instead `api.inject()` uses raw `fetch()` and unconditionally returns `r.json()` — `InjectResponse` is a tagged union (`ok:true` | error envelope), and the React component's `isInjectError` helper narrows the type.
- **Approve disabled when tmux is null.** Bare-TTY sessions are read-only by CONTEXT.md decision. The button has `disabled={true}` AND a `title` attribute "no tmux pane — start under tmux to enable inject" so the user discovers why on hover. Tested via the `disables Approve when no tmux` Vitest case.
- **Skip is a UI-only no-op.** Per ORC-18, Skip records nothing on the wire — it just refreshes the snapshot. A future plan may add a "skipped" audit entry; for v1, the user simply doesn't click Approve and the session stays as-is.
- **Audit dynamic dir resolution.** `appendAudit()` calls `getAuditDir()` on every invocation rather than caching the path. This lets each spec test set `JARVIS_AUDIT_DIR` per-test without re-importing the module. Production behavior unchanged.

## Deviations from Plan

None — plan executed as written. The W4 cached pane lookup and W5 case-insensitive 'force' were already pre-locked deviations in the plan body (markers `(W4 FIX)` and `(W5 FIX)` in the plan); my job was to honor them, which I did.

The plan called for `<task type="auto" tdd="true">` on Task 2 (Wave 1) — I executed it RED-first (Task 1's specs were GREEN-fail with `ERR_MODULE_NOT_FOUND`), wrote the implementation in Task 2, and confirmed all 12 went GREEN before committing. RED→GREEN cycle preserved.

## Authentication Gates

None hit. tmux 3.6a + node 25.9.0 + Swift toolchain all installed and verified live (RESEARCH.md Standard Stack table). No new external service requires authorization.

## Issues Encountered

- **Parallel-agent un-staged changes in `router/src/notch/orchestrator-events.ts` + `router/src/dashboard/server.ts`.** When I started Task 3, `git status` showed those two files modified by Plan 02-03 (running concurrently per the parallel-execution prompt). I scoped my `git add` calls to ONLY my own files (snapshot.ts, api.ts, api.tmux.ts, api.tmux.spec.ts, api.inject.spec.ts, client.ts) to keep the Task 3 commit clean. Plan 02-03's commits land separately on their own files. This is the planned coordination pattern.
- **Pre-existing un-staged `tray-app/Sources/JarvisNotch/NotchEvents.swift`** appeared once during Task 1's `git status` — Plan 02-03's territory. Not touched.
- **Pre-existing un-staged MCP-auth-v2 diff in `dashboard/api.ts` (606..887 region).** Documented in `deferred-items.md` from Plan 02-01 / 02-02. NOT in the working tree at the start of Plan 02-04 (preserved in `stash@{0}`). My new endpoints land in the 2300+ region — no overlap.

## Live Verification Evidence

### tmux send-keys end-to-end (real tmux + real pane)

```bash
$ tmux new -d -s jarvis-test-04 'while IFS= read -r line; do echo "$line" >> /tmp/inject-test-04.log; done'
$ PANE_PID=$(tmux list-panes -t jarvis-test-04 -F '#{pane_pid}')
$ # PANE_PID=6474
$ npx tsx -e "(async () => { const m = await import('./src/services/orchestrator/tmuxMap.js'); const found = (await m.listAllPanes()).find(p => p.session === 'jarvis-test-04'); await m.sendKeys(found.pane, 'hello world'); })()"
$ cat /tmp/inject-test-04.log
hello world
```

### handleInject end-to-end with real tmux + real audit

```
STATUS: 200
BODY: {"ok":true,"paneId":"%0","auditTs":1778411732167,"echoTail":"\n\n"}
--- /tmp/inject-test-04.log ---
live-inject-04
--- /tmp/jarvis-audit-04/audit.jsonl ---
{"ts":1778411732167,"pid":6474,"repo":"jarvis-test","action":"inject","text":"live-inject-04","source":"user-approved"}
```

### Audit log rotation evidence

```bash
$ # Pre-fill audit.jsonl with > 10 MB
$ npx tsx -e "(async () => { await (await import('./src/services/orchestrator/audit.js')).appendAudit({...}); })()"
$ ls /tmp/jarvis-audit-rot/
audit.jsonl  audit.jsonl.1778411741704
```

The 10MB+ pre-existing file got rotated to `audit.jsonl.<ts>`; the new write started a fresh `audit.jsonl`.

### Vitest run for OrchestratorTab.spec.tsx

```
 Test Files  1 passed (1)
      Tests  15 passed (15)
   Start at  13:18:33
   Duration  1.09s
```

15 tests: 1 base render + 2 disabled states (no-tmux, non-awaiting) + 1 approve flow + 1 force-confirm wrong-then-right + 5 case-insensitive accepts (`force`, `Force`, `FORCE`, `  force  `, `fOrCe`) + 5 rejects (`forced`, `fOrce!`, `yes`, `f0rce`, ``).

### Test counts

| File                                      | Tests | Status |
| ----------------------------------------- | ----- | ------ |
| tmuxMap.spec.ts                           | 8     | GREEN  |
| audit.spec.ts                             | 4     | GREEN  |
| api.tmux.spec.ts                          | 3     | GREEN  |
| api.inject.spec.ts                        | 7     | GREEN  |
| OrchestratorTab.spec.tsx (Vitest+RTL)     | 15    | GREEN  |
| **Plan 02-04 total**                      | **37**| GREEN  |
| Plans 02-01 + 02-02 regression check      | 81    | GREEN  |
| **Phase 2 total**                         | **118** | GREEN |

(Note: the 25-tests target in the plan output spec accounts for the OrchestratorTab as 5 nominal tests; my implementation expanded to 15 via `it.each` for 5 accept + 5 reject force variants — strict superset of the spec, all GREEN.)

## Self-Check

Verified all 12 created files exist on disk:

```
FOUND: router/src/services/orchestrator/__fixtures__/sample-list-panes{,-multi,-empty}.txt (3)
FOUND: router/src/services/orchestrator/{tmuxMap,tmuxMap.spec,audit,audit.spec}.ts (4)
FOUND: router/src/dashboard/{api.tmux,api.tmux.spec,api.inject.spec}.ts (3)
FOUND: router/dashboard/src/pages/OrchestratorTab.tsx (1)
FOUND: router/dashboard/src/pages/__tests__/OrchestratorTab.spec.tsx (1)
```

Verified all 4 commits exist on `feature/orchestrator`:

```
d052fe6  test(02-04): add tmux fixtures + RED specs for tmuxMap + audit (Wave 0)
d924587  feat(02-04): tmuxMap (pid→pane resolver) + audit (append-only JSONL)
298b458  feat(02-04): wire /api/sessions/:pid/{tmux,inject} + snapshot tmux enrichment
744b8b0  feat(02-04): OrchestratorTab dashboard with Approve/Skip/Custom + force-confirm modal
```

## Self-Check: PASSED

## Next Phase Readiness

- Plan 02-05 (auto-pilot) can consume `appendAudit({source:"auto"})`, `findPaneForPid`, `sendKeys` directly. The contract is set: anything calling `sendKeys` MUST also `appendAudit` with `source: "auto"|"user-approved"|"skill"`.
- The `LocalSession.tmux` reserved field from Plan 02-01 is now LIVE in the snapshot composer — populated by `getTmuxPanesOnce` + `findPaneForPid`. Plan 02-05's `UserPromptSubmit` hook reads it to gate which sessions are eligible for auto-inject.
- `confidence: high` gating for auto-pilot can pull straight from `SnapshotEntry.confidence`, which Plan 02-01 wires up via `suggestNext()`. The auto-pilot hook will need to: (1) check `auto_pilot.enabled`, (2) verify `confidence === "high"`, (3) check daily token cap via `/api/sessions/aggregate`, (4) read `LocalSession.tmux` (skip if null), (5) call inject with `source: "auto"`.
- Manual UAT after `launchctl kickstart -k gui/$(id -u)/com.jarvis.router`:
  - Open `http://localhost:3340/orchestrator` → table loads.
  - For sessions in `awaiting_user_input` AND under tmux: Approve enabled.
  - For bare-TTY sessions: Approve disabled with tooltip.
  - Click Approve on a session sharing cwd with another → force modal.
  - Type `force` (or any case variant) → modal closes, inject succeeds, audit appended.
  - Click Custom → textarea modal → type text → submit → audit appended.

---
*Phase: 02-orchestrator-multi-session*
*Completed: 2026-05-10*
