# Plan 01-04 — Cruft Detection + JSONL Parser + Disk Hygiene — SUMMARY

**Status:** COMPLETE
**Wave:** 1
**Date:** 2026-05-01
**Self-Check:** PASSED

## Objective achieved

Three filesystem-reading helpers for the cruft panel (CTX-08/09/10), recent-sessions history (CTX-11), and disk hygiene footer (CTX-12). All tail-only on JSONLs (256 KB cap), all return graceful zeros on missing files, all unit-tested with synthetic fixtures or Wave 0 fixtures.

## Files created

### `jsonlParser.ts` — JSONL utilities (shared by cruft + diskHygiene)
- `readJsonlTailLines(path, maxBytes=256_000): Promise<string[]>`
- `extractToolUseEvents(path, lastNTurns=5): Promise<ToolUseRecord[]>`
- `countCompactions(path): Promise<number>` — counts lines with `isCompactSummary === true`
- `sumTokens(path): Promise<{ input, output, cacheCreation, cacheRead, total }>`
- `countTurns(path): Promise<number>` — counts assistant lines

### `cruft.ts` — Cruft detection + suggestions
- `detectCruft({ mcpsLoaded, skillsLoaded, toolUseEvents, recentTurns, ... }): CruftFinding[]`
- `getSuggestionsForCruft(findings, ctx?): ConfigSuggestion[]`
- `extractMcpServerName(toolUseName): string | null` — `mcp__zenda__list_topics` → `zenda`
- `SUGGESTIONS: ConfigSuggestion[]` — 4 hardcoded entries

### `diskHygiene.ts` — Disco footer + Storico recente
- `diskStats(projectsRoot): Promise<{ totalMb, totalJsonl, filesOlderThan30d }>`
- `recentSessions(projectsRoot, limit=10): Promise<RecentSession[]>` — newest first, enriched

### Spec files (3 × all passing)
- `jsonlParser.spec.ts` — 7 tests
- `cruft.spec.ts` — 6 tests
- `diskHygiene.spec.ts` — 6 tests

## SUGGESTIONS list (Plan 06 UI references these IDs)

| id | when | action |
|----|------|--------|
| `split-jarvis-chat` | mcp_unused.length ≥ 5 AND agent==='jarvis' | Split jarvis into jarvis-chat (no MCP) + jarvis-code (full MCP) |
| `notch-collapse-userscope` | agent==='notch' AND inheritUserScope===true AND mcp_unused.length ≥ 8 | Set notch.inheritUserScope: false |
| `gsd-namespace-gating` | skill_unused contains gsd:* | Gate gsd:* plugin per-agent |
| `scope-mcp-explicit` | fullAccess===true AND mcp_unused.length ≥ 7 | Replace fullAccess with explicit tools list |

These 4 suggestions tie directly to the open questions in RESEARCH.md anatomy report ("Where the cruft is likely hiding").

## DiskStats output shape

```typescript
{
  totalMb: number,           // sum of .jsonl sizes / 1024 / 1024
  totalJsonl: number,        // count of all .jsonl files across all slugs
  filesOlderThan30d: number  // count with mtime older than 30 days
}
```

Used in the Context Tab footer: "Disco: ZZZ MB · NNNN JSONL · ⚠ K file >30g".

## RecentSession enrichment fields

```typescript
{
  slug: string,             // project slug dir name
  sessionId: string,        // uuid (filename without .jsonl)
  transcriptPath: string,   // absolute path
  cwd: string,              // best-effort reconstruction (NOT guaranteed invertible)
  routeHint: string | null, // "notch" if cwd matches /jarvis/agents/<NAME>
  mtime: number,            // ms epoch
  sizeBytes: number,
  totalTokens: number,      // sumTokens().total across assistant lines
  turnCount: number,
  compactionCount: number   // isCompactSummary=true line count
}
```

## v1 caveat — CTX-09 (skill cruft detection)

**This is intentional and documented behavior, NOT a bug.**

Skill cruft detection logic is fully implemented and unit-tested in `cruft.ts`:
- `detectCruft({ skillsLoaded, ... })` correctly identifies skills not invoked
- 6 tests covering the path

**However**, Plan 05's `GET /api/sessions/cruft` endpoint passes `skillsLoaded: []` because the live skills marketplace index reader is **deferred to v2**. Production-side, the cruft panel "Skill mai invocate" section will be empty in v1.

Plan 08 UAT checklist explicitly notes this: "Skill cruft panel will be empty in v1 (expected — skills marketplace index reader deferred to v2)."

When the v2 skills index reader lands, no changes needed in `cruft.ts` — Plan 05 simply enriches `skillsLoaded` with the discovered skill ids and detection fires automatically.

## Test results

19 tests passing total:
- jsonlParser: 7 (extractToolUseEvents, countCompactions, sumTokens, countTurns, readJsonlTailLines + edge cases)
- cruft: 6 (detect, suggestions, extractMcpServerName + edge cases)
- diskHygiene: 6 (diskStats with old files, recentSessions ordering + limit + routeHint)

## Commits

- `<commit-1>` feat(01-04): aggiungi parser JSONL per tool_use events
- `<commit-2>` feat(01-04): aggiungi cruft detector per MCP/skill non usati
- `<commit-3>` feat(01-04): aggiungi statistiche disk hygiene per JSONL

(See `git log --oneline main..HEAD` for actual SHAs.)

## Notes

- Imports types only from `./jsonlParser.js` and `./types.js`. Module is self-contained.
- JSONL tail read is bounded at 256 KB by default — handles multi-GB transcripts gracefully.
- Plan 05 uses these for: `/api/sessions/cruft` (cruft.ts), `/api/local-sessions` extension with disk + recent (diskHygiene.ts), per-session breakdown enrichment (jsonlParser.ts).
- TypeScript compilation: zero errors mentioning the new files (pre-existing notch errors in `dashboard/api.ts` are unrelated).
