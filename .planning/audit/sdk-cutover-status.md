# SDK migration — cutover status

Date: 2026-04-26 19:44 UTC

## State

**Router is running with SDK backend ENABLED.**

```
launchctl list | grep com.jarvis.router
70650	0	com.jarvis.router
```

Log confirmation:
```
[19:44:09] INFO Claude backend selected backend: "sdk"
[19:44:09] INFO Jarvis Router ready — 4 connectors active
```

All 4 connectors active (Telegram, Discord, WhatsApp, Notch). Dashboard API responding, cron jobs registered (3), TypeScript compiles clean.

## Files changed

| Path | Change |
|---|---|
| `router/src/services/claude.ts` | NEW — thin dispatcher (35 lines) selecting backend by `JARVIS_USE_SDK` env var |
| `router/src/services/claude-cli.ts` | RENAMED from `claude.ts` — legacy CLI implementation, untouched |
| `router/src/services/claude-sdk.ts` | NEW — SDK adapter, full parity with CLI public API (~700 lines) |
| `router/package.json` | + `@anthropic-ai/claude-agent-sdk@^0.2.119` |
| `~/Library/LaunchAgents/com.jarvis.router.plist` | + `JARVIS_USE_SDK=1` env var |
| `router/scripts/sdk-spike.ts` | NEW — Phase 0 spike validation script |
| `router/scripts/sdk-parity-smoke.ts` | NEW — Phase 2 smoke test |
| `router/scripts/test-sdk-bg.ts` | NEW — bg behavior comparison test |

## Verification matrix

| Check | Status |
|---|---|
| TypeScript `tsc --noEmit` | ✅ exit 0 |
| Dashboard build (`npm run build`) | ✅ exit 0 |
| SDK adapter standalone smoke test | ✅ multi-turn, 1.9s + 1.3s, history accumulates via cache |
| Router boots with `JARVIS_USE_SDK=1` | ✅ "Claude backend selected: sdk" in log |
| All connectors start | ✅ Telegram, Discord, WhatsApp, Notch all ready |
| Dashboard API `/api/agents` | ✅ returns 8 agents |
| Cron registered | ✅ 3 jobs |

## What remains (requires real message traffic)

The integration test points that need a live user message to exercise:

1. Telegram round-trip with the `jarvis` agent (telegram:502955633)
2. Discord round-trip
3. WhatsApp round-trip
4. Bg subagent path actually firing — should work better than CLI per audit evidence
5. Compaction at 80% context (long session needed)
6. Rate-limit fallback (artificial — only triggers under load)

Send a Telegram message and watch:
```
tail -f ~/.claude/jarvis/logs/router.log | grep -E "claude-sdk|backend"
```

You should see: `"Sending message to SDK session"` → `"Claude responded (sdk)"` log lines.

## Rollback (one command)

If anything misbehaves under real traffic:

```bash
# Edit ~/Library/LaunchAgents/com.jarvis.router.plist — remove the JARVIS_USE_SDK key,
# OR set its value to 0.
# Then:
launchctl unload ~/Library/LaunchAgents/com.jarvis.router.plist
launchctl load ~/Library/LaunchAgents/com.jarvis.router.plist
```

The CLI implementation is unchanged in `claude-cli.ts` — zero risk of regression on rollback.

## Pending follow-ups (not blocking)

- Add `Bunfile.toml` / Bundler.toml updates if applicable (not detected as needed)
- Optional: expose `claude.useSdk` in `config.yaml` (currently env var only). Nice-to-have, env var works.
- Document the migration in CHANGELOG.md once stable for 48h
- Consider deleting `claude-cli.ts` after 1-2 weeks of stable SDK-only operation
- Phase 4 capability extensions (programmatic hooks, agentProgressSummaries, maxBudgetUsd) — opportunity, not requirement

## Decision points for the user

1. **Keep SDK backend live** — recommended. Send a real test message; if the round-trip works, leave it on for 24-48h soak.
2. **Stage but don't enable** — remove `JARVIS_USE_SDK=1` from plist for now, enable later. Code is in place.
3. **Roll back entirely** — revert the renames and deletions; CLI mode is the default if env var isn't set.

If keeping live: no commit required to the repo from me. The plist edit is local config, not in version control. The router code changes (claude.ts, claude-cli.ts, claude-sdk.ts, package.json) need a commit when you're ready — I have NOT committed them per the no-auto-commit rule in CLAUDE.md.
