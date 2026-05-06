---
phase: 1
slug: context-inspector
status: approved
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-01
updated: 2026-05-01
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
>
> **Framework decision (locked):** `node:test` runner (built into Node ≥22) invoked via `npx tsx --test`.
> **No new npm dependencies** (vincolo CLAUDE.md di progetto: "Don't add npm dependencies without good reason").
> Plans 01–08 use this stack exclusively. The earlier vitest mention in this file's first draft was a template artifact — superseded by the planner decision.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` (Node 22 built-in) via `tsx` (already a dev dep in `router/package.json`) |
| **Config file** | None required. `tsconfig.json` already covers `src/**`. No vitest, no jest, no playwright. |
| **Test runner** | `bash router/scripts/run-context-tests.sh` (created in Plan 01) |
| **Test file pattern** | `router/src/services/contextInspector/**/*.spec.ts` |
| **Quick run command** | `cd router && bash scripts/run-context-tests.sh` |
| **Full suite command** | `cd router && npx tsc --noEmit && bash scripts/run-context-tests.sh` |
| **Estimated runtime** | ~5-15 seconds (unit) + ~10-20s (integration with mock SDK stream) |
| **Manual UI verification** | Dashboard tab Context inspected at `localhost:3340` per Plan 08 checklist (no Playwright) |

---

## Sampling Rate

- **After every task commit:** Run `cd router && bash scripts/run-context-tests.sh`
- **After every plan wave:** Same command (full suite is fast enough at <30s)
- **Before `/gsd:verify-work`:** Full suite green + manual UI verification per Plan 08 checklist
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

> Filled in by gsd-planner during plan generation. Initial mapping per requirement category:

| REQ Category | Test Type | Automated Command | Notes |
|--------------|-----------|-------------------|-------|
| CTX-01..CTX-04 (live view) | integration | `vitest run api.local-sessions.spec` | mock filesystem + SDK signal stub |
| CTX-05..CTX-07 (breakdown) | unit + integration | `vitest run breakdown.spec` | pure function calculateBreakdown(spawnConfig) |
| CTX-08..CTX-11 (cruft) | unit | `vitest run cruft.spec` | detectCruft(toolUseEvents, mcpsLoaded) |
| CTX-12 (disk hygiene) | integration | `vitest run disk.spec` | tmp filesystem with mock JSONL |
| CTX-13 (polling) | e2e | `playwright test context-tab.spec` | heap snapshot before/after 10min |
| CTX-14 (endpoint) | integration | `vitest run api.breakdown.spec` | HTTP fetch + JSON schema validation |
| CTX-15 (token source) | unit | `vitest run token-source.spec` | SDK stream parser + JSONL tail parser |

*Detailed task-level mapping populated by planner.*

---

## Wave 0 Requirements

Implemented entirely by Plan 01-01 (Wave 0):

- [ ] Create test fixtures dir: `router/src/services/contextInspector/__fixtures__/`
- [ ] Create synthetic JSONL fixtures (router-spawned + bare CLI variants, both with `assistant` turns carrying `usage` field for cost calculation tests)
- [ ] Create SDK stream mock: `router/scripts/sdk-mock.ts` (emits synthetic `SDKTaskProgressMessage` events with `usage.total_tokens`)
- [ ] Create test runner script: `router/scripts/run-context-tests.sh` (single-command entry point used by all later plans)
- [ ] Verify `tsx` is already in `router/package.json` devDependencies (it is, per Plan 01 acceptance criteria)
- [ ] No vitest/jest/playwright install — explicitly avoided per project rules

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Visual rendering of stacked bar with correct colors at threshold boundaries | CTX-03 | Visual regression — automatable but adds Playwright snapshot maintenance burden | Apri `localhost:3340` tab Context, verifica bar verde<50, gialla 50-74, arancione 75-89, rossa ≥90 a occhio + screenshot allegato a SUMMARY |
| Auto-refresh non causa memory leak su 10min | CTX-13 | Long-running test costoso in CI; meglio manuale + heap snapshot occasionale | Apri Chrome DevTools Memory, snapshot baseline, attendi 10min, snapshot + verifica retained size < 5MB delta |
| UI italiana coerente con resto dashboard | (CLAUDE.md user pref) | Soggettivo | Review labels: "Sessioni", "Token in uso", "Costo", "Cruft / da pulire", non in inglese |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies (filled by planner)
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references (vitest configs, fixtures, mock stream)
- [ ] No watch-mode flags (run-only commands)
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter (after planner fills task map)

**Approval:** pending (planner fills + user reviews)
