# Plan 01-08 — Final Build + UAT Prep — SUMMARY

**Status:** PARTIAL (code-side complete, awaiting human UAT — checkpoint:human-verify)
**Wave:** 4
**Date:** 2026-05-01
**Self-Check:** PASSED for build + tests; PENDING for runtime UAT

## Objective achieved (code side)

- Backend tests: **57/57 pass** via `node:test` (zero new npm dependencies)
- Dashboard `npm install` + `npm run build` ran successfully — bundle generated in `router/dashboard/dist/`
- TypeScript: zero errors in `contextInspector/*` and `dashboard/src/components/context/*`
- All 8 plans of Phase 1 complete (01-01 through 01-08 minus the manual UAT step)

## What is NOT yet done (requires user)

The router live runs from `/Users/zorahrel/.claude/jarvis/router/` (the canonical path managed by `launchctl`), NOT from the `feature/context-inspector` worktree at `/Users/zorahrel/.claude/jarvis-ci/`. To deploy and test the new tab, the user must:

### Step 1 — merge feature branch into the active branch

The user is currently on `feature/notch` with 16 pending modifications (notch voice v2 wip). The Context Inspector branch needs to land alongside that work without mixing them.

**Recommended:** keep the branches separate, merge into `main` when both are ready. For now, to UAT the Context Inspector against the live router, the user can:

```bash
cd ~/.claude/jarvis
# Option A — temporary cherry-pick the contextInspector commits into the active branch:
git cherry-pick 0f011b9..68a2507   # 21 commits — feature/context-inspector range
# Resolve any conflicts (unlikely — file sets are disjoint)

# Option B — copy the built dist + backend files manually (faster, no git history):
cp -r ~/.claude/jarvis-ci/router/src/services/contextInspector ~/.claude/jarvis/router/src/services/
cp -r ~/.claude/jarvis-ci/router/dashboard/dist ~/.claude/jarvis/router/dashboard/
# (also copy the modified claude.ts, discovery.ts, api.ts, client.ts, App.tsx, Sidebar.tsx, ContextTab.tsx, scripts/)
# More fragile — git cherry-pick is cleaner.

# Option C — when notch v2 is done, merge feature/context-inspector into main, then merge main into feature/notch.
```

### Step 2 — install + build (if Option A or starting fresh)

```bash
cd ~/.claude/jarvis/router/dashboard
npm install              # if not already
npm run build            # produces dist/
```

### Step 3 — ⚠️ AVVISA query attive prima del restart

The user has an explicit memory rule (`feedback_router_restart_inflight`): **`launchctl kickstart` kills in-flight responses across all channels (notch, Telegram, WhatsApp, Discord)**. Before running the kickstart:

1. Check if any chat is mid-reply (notch overlay open with response streaming, TG message being delivered, WA queue, etc.)
2. If yes: wait until idle, OR explicitly inform the user via the channel they're using ("sto restartando il router")
3. Only then proceed.

```bash
launchctl kickstart -k gui/$(id -u)/com.jarvis.router
```

### Step 4 — Manual UAT checklist

Open `http://localhost:3340` and click "Context" in the left sidebar. Verify:

- [ ] **Tab appears** between Sessions and Analytics in the sidebar nav
- [ ] **Loading state** shows briefly: "Caricamento context inspector..."
- [ ] **Aggregate header** shows three stats: `N sessioni`, `XXk token`, `$X.XXXX` (live)
- [ ] **Disco line** in header: `Disco: ~986 MB · ~2012 JSONL · ⚠ N file >30g`
- [ ] **Sessioni live** section shows ≥1 row
- [ ] Each session row has:
  - [ ] Route label (e.g. `jarvis`, `notch`, `cecilia`)
  - [ ] Colored progress bar:
    - Blue (`#3b82f6`) under 50%
    - **Yellow (`#eab308`) 50–74%** ← BLOCKER 2 fix verification
    - Orange (`#f97316`) 75–89%
    - Red (`#ef4444`) ≥ 90%
  - [ ] Tokens text `XXk/200k`, percentage, and `$X.XXXX` cost
- [ ] **Click on a session row** → expands and renders BreakdownStackedBar with **8 colored segments**
- [ ] Breakdown labels in italian: "System preset", "Tool integrati", "MCP servers", "Skills index", "CLAUDE.md chain", "Subagents", "Hooks/Memory", "Conversation history"
- [ ] For at least one **router-spawned session**: cost is non-zero AND sessionKey is non-null (proves BLOCKER 1 + MAJOR 5 fixes)
- [ ] **MCP drill-down** lists 13 server names with transport (http/stdio) for jarvis fullAccess
- [ ] **CLAUDE.md drill-down** lists @-import paths with byte sizes
- [ ] **Cruft / da pulire** section shows per-agent findings (or "Nessun cruft" message)
- [ ] If cruft found: italian labels "MCP non chiamati", "Skill mai invocate", "Suggerimenti"
- [ ] **Storico recente** lists ≤10 closed sessions with route, tokens, turns, time-ago in italian (`s/m/h/g fa`)
- [ ] **Disco footer** shows `XXX MB`, `NNNN file JSONL`, `K file >30g`
- [ ] **Polling**: leave tab open 30 seconds, verify "aggiornato Xs fa" indicator updates (numbers tick)
- [ ] **Visibility pause**: open Chrome DevTools Network panel, switch to another tab, verify NO `/api/local-sessions` requests for >5s when tab is hidden
- [ ] **Memory leak test**: leave tab open 10 minutes, take Chrome DevTools heap snapshot before and after, verify retained delta < 5 MB
- [ ] **Refresh button** "Aggiorna" works, shows fresh data immediately
- [ ] **Backward compat**: open `localhost:3340` Sessions tab → still works (uses `/api/local-sessions?legacy=1`)

### Step 5 — Smoke test commands (curl)

```bash
# New aggregated shape
curl -s http://127.0.0.1:3340/api/local-sessions | jq '.aggregate'
# Expected: { totalSessions: N, totalLiveTokens: ..., avgCostPerTurnUsd: ... }

# Legacy shape (for Sessions.tsx)
curl -s "http://127.0.0.1:3340/api/local-sessions?legacy=1" | jq 'length'
# Expected: a number (N)

# Sidecar disk presence — proves MAJOR 5 wiring
ls -la ~/.claude/jarvis/active-sessions/
# Expected: at least 1 *.json file when a router-spawned Claude is live

# At least one router-spawned session has sessionKey AND non-zero cost — proves BLOCKER 1
curl -s http://127.0.0.1:3340/api/local-sessions | jq '.sessions[] | select(.isRouterSpawned == true) | {pid, sessionKey, agent, lastTurnCostUsd}'
# Expected: at least one entry with sessionKey != null AND lastTurnCostUsd > 0

# Breakdown drill-down
SESSION_ID=$(curl -s http://127.0.0.1:3340/api/local-sessions | jq -r '.sessions[0].sessionId // empty')
[ -n "$SESSION_ID" ] && curl -s "http://127.0.0.1:3340/api/sessions/${SESSION_ID}/breakdown" | jq '.categories | map({category, tokens})'
# Expected: 8 categories with token counts

# Cruft view
curl -s http://127.0.0.1:3340/api/sessions/cruft | jq '.agents'
# Expected: array of agents with findings + suggestions
```

## Known caveats (documented expectations)

- **CTX-09 caveat (skill cruft detection)**: The "Skill mai invocate" section in the cruft panel will be **empty in v1**. Skill cruft logic is implemented and unit-tested, but `skillsLoaded: []` is passed by the API endpoint until the skills marketplace index reader lands (deferred to v2). This is **expected** — not a bug. Plan 04 SUMMARY documents this.
- **Pre-existing TS error**: `dashboard/api.ts:1756` (notch `event` parameter implicit any) is unrelated to Phase 1 — predates this work.
- **node_modules size**: First-time `npm install` in dashboard adds ~150 MB of `node_modules/` to the worktree. Cleanup with the worktree at the end (`git worktree remove`).

## Backend test summary

```
57/57 tests pass via `node:test` (no vitest, no playwright, no new npm deps):

- types.ts:           (no tests, type-only)
- tokenSource.ts:     7 tests
- cost.ts:            7 tests
- claudeMdChain.ts:   6 tests
- breakdown.ts:       6 tests
- jsonlParser.ts:     7 tests
- cruft.ts:           6 tests
- diskHygiene.ts:     6 tests
- sidecar.ts:         7 tests
- api.spec.ts:        5 tests (integration, includes BLOCKER 1 e2e)
```

## Final phase status

- ✓ Wave 0: test infrastructure
- ✓ Wave 1: 3 backend modules (token source + cost + breakdown + cruft + disk)
- ✓ Wave 2: backend wiring + 3 API endpoints
- ✓ Wave 3: React UI tree + polling hook + routing
- ⏸ Wave 4 (this plan): code-side complete, runtime UAT pending user

## Commits

- `<task1>` build(dashboard): npm install + npm run build verified — bundle in dist/
- `<task2>` test(01-08): backend full sweep — 57/57 pass
- `<task3>` docs(01-08): SUMMARY with UAT checklist + smoke commands

(Code changes for Plan 01-08 are minimal — most "work" is verifying what's already there. The build artifact `dist/` is gitignored and not committed.)

## Hand-off

Phase 1 — Context Inspector — is **code-complete**. The next step is for the user to:

1. Plan the merge strategy for `feature/context-inspector` (cherry-pick into notch branch, or merge to main when both feature streams are ready)
2. Run the UAT checklist above against the live router
3. Address any visual/behavioral gaps found during UAT (likely → minor CSS tweaks)
4. Then mark Phase 1 fully complete in ROADMAP

Cleanup post-merge:

```bash
cd ~/.claude/jarvis
git worktree remove ../jarvis-ci
git branch -d feature/context-inspector   # only if merged elsewhere
```
