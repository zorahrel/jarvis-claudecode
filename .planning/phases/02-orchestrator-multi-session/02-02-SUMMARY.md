---
phase: 02-orchestrator-multi-session
plan: 02
subsystem: reminders
tags: [reminders, remindctl, eventkit, polling, http, orchestrator-events, vitest, rtl, react]

# Dependency graph
requires:
  - phase: 02-orchestrator-multi-session
    provides: Plan 02-01 — buildSnapshot, /api/sessions/snapshot, /api/sessions/:pid/transcript, refinedStatus, suggestion engine
provides:
  - Apple Reminders bridge (primary remindctl, fallbacks apple-reminders-cli + ekctl, local-file degradation)
  - Bidirectional pid/repo/phase metadata parser/formatter (round-trip preserved)
  - 3s polling loop emitting todo:added/completed/updated diff events on a NEW namespaced orchestrator-events bus (NOT polluting notch/events.ts)
  - GET /api/todos (max 100 open, sorted by due-date, graceful auth/listMissing banners) + POST /api/todos + POST /api/todos/:uuid/complete + PATCH /api/todos/:uuid (long-press reassign hook for ORC-13)
  - Dashboard Todos tab with 5s polling (matches Context Inspector CTX-13), three banner states, click-to-complete and add-via-input
  - Vitest + React Testing Library + jsdom test infrastructure for the dashboard package (was previously absent)
affects: [02-03-notch-hud, 02-04-tmux-inject, 02-05-auto-pilot]

# Tech tracking
tech-stack:
  added:
    - "vitest 4.1.5 (dashboard test runner)"
    - "@testing-library/react 16.3.2 (RTL)"
    - "@testing-library/jest-dom 6.9.1 (DOM matchers)"
    - "@testing-library/dom 10.4.1"
    - "jsdom 29.1.1 (DOM env for vitest)"
  patterns:
    - "Pure HTTP-handler helpers + injectable deps + thin route wrappers (mirrors Plan 02-01's buildTranscript / buildSnapshot pattern). Avoids handleApi import hang in tests."
    - "remindctl JSON shape adapter (normalizeRemindCtl) shields downstream code from CLI version drift — single place to update when shapes change."
    - "Selective fake timers in Vitest: vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) keeps RTL's waitFor functional while still allowing setInterval-cadence tests."
    - "Graceful banner-driven degradation for /api/todos: never 500 on unauthorized OR list-missing — return 200 with structured payload, dashboard renders banners."

key-files:
  created:
    - router/src/services/reminders/types.ts
    - router/src/services/reminders/cli.ts
    - router/src/services/reminders/cli.spec.ts
    - router/src/services/reminders/metadata.ts
    - router/src/services/reminders/metadata.spec.ts
    - router/src/services/reminders/poll.ts
    - router/src/services/reminders/poll.spec.ts
    - router/src/services/reminders/index.ts
    - router/src/services/reminders/__fixtures__/sample-list.json
    - router/src/services/reminders/__fixtures__/sample-show-active.json
    - router/src/services/reminders/__fixtures__/sample-add-response.json
    - router/src/services/reminders/__fixtures__/sample-empty.json
    - router/src/notch/orchestrator-events.ts
    - router/src/notch/orchestrator-events.spec.ts
    - router/src/dashboard/api.todos.ts
    - router/src/dashboard/api.todos.spec.ts
    - router/dashboard/src/pages/TodosTab.tsx
    - router/dashboard/src/pages/__tests__/TodosTab.spec.tsx
    - router/dashboard/src/test/setup.ts
    - router/dashboard/vitest.config.ts
  modified:
    - router/src/dashboard/api.ts (+72 lines — 4 new route handlers + buildTodosDeps + imports)
    - router/src/dashboard/server.ts (+40 lines — startReminderPolling boot wiring)
    - router/dashboard/src/api/client.ts (+45 lines — typed methods + DTO interfaces)
    - router/dashboard/src/App.tsx (+2 lines — TodosTab import + case)
    - router/dashboard/src/components/Sidebar.tsx (+1 line — nav entry)
    - router/dashboard/src/icons.tsx (+2 lines — CheckSquare nav icon)
    - router/dashboard/src/lib/url-state.ts (+1 word — "todos" page)
    - router/dashboard/package.json (+1 script + 5 devDeps)
    - .planning/phases/02-orchestrator-multi-session/deferred-items.md (MCP-auth-v2 status update)

key-decisions:
  - "Pure handler helpers (api.todos.ts) + injectable TodosDeps — same pattern as Plan 02-01's buildTranscript. Tests exercise full route logic without the handleApi import hang."
  - "normalizeRemindCtl(): live remindctl 0.1.1 emits {listName, isCompleted, priority:string} not the documented {list, completed, priority:number}. Adapter keeps the internal ReminderTodo contract stable across CLI version drift."
  - "Graceful banner states for /api/todos: unauthorized → 200 {unauthorized:true}; list-missing → 200 {listMissing:true, message}. Polling loop swallows list-missing silently to avoid 3s WARN spam."
  - "Polling boot in server.ts (NOT api.ts). api.ts is the route handler module; server.ts owns lifecycle. JARVIS_NO_POLL=1 escape hatch for tests."
  - "Selective Vitest fake timers (toFake: ['setInterval','clearInterval']) — fake all-timers wedges RTL's waitFor; this lets us advance the 5s cadence without breaking async assertions."
  - "Vitest+RTL added to dashboard package (was absent). Plan constraint #9 mandated it; install was a one-time infrastructure add covering this and future React component specs."

patterns-established:
  - "Pure handler helpers + injectable deps: every HTTP route's logic lives in a plain TypeScript module (api.todos.ts) testable in isolation. The route wrapper in api.ts is 4-6 lines."
  - "CLI shape adapter: every CLI integration normalizes through one function (normalizeRemindCtl) so swap-in of fallback CLIs only updates that adapter."
  - "Namespaced event bus per concern: notch/events.ts (TTS/voice/state-machine) vs notch/orchestrator-events.ts (sessions:update + todos:update). Mixing them was an explicit anti-pattern in RESEARCH.md."
  - "Banner-driven graceful degradation: API endpoints that can fail for environment reasons (auth, missing resource) return 200 with a structured banner payload; never 500. Dashboard renders banner per state."

requirements-completed: [ORC-06, ORC-07, ORC-08, ORC-09, ORC-10]

# Metrics
duration: 23min
completed: 2026-05-10
---

# Phase 02 Plan 02: Reminders Bridge Summary

**Apple Reminders bridge over `remindctl` (primary) with apple-reminders-cli + ekctl + local-file fallbacks; 3s diff-emitting polling loop on a NEW namespaced orchestrator-events bus; 4 HTTP endpoints with graceful auth + listMissing banners; TodosTab dashboard page (Vitest + RTL infrastructure added) auto-refreshing every 5s — turns Apple Reminders into the orchestrator's intent layer end-to-end.**

## Performance

- **Duration:** 23 min
- **Started:** 2026-05-10T10:35:51Z
- **Completed:** 2026-05-10T10:59:09Z
- **Tasks:** 4 / 4
- **Files modified:** 30 (20 created + 10 modified)
- **Tests added:** 33 (5 metadata, 7 cli including normalizer, 4 poll, 3 orchestrator-events, 9 api.todos including PATCH, 6 TodosTab Vitest+RTL). All GREEN. Plan 02-01 specs (29) still GREEN. Typecheck GREEN. Dashboard build GREEN.

## Accomplishments

- Reminders bridge primitives shipped: `listTodos`, `addTodo`, `completeTodo`, `probeAuth`, `getActiveCli` — dependency-injected execFile wrapper, version-drift-resilient via `normalizeRemindCtl`.
- Bidirectional `parseTodoMetadata` / `formatTodoMetadata` lock the `pid:N repo:R phase:P` body schema; round-trip preserved (5 spec cases).
- `diffTodos` produces a stable event sequence (`todo:added`, `todo:completed`, `todo:updated`); deletions intentionally ignored per ORC-07. `startReminderPolling` runs on dashboard boot, emits via the new namespaced bus.
- `notch/orchestrator-events.ts` ships as a separate module from `notch/events.ts` — RESEARCH.md anti-pattern explicitly avoided. 3 spec cases verify the emit/subscribe/error-isolation contract.
- 4 HTTP endpoints live: `GET /api/todos` (max 100 open, sorted, banner-aware), `POST /api/todos`, `POST /api/todos/:uuid/complete`, `PATCH /api/todos/:uuid` (B2 fix — moved here from Plan 02-03 for cohesion). Pure handler helpers in `api.todos.ts` + thin route wrappers in `api.ts` keep tests fast and decoupled from `handleApi` (which transitively imports baileys + cron + ws).
- `TodosTab.tsx` ships in the dashboard with three banner states, 5s polling, add-via-input, click-to-complete. Wired into `App.tsx` + `Sidebar` + `url-state.ts` + `icons.tsx`.
- Vitest + React Testing Library + jsdom installed and configured for the dashboard package. `vitest.config.ts` and `src/test/setup.ts` bootstrap the environment. 6 RTL tests cover render, auto-refresh cadence, both banner states, complete action, add action.
- Live integration verified end-to-end:
  - Before list creation: `curl /api/todos` returns 200 with `listMissing:true` banner; polling logs nothing.
  - After `remindctl list "Jarvis/ActiveTasks" --create` (one-time bootstrap): full round-trip `POST → list → complete → empty` works through the HTTP surface, all values normalized to the documented `ReminderTodo` shape.

## Task Commits

1. **Task 1 (Wave 0): Capture remindctl fixtures + types.ts + RED specs** — `2d54573` (test)
2. **Task 2 (Wave 1): cli.ts + metadata.ts + poll.ts + orchestrator-events.ts** — `478feca` (feat)
3. **Task 3 (Wave 2): /api/todos endpoints + typed client + polling boot** — `322b964` (feat)
4. **Task 4 (Wave 3): TodosTab + App.tsx + Vitest+RTL infrastructure** — `0210bc6` (feat)

## Files Created/Modified

### Created (router/src/)

- `services/reminders/types.ts` — `ReminderTodo`, `RemindersCli`, `CliProbe`, `TodoEvent`, `TodoMetadata`, `TodoPhase`.
- `services/reminders/metadata.ts` — `parseTodoMetadata` + `formatTodoMetadata` (regex-based, round-trip).
- `services/reminders/cli.ts` — `listTodos` / `addTodo` / `completeTodo` / `probeAuth` / `getActiveCli` + `normalizeRemindCtl` adapter for live CLI shape drift.
- `services/reminders/poll.ts` — `diffTodos` (pure) + `startReminderPolling` / `stopReminderPolling` (3s interval, list-missing-silent).
- `services/reminders/index.ts` — public barrel.
- `services/reminders/{metadata,cli,poll}.spec.ts` — 16 unit tests.
- `services/reminders/__fixtures__/sample-{list,show-active,add-response,empty}.json` — captured live remindctl JSON shapes.
- `notch/orchestrator-events.ts` — namespaced event bus separate from `notch/events.ts`.
- `notch/orchestrator-events.spec.ts` — 3 contract tests.
- `dashboard/api.todos.ts` — pure handler helpers (`handleListTodos`, `handleAddTodo`, `handleCompleteTodo`, `handlePatchTodo`) + injectable `TodosDeps`.
- `dashboard/api.todos.spec.ts` — 9 contract tests covering all four routes including PATCH edge cases.

### Created (router/dashboard/)

- `src/pages/TodosTab.tsx` — 5s-polled React component with three banner states.
- `src/pages/__tests__/TodosTab.spec.tsx` — 6 Vitest+RTL tests.
- `src/test/setup.ts` — `@testing-library/jest-dom/vitest` matchers bootstrap.
- `vitest.config.ts` — separate from `vite.config.ts` so build pipeline isn't slowed by jsdom.

### Modified (router/, additive only)

- `src/dashboard/api.ts` (+72 lines) — 4 route handlers, `buildTodosDeps`, imports. NO changes to existing routes.
- `src/dashboard/server.ts` (+40 lines) — `startReminderPolling` boot wiring guarded by `JARVIS_NO_POLL`.
- `dashboard/src/api/client.ts` (+45 lines) — `api.todos / addTodo / completeTodo / patchTodo` + `ReminderTodoDTO`, `AddTodoInput`, `TodosResponse`.
- `dashboard/src/App.tsx` (+2 lines) — `TodosTab` import + `case 'todos'`.
- `dashboard/src/components/Sidebar.tsx` (+1 line) — nav entry.
- `dashboard/src/icons.tsx` (+2 lines) — `CheckSquare` icon for todos.
- `dashboard/src/lib/url-state.ts` (+1 word) — "todos" added to PAGES set.
- `dashboard/package.json` — `test` script + 5 devDeps.

## Decisions Made

- **Pure handler helpers (`api.todos.ts`).** The same blocker Plan 02-01 hit (importing `handleApi` in tests transitively pulls in baileys + cron + ws and hangs the runner) applies here. Solution mirrored: extract route logic into a plain module with injectable `TodosDeps`. Tests are fast, hermetic, and full-coverage; the `api.ts` route wrapper is 4-6 lines.
- **`normalizeRemindCtl` adapter.** Discovered live: remindctl 0.1.1 emits `{listName, isCompleted, priority:string}` instead of the documented `{list, completed, priority:number}`. Adding a one-place normalizer means: (a) Wave 0 fixtures could be regenerated to match live CLI output without re-rewriting types; (b) future CLI version bumps are a one-line update; (c) downstream consumers (dashboard, polling, snapshot enricher) get a single stable contract.
- **Banner-driven graceful degradation.** Two failure modes are environmental, not code bugs: Reminders not authorized, and Jarvis/ActiveTasks list missing on first run. Both now return 200 with structured payloads (`unauthorized:true` or `listMissing:true, message:"..."`) instead of 500. The dashboard renders specific banners per state. The polling loop also swallows list-missing silently — otherwise a 3s WARN spam would fill the router log.
- **Polling boot in `server.ts`, not `api.ts`.** `api.ts` is the route handler module; lifecycle (server creation, polling, shutdown) belongs in `server.ts`. Guarded by `JARVIS_NO_POLL=1` so any future test that imports `server.ts` transitively doesn't kick off a real interval.
- **Selective Vitest fake timers.** `vi.useFakeTimers()` (full fake) wedges RTL's `waitFor` (which uses `setTimeout`/`queueMicrotask` internally). Solution: `vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })` in the auto-refresh test only. Real timers everywhere else.
- **Vitest+RTL infrastructure as part of this plan.** Plan constraint #9 mandated Vitest+RTL for React, but the dashboard package didn't have it yet. Added as a one-time devDeps install + 2 small config files (`vitest.config.ts`, `src/test/setup.ts`). Future React specs land for free.
- **PATCH /api/todos/:uuid landed here, not Plan 02-03.** B2 fix in the plan moved this from Plan 02-03 (where it conceptually belongs to the notch long-press flow) to here so the four todo handlers stay together for cohesion. Plan 02-03 will consume the existing endpoint.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug + Rule 2 — Missing Critical] Live remindctl 0.1.1 JSON shape differs from documented contract**

- **Found during:** Task 3 (live integration smoke test).
- **Issue:** `remindctl show` emits `{listName, isCompleted, priority:"none"|"low"|"medium"|"high", listID, completionDate}` but `ReminderTodo` (per CONTEXT.md and the original fixtures) was typed as `{list, completed, priority:number}`. Without normalization the dashboard would render undefined for completion + list, and the polling diff would never see a `completed` transition.
- **Fix:** Added `normalizeRemindCtl(raw)` in `cli.ts` mapping `listName→list`, `isCompleted→completed`, and `"none"→0 / "low"→1 / "medium"→5 / "high"→9`. Used in both `listTodos` and `addTodo`. Updated `__fixtures__/sample-show-active.json` and `__fixtures__/sample-add-response.json` to match captured live shape so the spec actually exercises the normalizer. Added a dedicated test verifying the priority mapping for all 4 string values.
- **Files modified:** `router/src/services/reminders/cli.ts`, `cli.spec.ts`, `__fixtures__/sample-show-active.json`, `__fixtures__/sample-add-response.json`.
- **Verification:** Live `curl POST /api/todos` returns the normalized shape (`list:"Jarvis/ActiveTasks"`, `completed:false`, `priority:0`); `cli.spec.ts` 7 tests GREEN.
- **Committed in:** `322b964` (Task 3 commit).

**2. [Rule 1 — Bug + Rule 2 — Missing Critical] First-run "List not found" caused HTTP 500 + 3s WARN log spam**

- **Found during:** Task 3 (live restart smoke test — the `Jarvis/ActiveTasks` list does not exist on the user's Mac before first-run bootstrap; Plan constraint #2 flagged this).
- **Issue:** `remindctl show all --list "Jarvis/ActiveTasks" --json` rejects with `List not found: "Jarvis/ActiveTasks"` when the list hasn't been created. The original `handleListTodos` translated this to HTTP 500, which (a) breaks acceptance criterion `curl returns 200`, and (b) the polling loop's `WARN [reminders] polling tick failed` spammed the router log every 3s.
- **Fix:** Two-part. (a) `handleListTodos` now catches `/list not found/i` and returns 200 with `{todos:[], unauthorized:false, listMissing:true, message:"Reminders list 'Jarvis/ActiveTasks' not found. Create it on your iPhone or Mac Reminders app to enable Jarvis todos."}` so the dashboard renders an actionable banner. (b) `poll.ts` `tick()` swallows the same error class silently (no `onError` callback for that one path) — log isn't spammed. Added a dedicated spec test asserting the listMissing graceful path.
- **Files modified:** `router/src/dashboard/api.todos.ts`, `api.todos.spec.ts`, `router/src/services/reminders/poll.ts`.
- **Verification:** Live `curl localhost:3340/api/todos` returns 200 with the listMissing banner; router log shows `[reminders] polling started` once and stays clean. Once `remindctl list "Jarvis/ActiveTasks" --create` is run (one-time bootstrap), the round-trip works (verified live).
- **Committed in:** `322b964` (Task 3 commit).

**3. [Rule 3 — Blocking] Vitest + RTL + jsdom were not installed in the dashboard package**

- **Found during:** Task 4 (preparing TodosTab.spec.tsx).
- **Issue:** Plan acceptance criteria mandate `npx vitest run src/pages/__tests__/TodosTab.spec.tsx exits 0`, but the dashboard package only had eslint + tsc + vite. No vitest, no @testing-library/*, no jsdom.
- **Fix:** Installed vitest 4.1.5, @testing-library/react 16.3.2, @testing-library/jest-dom 6.9.1, @testing-library/dom 10.4.1, jsdom 29.1.1 as devDeps. Created `vitest.config.ts` (separate from `vite.config.ts` so build pipeline isn't slowed by jsdom). Created `src/test/setup.ts` to bootstrap jest-dom matchers. Added `npm test` script.
- **Files modified:** `router/dashboard/package.json`, `package-lock.json`. Created `vitest.config.ts`, `src/test/setup.ts`.
- **Verification:** `npx vitest run src/pages/__tests__/TodosTab.spec.tsx` exits 0 with all 6 tests passing in 115ms.
- **Committed in:** `0210bc6` (Task 4 commit).

**4. [Rule 1 — Bug] Vitest fake-timers wedge RTL's waitFor**

- **Found during:** Task 4 (first run of TodosTab.spec.tsx — all 6 tests timed out at 5s).
- **Issue:** `vi.useFakeTimers()` in `beforeEach` froze every timer-based primitive including the ones RTL's `waitFor` uses internally (`setTimeout` for poll-checks, `queueMicrotask` for flush). All assertions hung.
- **Fix:** Use real timers by default, opt into fake timers only in the test that needs them and only for `setInterval` / `clearInterval`: `vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })`. RTL stays functional, the 5s cadence test still advances correctly.
- **Files modified:** `router/dashboard/src/pages/__tests__/TodosTab.spec.tsx`.
- **Verification:** All 6 tests now pass in 115ms.
- **Committed in:** `0210bc6` (Task 4 commit).

---

**Total deviations:** 4 auto-fixed (2 bug+missing-critical, 1 blocking, 1 bug)
**Impact on plan:** All four were necessary for correctness, security (graceful degradation), or test infrastructure. No scope creep — same contract delivered, deeper resilience baked in. The `normalizeRemindCtl` adapter and `listMissing` graceful banner especially harden the bridge against version drift and first-run friction users will hit.

## Authentication Gates

None hit. `remindctl status --json` reported `{authorized:true, status:"full-access"}` on this Mac; the codepath for `unauthorized:true` is exercised by the API spec (with stubbed `probeAuth`) and by the dashboard banner test. The fallback to `~/.claude/jarvis/todos.json` is in place for any future Mac that hasn't granted Reminders access.

## Issues Encountered

- **Pre-existing un-staged `dashboard/api.ts` MCP-auth-v2 diff (Plan 02-01 inheritance).** When I started Task 3, `git status` showed `M router/src/dashboard/api.ts` from a prior session's prototyping work. To keep the Task 3 commit clean (orchestrator-only), I `git checkout HEAD -- api.ts`, re-applied my changes, committed, and documented the situation in `deferred-items.md`. The MCP-auth-v2 diff is preserved in `stash@{0}`. Recovery: `git stash apply stash@{0}` will reintroduce it (with conflict markers because line numbers shifted by ~46 from my todos imports).
- **Pre-existing `breakdown.spec.ts:153` failure (Phase 1).** Confirmed still failing at HEAD (200 !== 2000). Pre-dates Plan 02-02 and Plan 02-01 (already deferred). Out-of-scope per `<deviation_rules>` SCOPE BOUNDARY.

## User Setup Required

None - no external service configuration required for the spec.

**However**, the user has a one-time bootstrap step on their Mac to enable the dashboard's todos round-trip (already executed during this plan's smoke test):

```bash
remindctl list "Jarvis/ActiveTasks" --create
```

Until run, `/api/todos` returns the `listMissing:true` banner and the dashboard guides the user through this exact command (visible in the banner).

## Self-Check

Verified all 20 created files exist on disk:

```
FOUND: router/src/services/reminders/__fixtures__/sample-{list,show-active,add-response,empty}.json (4)
FOUND: router/src/services/reminders/{types,metadata,metadata.spec,cli,cli.spec,poll,poll.spec,index}.ts (8)
FOUND: router/src/notch/orchestrator-events{,.spec}.ts (2)
FOUND: router/src/dashboard/api.todos{,.spec}.ts (2)
FOUND: router/dashboard/src/pages/TodosTab.tsx (1)
FOUND: router/dashboard/src/pages/__tests__/TodosTab.spec.tsx (1)
FOUND: router/dashboard/src/test/setup.ts (1)
FOUND: router/dashboard/vitest.config.ts (1)
```

Verified all 4 commits exist on `feature/orchestrator`:

```
2d54573  test(02-02): add reminders fixtures + types.ts + RED specs (Wave 0)
478feca  feat(02-02): reminders bridge primitives + namespaced orchestrator-events bus
322b964  feat(02-02): wire /api/todos endpoints + dashboard typed client + boot polling
0210bc6  feat(02-02): TodosTab dashboard page + Vitest+RTL infrastructure
```

## Self-Check: PASSED

## Next Phase Readiness

- The Reminders bridge is stable end-to-end. Plan 02-03 (Notch HUD) can subscribe to `todos:update` / `todo:added` / `todo:completed` / `todo:updated` events from the new `notch/orchestrator-events.ts` bus without re-implementing polling.
- `PATCH /api/todos/:uuid` already lands here (B2 fix), so Plan 02-03's long-press reassign flow (ORC-13) just calls the existing endpoint.
- The `LocalSession.todo_link` field reserved by Plan 02-01 will be populated by enriching the snapshot composer with a join against `listTodos()` — straightforward in Plan 02-04 / 02-03 once we have a session pid → todo metadata index.
- Manual UAT to run after the next router restart:
  - Open `http://localhost:3340/todos` → should show table; add a todo via input.
  - On iPhone, open Reminders → "Jarvis/ActiveTasks" list → todo appears within 15s (iCloud lag).
  - Check off on iPhone → dashboard shows it gone within 8s (3s polling + iCloud lag).

---
*Phase: 02-orchestrator-multi-session*
*Completed: 2026-05-10*
