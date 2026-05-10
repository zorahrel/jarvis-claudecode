---
phase: 2
slug: orchestrator-multi-session
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-10
---

# Phase 2 — Validation Strategy

> Per-phase validation contract. Pulls test infrastructure from Phase 1 (`node:test` + `node:assert/strict` co-located `*.spec.ts`). Wave 0 adds Phase 2 fixtures + skill bash test harness + Swift `XCTest` for new notch views.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework (router/services)** | `node:test` 24.x + `node:assert/strict`, co-located `*.spec.ts` |
| **Framework (skills)** | bash + `bats-core` 1.10.x for `~/jarvis/skills-marketplace/skills/orchestrator/tests/` |
| **Framework (notch Swift)** | XCTest in `tray-app/Tests/JarvisNotchTests/` |
| **Framework (dashboard React)** | Vitest 1.x + React Testing Library (already in `router/dashboard/`) |
| **Config file** | `router/package.json` test script (existing); new `tray-app/Package.swift` test target |
| **Quick run command** | `cd router && node --test 'src/services/**/*.spec.ts'` |
| **Full suite command** | `cd router && npm test && cd ../tray-app && swift test && cd ../router/dashboard && npm test` |
| **Estimated runtime** | ~45s (router) + ~20s (Swift) + ~30s (dashboard) = ~95s |

---

## Sampling Rate

- **After every task commit:** Run quick `node --test` matching the touched module path (per-file)
- **After every plan wave:** Run full router suite + Swift suite if notch changed
- **Before `/gsd:verify-work`:** Full suite must be green + manual smoke (notch UI + Reminders sync round-trip)
- **Max feedback latency:** 60s

---

## Per-Task Verification Map

> Plans not yet decomposed (next step in workflow). The planner will populate Task IDs once it produces 02-01..02-05-PLAN.md. Each task MUST have either `<automated>` or a Wave 0 entry below. The planner is instructed (via plan-phase prompt) to honor `<read_first>` + `<acceptance_criteria>` discipline so this map can be filled deterministically post-plan.

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| TBD by planner | 02-01..05 | 0..4 | ORC-01..22 | unit/integration/e2e | TBD | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `router/src/services/orchestrator/__fixtures__/sessions/` — JSONL fixtures for 5 status archetypes (awaiting_user_input, tool_pending, crashed, working, idle)
- [ ] `router/src/services/orchestrator/__fixtures__/reminders/` — sample `remindctl --json` outputs (list + show + add response)
- [ ] `router/src/services/orchestrator/__fixtures__/tmux/` — sample `tmux list-panes -aF` outputs covering: nested shells, detached pane, missing session
- [ ] `router/src/services/orchestrator/transcriptReader.spec.ts` — stubs for ORC-01, ORC-02 (extracts last assistant turn, detects pending tool_use, derives refinedStatus)
- [ ] `router/src/services/orchestrator/suggestionEngine.spec.ts` — stubs for ORC-04 (deterministic action+confidence per status)
- [ ] `router/src/services/orchestrator/cwdLock.spec.ts` — stubs for ORC-05, ORC-19 (subpath collision via realpath)
- [ ] `router/src/services/reminders/remindctl.spec.ts` — stubs for ORC-06..09 (CLI wrap, JSON parse, polling diff, schema metadata round-trip)
- [ ] `router/src/services/orchestrator/tmuxInject.spec.ts` — stubs for ORC-15..17 (pid→pane resolve, send-keys escape, audit append)
- [ ] `router/src/services/orchestrator/autopilot.spec.ts` — stubs for ORC-20..22 (disabled-by-default, budget cap, confidence:high gate)
- [ ] `~/jarvis/skills-marketplace/skills/orchestrator/tests/skill.bats` — bats stubs for ORC-03 (skill output JSON shape) using mocked HTTP server
- [ ] `tray-app/Tests/JarvisNotchTests/SessionsSidebarTests.swift` — XCTest stubs for ORC-11, ORC-14 (renders sessions, reacts to `sessions:update`)
- [ ] `tray-app/Tests/JarvisNotchTests/TodoStripTests.swift` — XCTest stubs for ORC-12, ORC-13, ORC-14 (top-3 ordering, click=complete, long-press=picker)
- [ ] `router/dashboard/src/pages/__tests__/OrchestratorTab.spec.tsx` — Vitest+RTL stubs for ORC-10 (Todos list), ORC-18 (Approve/Skip/Custom), ORC-19 (force-confirm modal)

> Wave 0 tests are intentionally RED stubs that fail with descriptive messages. They turn green as Waves 1-4 land. Goal: every requirement has a verification target before any implementation code is written.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Reminders iCloud sync end-to-end | ORC-07 | Requires iPhone + iCloud account; sync latency is non-deterministic (3-15s) | (1) Add todo via dashboard → (2) wait 15s → (3) verify visible on iPhone Reminders app under `Jarvis/ActiveTasks` → (4) check off on iPhone → (5) wait 15s → (6) verify dashboard shows it completed |
| Notch HUD always-on visibility | ORC-11, ORC-12 | Visual rendering on actual notch hardware; cannot be unit-tested | (1) Open 3+ Claude sessions under tmux → (2) trigger `awaiting_user_input` on one → (3) verify notch right-peek shows badge → (4) verify top-3 todo strip visible in expanded mode |
| `remindctl` authorization grant flow | ORC-06 | Requires user to click "Allow" in macOS privacy prompt; cannot be automated | (1) Reset privacy: `tccutil reset Reminders io.steipete.remindctl` → (2) start router → (3) call `/api/todos` → (4) verify dashboard shows banner "Authorize Reminders" → (5) click → (6) verify `remindctl status` reports authorized |
| Long-press on notch todo to reassign | ORC-13 | Touch/trackpad gesture on real device; macOS Catalyst limitations on simulators | (1) Long-press todo on notch → (2) verify session picker appears with active pid list → (3) select pid → (4) verify todo body now contains updated `pid:NNNN` metadata in Reminders |
| `tmux send-keys` against detached pane recovery | ORC-16 | Requires manual tmux session manipulation; race conditions with attach/detach | (1) Run session under `tmux new -s test` → (2) detach with Ctrl-b d → (3) call `/api/sessions/:pid/inject` → (4) verify text appears in pane → (5) reattach `tmux attach -t test` → (6) confirm prompt was injected |
| Auto-pilot daily budget cap reset at midnight | ORC-21 | Requires 24h elapsed; unit-testable via clock injection but real-world drift only visible in production | (1) Enable auto-pilot, set cap to 1000 tokens → (2) trigger 1100 tokens of inject → (3) verify auto-pilot stops with audit warning → (4) wait until 00:00 local → (5) verify counter resets and inject resumes |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies (filled after planner produces PLANs)
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (initial draft above; refine after planner returns)
- [ ] No watch-mode flags (`node --test` runs once; CI-friendly)
- [ ] Feedback latency < 60s (per-file run takes 1-3s; full suite 95s)
- [ ] `nyquist_compliant: true` set in frontmatter (after sign-off)

**Approval:** pending — flip `nyquist_compliant: true` only after gsd-plan-checker confirms every Task ID has a row in the verification map above.
