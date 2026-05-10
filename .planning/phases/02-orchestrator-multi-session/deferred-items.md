# Deferred Items — Phase 2

Out-of-scope discoveries from plan execution that are NOT addressed by this phase.

## From Plan 02-01 execution (2026-05-07)

### Pre-existing Phase 1 test failure: `breakdown.spec.ts`

- **File:** `router/src/services/contextInspector/breakdown.spec.ts:153`
- **Test:** `calculateBreakdown: scoped agent with explicit mcp:exa + mcp:brave-search loads 2 servers`
- **Failure:** `200 !== 2000` (token estimate differs from expected by 10x)
- **Reproducible:** Yes — fails at HEAD before any 02-01 changes (verified via `git stash` + run).
- **Owner:** Phase 1 (Context Inspector). Was already broken when Phase 2 started.
- **Scope rule applied:** Out-of-scope per `<deviation_rules>` SCOPE BOUNDARY (failure pre-dates this plan and is in Phase 1 territory).
- **Action:** None. Logged here for the next person touching breakdown estimator.

### Pre-existing un-staged `dashboard/api.ts` changes (MCP auth v2)

- **File:** `router/src/dashboard/api.ts` (606..887 region)
- **Nature:** Hunk rewrites the `/api/mcp/authenticate` handler to support type:http transport via Claude CLI alongside the existing stdio + npx mcp-remote path.
- **Status:** Already present as un-staged work when Plan 02-01 started. Stashed and re-applied untouched around Task 3 commit so Plan 02-01 commits stayed clean.
- **Owner:** Whoever was prototyping MCP auth v2 (likely belongs to the `stash@{0}` mentioned in STATE.md).
- **Action:** Author should review and either commit or discard. Not Plan 02-01's responsibility.
