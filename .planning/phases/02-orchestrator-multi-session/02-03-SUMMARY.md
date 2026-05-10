---
phase: 02-orchestrator-multi-session
plan: 03
subsystem: notch-hud
tags: [swift, swiftui, xctest, notch, sse, orchestrator-events, sessions-sidebar, todo-strip, ORC-11, ORC-12, ORC-13, ORC-14]

# Dependency graph
requires:
  - phase: 02-orchestrator-multi-session
    provides: Plan 02-02 — orchestrator-events bus, /api/todos PATCH endpoint, ReminderTodo metadata round-trip, namespaced todo:* events
  - phase: 02-orchestrator-multi-session
    provides: Plan 02-01 — buildSnapshot, refinedStatus, lock/conflict detection
provides:
  - Swift NotchEvent decoder for sessions:update + todos:update wire shapes (Codable round-trip)
  - SessionsSidebarView (right peek) with 5-status colored badges + click-to-open dashboard
  - TodoStripView (top-3 thin row) with tap=complete + long-press=session picker via PATCH /api/todos/:uuid
  - NotchEventBus multi-subscriber bus + last-known-snapshot replay on reconnect (ORC-14)
  - JarvisNotchTests XCTest target with 10 tests covering ORC-11..14 (decoder, view rendering, reactivity, reconnect, tap, long-press)
  - Router-side bridge: 5s buildSnapshot tick → sessions:update + 1s debounce on todo:* → todos:update
  - NotchConnector subscribes to orchestrator-events and forwards via existing emitNotch transport (no new transport, no notch/events.ts pollution)
affects: [02-04-tmux-inject (already running in parallel), 02-05-auto-pilot]

# Tech tracking
tech-stack:
  added:
    - "XCTest target in tray-app/Package.swift (testTarget JarvisNotchTests, depends on JarvisNotch)"
    - "MockURLProtocol-based HTTP capture for SwiftUI view tests"
    - "Codable extension on NotchEvent (Decodable-only) for orchestrator wire shapes"
  patterns:
    - "Test affordances behind `#if DEBUG` extension blocks: publishForTesting, simulateDisconnectForTesting, lastSessionsForTesting on NotchEventBus; _test_complete(id:session:) and _test_longPressOpensPicker(id:) on TodoStripView; _test_installSubscription on SessionsSidebarView. Production API stays clean."
    - "Last-known-snapshot replay on subscribe + on reconnect — view-models never go perma-empty after a router restart or transport flap (ORC-14)."
    - "Router bridge boots from server.ts (NOT api.ts) — same lifecycle owner as startReminderPolling, avoids the parallel-execution constraint with Plan 02-04 owning api.ts."
    - "Lazy import of buildSnapshot + listTodos inside startOrchestratorBridge so non-bridge paths (tests, CLI tools) don't pull the orchestrator service graph."
    - "OrchestratorEvent union extended additively — sessions:update gains optional `sessions[]`, todos:update gains optional `topThree[]`. Backwards-compatible: 02-02's emit calls without these fields still type-check."

key-files:
  created:
    - tray-app/Tests/JarvisNotchTests/NotchEventDecoderTests.swift
    - tray-app/Tests/JarvisNotchTests/SessionsSidebarTests.swift
    - tray-app/Tests/JarvisNotchTests/TodoStripTests.swift
    - tray-app/Tests/JarvisNotchTests/NotchEventBusReconnectTests.swift
    - tray-app/Sources/JarvisNotch/SessionsSidebarView.swift
    - tray-app/Sources/JarvisNotch/TodoStripView.swift
  modified:
    - tray-app/Package.swift (+9 lines — JarvisNotchTests testTarget)
    - tray-app/Sources/JarvisNotch/NotchEvents.swift (rewrite — added 4 payload structs + 2 enum cases + Decodable conformance for orchestrator events)
    - tray-app/Sources/JarvisNotch/NotchEventBus.swift (rewrite — multi-subscriber bus, snapshot cache, replay-on-reconnect, #if DEBUG test affordances)
    - tray-app/Sources/JarvisNotch/NotchViews.swift (+18 / -3 lines — NotchExpandedView wraps WebView in HStack with sidebar + VStack with strip)
    - tray-app/Sources/JarvisNotch/NotchController.swift (+5 lines — exhaustive switch case for new events)
    - router/src/notch/orchestrator-events.ts (rewrite — extended union + startOrchestratorBridge + stopOrchestratorBridge)
    - router/src/dashboard/server.ts (+11 lines — wire startOrchestratorBridge in boot)
    - router/src/connectors/notch.ts (+45 lines — subscribeOrchestrator → emitNotch forwarder, static unsub holder)

key-decisions:
  - "Bridge boots from server.ts, not api.ts. The parallel-execution constraint forbade touching api.ts while Plan 02-04 was modifying it. server.ts already owns startReminderPolling lifecycle — natural co-location for startOrchestratorBridge. The plan permitted this explicitly: 'in api.ts (or wherever the dashboard server is bootstrapped)'."
  - "NotchEventBus gains a multi-subscriber `subscribe(_:)` API alongside the existing single-handler `start(_:)` API. The original handler is preserved verbatim for the controller; the new fan-out only activates when SessionsSidebarView / TodoStripView call subscribe in onAppear. Zero behavioral change for any existing consumer."
  - "Last-known-snapshot cache lives on NotchEventBus (not on the views). Replays on subscribe + on reconnect, so a fresh view that mounts mid-session repaints instantly, AND existing views survive a router restart with their state intact (ORC-14)."
  - "Test affordances (`#if DEBUG`) over runtime feature flags. Production builds get the slim API; XCTest builds get the publishForTesting / simulateDisconnect / _test_complete helpers. No conditional code paths in production."
  - "SessionsSidebarTests.testReactsToSessionsUpdateEvent uses _test_installSubscription instead of trying to coerce SwiftUI to call onAppear in a unit test. SwiftUI does not run lifecycle modifiers on bare `.body` evaluation outside a hosted view hierarchy; the helper installs the same closure onAppear would and the test asserts on the externally-owned binding."
  - "resetForTesting in setUp on each XCTest class — avoids order-dependent bleed-through where NotchEventBusReconnectTests seeds pid=[1,2] into the cache and a later test's subscribe gets the stale replay before its publishForTesting fires."
  - "Connector-level forward via `emitNotch({type, data})` reuses the existing SSE/WS transport. No new endpoint, no new wire format on notch/events.ts. The Swift parse(line:) is updated to recognize the two new types and route them to the orchestrator subscribers."

patterns-established:
  - "Per-Plan parallel execution: Plan 02-03 and 02-04 ran concurrently on disjoint files. Plan 02-03 owned tray-app/* + router/src/notch/orchestrator-events.ts + router/src/dashboard/server.ts + router/src/connectors/notch.ts. Plan 02-04 owned router/src/services/orchestrator/* + router/src/dashboard/api.ts (snapshot/inject regions) + router/src/dashboard/api.tmux.ts. Both used --no-verify on commits to avoid pre-commit hook contention; the orchestrator validates hooks once after both agents complete."
  - "SwiftUI test affordance pattern: extension behind #if DEBUG with `_test_*` static functions that mirror what the view's lifecycle modifiers register. Lets XCTest drive the same code paths without a hosted view hierarchy."
  - "Last-known-snapshot replay on every subscribe. Means new view-models repaint synchronously from cache instead of waiting for the next bridge tick, and reconnects don't flash empty UI."

requirements-completed: [ORC-11, ORC-12, ORC-13, ORC-14]

# Metrics
duration: 10min
completed: 2026-05-10
---

# Phase 02 Plan 03: Notch HUD Summary

**Notch HUD ships as the always-on visualization of the orchestrator: SessionsSidebarView (right peek) with 5-status colored badges + click-to-open-dashboard, TodoStripView (top thin row) with top-3 open todos rendering via `.prefix(3)` and tap=complete + long-press=session picker, NotchEventBus extended with multi-subscriber fan-out + last-known-snapshot replay on subscribe + on reconnect (ORC-14), and a router-side bridge in orchestrator-events.ts (5s buildSnapshot → sessions:update with `{pid, repo, status, conflict}` array + 1s debounce on todo:* → todos:update with topThree). 10/10 XCTests GREEN, 68/68 prior router tests still GREEN, typecheck GREEN, swift build GREEN, tray-app/make-app.sh GREEN, notch/events.ts UNCHANGED.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-05-10T11:07:03Z
- **Completed:** 2026-05-10T11:17:30Z
- **Tasks:** 3 / 3
- **Files modified:** 13 (6 created + 7 modified)
- **Tests added:** 10 XCTest cases (3 decoder, 3 sidebar, 3 strip, 1 reconnect). All GREEN. Plan 02-01 + 02-02 specs (68) still GREEN. TS typecheck GREEN.

## Accomplishments

- **Swift event decoder extended** — `NotchEvent` enum gains `case sessionsUpdate(SessionsUpdatePayload)` + `case todosUpdate(TodosUpdatePayload)` plus 4 new Codable payload structs (`SessionStatusEntry`, `SessionsUpdatePayload`, `TodoSummary`, `TodosUpdatePayload`). A new Decodable extension lets `JSONDecoder().decode(NotchEvent.self, ...)` round-trip the wire shape from the router. Existing cases preserved verbatim — zero impact on the controller's existing handler.
- **NotchEventBus multi-subscriber + snapshot cache** — new `subscribe(_:)` API alongside the existing single-handler `start(_:)` API. Last `sessions:update` and `todos:update` payloads are cached and replayed (a) immediately to any new subscriber and (b) to all subscribers on reconnect. View-models never go perma-empty (ORC-14).
- **SessionsSidebarView ships** — right-peek vertical list, one row per session, status-colored badge (awaiting_user_input → orange, tool_pending → blue, crashed → red, working → green, idle → gray), repo name, pid, conflict warning icon. Click opens `http://localhost:3340/orchestrator?pid=<pid>` in default browser. Subscribes via `NotchEventBus.subscribe` in `onAppear`, unsubscribes in `onDisappear`.
- **TodoStripView ships** — horizontal strip, `.prefix(3)` slice of the bound todo array. Tap fires `POST /api/todos/:id/complete`. Long-press (0.5s) toggles `pickerForTodoId` state, opens a `SessionPickerView` sheet that loads active pids via `/api/local-sessions` and dispatches `PATCH /api/todos/:id` with new pid metadata. PATCH endpoint already exists (Plan 02-02 Task 3 B2 fix).
- **NotchExpandedView re-composed** — `VStack` with `TodoStripView` on top, then `HStack` with the existing 420×540 WebView and the new `SessionsSidebarView` (160-wide) on the right. Existing chat/TTS/abort visuals untouched.
- **NotchController.apply(event:) made exhaustive** — new `case .sessionsUpdate, .todosUpdate: break` (controller delegates these directly to the views via the bus, no controller-level reaction).
- **Router-side bridge ships** — `startOrchestratorBridge({snapshotIntervalMs: 5000})` in `notch/orchestrator-events.ts`. 5s `setInterval` calls `buildSnapshot()` and emits `sessions:update` with the rich `{pid, repo, status, conflict}` array. A subscribe-to-self loop debounces `todo:added/completed/updated` events into a 1s window and re-emits `todos:update` with the top-3 open todos sorted by due-date. Idempotent boot.
- **NotchConnector → orchestrator forward** — `subscribeOrchestrator` lands in `connectors/notch.ts`. On `start()`, the connector subscribes to the orchestrator bus and forwards every event through the existing `emitNotch({type, data})` transport. Static `orchestratorBridgeUnsub` survives connector hot-reloads. The Swift `NotchEventBus.parse(line:)` recognizes the two new types and broadcasts them to the orchestrator subscribers (sidebar + strip view-models).
- **XCTest target shipped** — `tray-app/Package.swift` gains a `testTarget` for `JarvisNotchTests` depending on `JarvisNotch`. 10 tests cover decoder shapes, view smoke renders, view reactivity, top-3 slicing contract, tap-completes-via-MockURLProtocol, long-press-toggles-picker, and reconnect-replays-last-snapshot. All GREEN. Build via `cd tray-app && swift test --filter JarvisNotchTests`.
- **`notch/events.ts` UNCHANGED** — `git diff --quiet HEAD -- router/src/notch/events.ts && echo CLEAN` reports CLEAN. Anti-pattern from RESEARCH.md preserved end-to-end.

## Task Commits

1. **Task 1 (Wave 0): XCTest target + RED stubs** — `84a79ba6` (test)
2. **Task 2 (Wave 1): NotchEvents extension + SessionsSidebarView + TodoStripView** — `36d869c8` (feat)
3. **Task 3 (Wave 2): orchestrator → notch event bridge** — `76f896e6` (feat)

## Files Created/Modified

### Created (tray-app/)

- `Tests/JarvisNotchTests/NotchEventDecoderTests.swift` — 3 tests: sessions:update decode, todos:update decode, unknown-type non-crash.
- `Tests/JarvisNotchTests/SessionsSidebarTests.swift` — 3 tests: empty state, three sessions render, reactivity to bus event via `_test_installSubscription`.
- `Tests/JarvisNotchTests/TodoStripTests.swift` — 3 tests: top-3 slicing, tap captures POST /api/todos/T-1/complete via MockURLProtocol, long-press toggles picker visible.
- `Tests/JarvisNotchTests/NotchEventBusReconnectTests.swift` — 1 test: ORC-14 disconnect+reconnect preserves last `sessions:update` payload in the bus cache.
- `Sources/JarvisNotch/SessionsSidebarView.swift` — public SwiftUI view with `badgeColor(for:)` + `openDashboardOrchestratorTab(pid:)` + `_test_installSubscription` helper.
- `Sources/JarvisNotch/TodoStripView.swift` — public SwiftUI view with private `complete(id:)`, `reassign(todoId:pid:)`, internal static `completeRequest(id:session:)`, `#if DEBUG` `_test_complete` + `_test_longPressOpensPicker`. Inline `SessionPickerView` + `LocalSessionMini`.

### Modified (tray-app/, additive)

- `Package.swift` — adds `.testTarget(name: "JarvisNotchTests", dependencies: ["JarvisNotch"], path: "Tests/JarvisNotchTests")` after the existing `JarvisNotch` executableTarget. Existing JarvisTray + JarvisNotch targets unchanged.
- `Sources/JarvisNotch/NotchEvents.swift` — adds 4 payload structs + 2 enum cases + `Decodable` extension for orchestrator events. Existing `NotchAgentState` enum and `NotchEvent` cases preserved verbatim.
- `Sources/JarvisNotch/NotchEventBus.swift` — multi-subscriber list, snapshot cache, replay logic, parse(line:) handles two new types, `#if DEBUG` test affordances. Existing `start(_:)` API + SSE connect/reconnect/parse logic preserved.
- `Sources/JarvisNotch/NotchViews.swift` — `NotchExpandedView` wraps the existing WebView in a VStack-of-HStack with TodoStripView on top and SessionsSidebarView on right. Existing compact + peek views untouched.
- `Sources/JarvisNotch/NotchController.swift` — adds `case .sessionsUpdate, .todosUpdate: break` to `apply(event:)` switch (required because Swift's switch must be exhaustive).

### Modified (router/, additive)

- `src/notch/orchestrator-events.ts` — `OrchestratorEvent` union now optionally carries `sessions[]` (sessions:update) and `topThree[]` (todos:update). New `SessionStatusEntry` + `TodoSummary` interfaces. New `startOrchestratorBridge` + `stopOrchestratorBridge`. `__resetForTests` now also stops the bridge so spec hermeticity is preserved. Existing emit/subscribe/listenerCount unchanged.
- `src/dashboard/server.ts` — boots `startOrchestratorBridge({snapshotIntervalMs: 5000})` alongside `startReminderPolling`. Same `JARVIS_NO_POLL` escape hatch. Imports updated.
- `src/connectors/notch.ts` — adds `subscribeOrchestrator` import and a static `orchestratorBridgeUnsub`. On `start()`, installs a forwarder that calls `emitNotch({type, data})` for every orchestrator event. On `stop()`, tears the subscription down.

## Decisions Made

- **Bridge boots from `server.ts`, not `api.ts`.** The parallel-execution constraint forbade touching `api.ts` while Plan 02-04's agent was actively modifying it (the snapshot/inject regions). `server.ts` already owns the lifecycle of `startReminderPolling`, so co-locating `startOrchestratorBridge` there preserves a single boot site for all orchestrator polling. The plan explicitly permitted this with the phrase "or wherever the dashboard server is bootstrapped".
- **Multi-subscriber `subscribe(_:)` on NotchEventBus alongside the existing `start(_:)`.** Adding fan-out without unseating the controller's primary handler keeps the change additive. Backwards-compatible: `NotchController.mount` continues to call `start(_:)` and gets every event the way it always did.
- **Last-known-snapshot cache is owned by the bus, not the views.** A view that subscribes mid-session gets a synchronous replay; a view that survives a transport flap also gets a replay (broadcast from `replayCachedSnapshots` inside `scheduleReconnect`). Single source of truth — no per-view caching, no race between bus and view-model.
- **Test affordances behind `#if DEBUG` extensions.** Production builds get the slim API; XCTest builds get `publishForTesting`, `simulateDisconnectForTesting`, `simulateReconnectForTesting`, `lastSessionsForTesting`, `resetForTesting` on the bus; `_test_complete(id:session:)` + `_test_longPressOpensPicker(id:)` on TodoStripView; `_test_installSubscription` on SessionsSidebarView. No conditional production code paths.
- **`_test_installSubscription` instead of trying to coerce SwiftUI lifecycle.** SwiftUI does NOT run `.onAppear` when a view's `.body` is materialized in a unit test outside a hosted hierarchy. The test helper installs the same closure the production `.onAppear` would, so the test asserts on real subscription behavior — not just compile-time presence.
- **`resetForTesting` called in `setUp` of every XCTest class.** Avoided an order-dependent failure where `NotchEventBusReconnectTests` seeded `pid=[1,2]` into the bus cache and a later `SessionsSidebarTests` got the cached replay before its `publishForTesting` (pid=42) fired. Pristine bus per test.
- **NotchConnector forwards via `emitNotch({type, data})` (the existing transport).** No new endpoint, no new SSE channel, no extension to `notch/events.ts`. The Swift parser updates (recognize two new types, route them to orchestrator subscribers) are the only addition. RESEARCH.md anti-pattern explicitly preserved: `notch/events.ts` UNCHANGED.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Blocking] Plan acceptance criterion `grep -q "startOrchestratorBridge" src/dashboard/api.ts` unsatisfiable under parallel-execution constraint**

- **Found during:** Task 3.
- **Issue:** The plan's automated verify command requires `grep -q "startOrchestratorBridge" src/dashboard/api.ts`, but the parallel-execution constraint (`important_constraints` #8) explicitly forbade touching `api.ts` because Plan 02-04 owned the snapshot/inject regions and was actively running. Verified: `git diff` of `api.ts` showed Plan 02-04 had already added 35+ lines to that file when Task 3 started.
- **Fix:** Wired `startOrchestratorBridge` into `router/src/dashboard/server.ts` instead. The plan explicitly permitted this with the phrase: "in `router/src/dashboard/api.ts` (or wherever the dashboard server is bootstrapped)". `server.ts` is already the lifecycle owner for `startReminderPolling`, so co-locating the bridge there is more natural than splitting boot logic between two files. The acceptance grep was updated to look at `server.ts` instead.
- **Files modified:** `router/src/dashboard/server.ts` (instead of `router/src/dashboard/api.ts`).
- **Verification:** `grep -q "startOrchestratorBridge" router/src/dashboard/server.ts` returns success; npm run typecheck GREEN; existing 68 router tests still GREEN.
- **Committed in:** `76f896e6` (Task 3).

**2. [Rule 1 — Bug] SwiftUI `onAppear` does NOT fire when `view.body` is materialized in an XCTest harness — `testReactsToSessionsUpdateEvent` failed on first run**

- **Found during:** Task 2 (first `swift test` run).
- **Issue:** The plan's RED stub for `testReactsToSessionsUpdateEvent` evaluated `_ = view.body` in the comment "// forces onAppear in test runner harness". This is incorrect — SwiftUI only runs lifecycle modifiers when the view is part of a hosted hierarchy (e.g. `WindowGroup`, `NSHostingView`). In an XCTest the body materialization is a no-op for `.onAppear`. Symptom: the test timed out at 1s with the binding still empty.
- **Fix:** Added a `_test_installSubscription(setSessions:)` static helper to `SessionsSidebarView` (behind `#if DEBUG`) that registers exactly the same subscription closure `.onAppear` registers in production. The test now calls this helper directly, then `publishForTesting` on the bus, then waits for the `DispatchQueue.main.async` hop. The test asserts on a `Box`-wrapped sessions array (an `@unchecked Sendable` class so the `@escaping` closure can mutate it without triggering Swift's strict concurrency checks).
- **Files modified:** `tray-app/Sources/JarvisNotch/SessionsSidebarView.swift`, `tray-app/Tests/JarvisNotchTests/SessionsSidebarTests.swift`.
- **Verification:** `swift test --filter JarvisNotchTests` exits 0 with all 10 tests passing.
- **Committed in:** `36d869c8` (Task 2).

**3. [Rule 1 — Bug] Test order-dependent bleed-through — `NotchEventBusReconnectTests` seeded `pid=[1,2]` into the cache before `SessionsSidebarTests` ran**

- **Found during:** Task 2 (after fixing #2 above, the test still failed: `Optional(1) != Optional(42)`).
- **Issue:** XCTest runs test classes in alphabetical order. `NotchEventBusReconnectTests` runs first, calls `publishForTesting(.sessionsUpdate({pids: [1,2]...}))` to seed the cache, finishes. `SessionsSidebarTests.testReactsToSessionsUpdateEvent` then calls `_test_installSubscription` which immediately replays the cached `pid=1` payload to the new subscriber BEFORE the test's own `publishForTesting(.sessionsUpdate({pids: [42]...}))` fires. The Box ends up with pid=1.
- **Fix:** Added a `resetForTesting()` method to `NotchEventBus` (behind `#if DEBUG`) that clears subscribers + cached snapshots. Wired into `setUp` of every XCTest class so each test starts with a pristine bus.
- **Files modified:** `tray-app/Sources/JarvisNotch/NotchEventBus.swift`, all 4 XCTest files.
- **Verification:** `swift test --filter JarvisNotchTests` 10/10 GREEN, repeatable across multiple runs.
- **Committed in:** `36d869c8` (Task 2).

**4. [Rule 3 — Blocking] Swift switch must be exhaustive — `NotchController.apply(event:)` did not handle the new cases**

- **Found during:** Task 2 (first `swift build`).
- **Issue:** Adding `case sessionsUpdate` + `case todosUpdate` to `NotchEvent` made the existing `switch event` in `NotchController.apply(event:)` non-exhaustive — Swift compile error.
- **Fix:** Added `case .sessionsUpdate, .todosUpdate: break` to the controller's switch. The controller does not need to react to these events — the views subscribe directly via `NotchEventBus.subscribe`. Comment documents the rationale.
- **Files modified:** `tray-app/Sources/JarvisNotch/NotchController.swift`.
- **Verification:** `swift build` exits 0; `tray-app/make-app.sh` exits 0 with `App bundle located at './.build/bundler/apps/JarvisNotch/JarvisNotch.app'`.
- **Committed in:** `36d869c8` (Task 2).

---

**Total deviations:** 4 auto-fixed (1 blocking from parallel-execution constraint, 1 SwiftUI lifecycle gotcha, 1 test isolation, 1 Swift exhaustiveness compile error). All four were necessary for correctness and test stability. No scope creep — same contract delivered, deeper resilience baked in around test hermeticity and SwiftUI's actual unit-test behavior.

## Authentication Gates

None. Plan 02-03 is read-only on the Reminders side (PATCH endpoint already exists from Plan 02-02), and the Swift surfaces don't talk to OS frameworks beyond `NSWorkspace.open(_:)` for the dashboard link, which doesn't require permissions.

## Issues Encountered

- **Parallel agent's modifications to `router/src/dashboard/api.ts` and `router/src/services/orchestrator/snapshot.ts`.** Plan 02-04's agent committed these changes during Plan 02-03's Task 3. They added tmux/inject endpoints and snapshot enrichment with pane info — disjoint from the bridge wiring. Verified via `git log --oneline` that commits interleaved cleanly: my `36d869c8` (Plan 02-03 Task 2), then `d052fe61`+`d9245870`+`298b4581` (Plan 02-04), then my `76f896e6` (Plan 02-03 Task 3). Both plans completed without merge conflicts.
- **`MockURLProtocol` warning** — `nonisolated(unsafe) static let shared` triggers a Swift 6 warning ("unnecessary for a constant with 'Sendable' type"). Test still passes; out-of-scope to fix per `<deviation_rules>` SCOPE BOUNDARY (it's a test-file-only warning, not a Plan 02-03 change-driven regression).

## User Setup Required

None — no external service configuration required for the spec.

**Manual UAT** (run after the next router restart):

1. `launchctl kickstart -k gui/$(id -u)/com.jarvis.router` — restart router so `startOrchestratorBridge` boots.
2. Replace the running notch with the freshly-built one: `cp -R ~/.claude/jarvis/tray-app/.build/bundler/apps/JarvisNotch/JarvisNotch.app /Applications/` (or however your launchd plist points).
3. Open notch in expanded mode (hover over notch + click).
4. Within 5s, the **right-peek sidebar** populates with one row per active Claude Code session (status badges: orange = awaiting input, blue = tool pending, red = crashed, green = working, gray = idle).
5. Within 5s of adding a todo via the dashboard, the **top strip** updates to show the top-3 with the new entry.
6. **Click** a todo in the strip → it disappears within 5s (server confirms via `POST /api/todos/:id/complete`).
7. **Long-press** a todo → session picker sheet opens; select a pid → the todo's metadata in Reminders updates (visible on iPhone within 15s).
8. **Reconnect test:** `kill -9` the router process, then restart it. The notch sidebar + strip should retain their last state (no flash to empty), then repaint within 5s with fresh data once the bridge reconnects.

## Self-Check

Verified all 6 created files exist on disk:

```
FOUND: tray-app/Tests/JarvisNotchTests/NotchEventDecoderTests.swift
FOUND: tray-app/Tests/JarvisNotchTests/SessionsSidebarTests.swift
FOUND: tray-app/Tests/JarvisNotchTests/TodoStripTests.swift
FOUND: tray-app/Tests/JarvisNotchTests/NotchEventBusReconnectTests.swift
FOUND: tray-app/Sources/JarvisNotch/SessionsSidebarView.swift
FOUND: tray-app/Sources/JarvisNotch/TodoStripView.swift
```

Verified all 3 commits exist on `feature/orchestrator`:

```
84a79ba6  test(02-03): add XCTest target + RED stubs for notch HUD (Wave 0)
36d869c8  feat(02-03): NotchEvents extended + SessionsSidebarView + TodoStripView (Wave 1)
76f896e6  feat(02-03): orchestrator → notch event bridge (Wave 2)
```

Verified `notch/events.ts` UNCHANGED:

```
$ git diff --quiet HEAD -- router/src/notch/events.ts && echo CLEAN
CLEAN
```

Verified Swift tests GREEN:

```
$ cd tray-app && swift test --filter JarvisNotchTests
Test Suite 'JarvisPackageTests.xctest' passed
Executed 10 tests, with 0 failures (0 unexpected) in 0.014 seconds
```

Verified router tests still GREEN:

```
$ cd router && JARVIS_NO_POLL=1 npx tsx --test 'src/services/orchestrator/*.spec.ts' 'src/services/reminders/*.spec.ts' 'src/notch/orchestrator-events.spec.ts' 'src/dashboard/api.todos.spec.ts'
tests 68
pass 68
fail 0
```

Verified typecheck GREEN:

```
$ cd router && npm run typecheck
> tsc --noEmit
(no output — clean)
```

Verified app build GREEN:

```
$ bash tray-app/make-app.sh
==> [JarvisNotch] Done: build/JarvisNotch.app (42M)
```

## Self-Check: PASSED

## Next Phase Readiness

- Plan 02-04 (tmux inject) is already running concurrently as a Wave-1b parallel executor and has landed its commits in interleaved order: `d052fe61` (W0 fixtures + RED specs), `d9245870` (tmuxMap + audit), `298b4581` (tmux + inject endpoints + snapshot enrichment). With Plan 02-03's HUD layer in place, the Approve/Skip/Custom controls Plan 02-04 lands in the dashboard now have a visible counterpart in the notch — when the sidebar shows a session in `awaiting_user_input` (orange badge), the user can either click to deep-link to the dashboard's Approve UI, or expand the dashboard tab directly.
- Plan 02-05 (auto-pilot) can now consume `sessions:update`'s rich `sessions[]` array from the notch HUD's perspective — the HUD doubles as a real-time monitor for auto-pilot decisions when 02-05 lands.
- The reconnect-replay-last-snapshot pattern (`NotchEventBus.lastSessionsPayload` cache + `replayCachedSnapshots` on reconnect) is reusable for any future orchestrator surface that needs survival across transport flaps.

---
*Phase: 02-orchestrator-multi-session*
*Completed: 2026-05-10*
