# Plan 01-06 — UI Components — SUMMARY

**Status:** COMPLETE
**Wave:** 3
**Date:** 2026-05-01
**Self-Check:** PASSED

## Objective achieved

Full React UI tree for the Context tab. 9 file changes (1 modified `client.ts` + 8 new components/helpers). Italian labels throughout. Zero new npm dependencies (uses existing react + lucide-react + CSS variables).

## Component tree

```
ContextTab (top-level page wrapper)
├── AggregateHeader        (3 stats: sessioni, token totali, costo medio + disco line)
├── SessionRow × N         (per-route bar with threshold colors + drill-down)
│   └── BreakdownStackedBar (8-segment stacked bar + 2-column legend + MCP/CLAUDE.md drill)
├── CruftPanel             (per-agent findings + suggestions in italian)
├── RecentSessionsList     (last 10 closed sessions, "Storico recente")
└── DiskHygieneFooter      (footer: MB / JSONL / >30g count)
```

## Italian label vocabulary (baseline for future i18n)

| Term | Italian | Used in |
|------|---------|---------|
| Sessions live | Sessioni live | ContextTab |
| Aggregate | Aggregato live | AggregateHeader |
| Total tokens | Token totali | AggregateHeader |
| Cost per turn | Costo medio per turno | AggregateHeader |
| Cruft / cleanup | Cruft / da pulire | ContextTab |
| Suggestions | Suggerimenti | CruftPanel |
| MCP not called | MCP non chiamati | CruftPanel |
| Skills never invoked | Skill mai invocate | CruftPanel |
| Recent history | Storico recente | RecentSessionsList |
| File age unit | g fa, h fa, m fa, s fa | RecentSessionsList |
| No sessions | Nessuna sessione attiva | ContextTab |
| No cruft | Nessun cruft rilevato — tutto pulito | CruftPanel |
| Refresh | Aggiorna | ContextTab |
| Loading breakdown | Caricamento breakdown | SessionRow |
| Loading top-level | Caricamento context inspector | ContextTab |
| Compaction warning | Critico — vicinissimo a compaction | thresholds.ts |
| Compaction soon | Alto — compaction in arrivo all'80% | thresholds.ts |
| Mid threshold | Medio — warn | thresholds.ts |
| Tools | Tool integrati | BreakdownStackedBar |

## Color palette

### Threshold colors (4 tiers)
- **#3b82f6** (blue) — `<50%` safe
- **#eab308** (yellow) — `50-74%` warn (BLOCKER 2 fix: was green #22c55e in checker iter 1)
- **#f97316** (orange) — `75-89%` crit
- **#ef4444** (red) — `≥90%` panic

### 8-category breakdown colors
- system_preset: `#64748b` slate
- builtin_tools: `#0ea5e9` sky
- mcp_servers: `#f59e0b` amber
- skills_index: `#a855f7` purple
- claudemd_chain: `#10b981` emerald
- subagents: `#ec4899` pink
- hooks_memory: `#6366f1` indigo
- history: `#94a3b8` gray

## Files created (8 new)

- `router/dashboard/src/components/context/thresholds.ts` — `THRESHOLDS`, `colorForThreshold`, `labelForThreshold`, `formatTokens`, `formatUsd`
- `router/dashboard/src/components/context/AggregateHeader.tsx` — header banner
- `router/dashboard/src/components/context/SessionRow.tsx` — per-route row + drill-down trigger
- `router/dashboard/src/components/context/BreakdownStackedBar.tsx` — 8-segment bar + drill-downs
- `router/dashboard/src/components/context/CruftPanel.tsx` — findings + suggestions
- `router/dashboard/src/components/context/RecentSessionsList.tsx` — historical list
- `router/dashboard/src/components/context/DiskHygieneFooter.tsx` — disk footer
- `router/dashboard/src/components/ContextTab.tsx` — top-level (Plan 07 refactors to use hook)

## Files modified (1)

- `router/dashboard/src/api/client.ts` — added 10 new types + 3 api methods (`contextSessions`, `sessionBreakdown`, `sessionsCruft`). Marked `localSessions` as `?legacy=1` to preserve Sessions.tsx.

## Hand-off to Plan 07

Plan 07 wraps the inline `useEffect` fetch in `ContextTab.tsx` with a custom `useContextPolling` hook (5s interval, visibility-aware pause, race-id guard, mount guard). The integration point is the body of the `ContextTab` function — replace the `useState` + `useEffect` + `fetchAll` block with a single `useContextPolling()` call.

## Commits

- `242b212` feat(01-06): tipi API client + thresholds.ts (yellow #eab308 a 50-74)
- `7acab41` feat(01-06): AggregateHeader + SessionRow + BreakdownStackedBar (italian)
- `e07bd57` feat(01-06): CruftPanel + RecentSessions + DiskHygiene + ContextTab top-level

## Notes

- Dashboard `node_modules/` not present in jarvis-ci worktree — `npm install` runs in Plan 08 before `npm run build`.
- Component-level `npx tsc -b` skipped here (depends on installed deps); deferred to Plan 08 build step which will catch any type mismatches.
- All components use `var(--bg-1)`, `var(--text-1)`, etc CSS variables — same as the existing dashboard look.
