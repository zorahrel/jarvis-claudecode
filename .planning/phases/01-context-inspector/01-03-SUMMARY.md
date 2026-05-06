# Plan 01-03 — 8-Category Breakdown + @-import Resolver — SUMMARY

**Status:** COMPLETE
**Wave:** 1
**Date:** 2026-05-01
**Self-Check:** PASSED

## Objective achieved

8-category breakdown estimator (`calculateBreakdown`) producing the diagnostic data for the Context Tab drill-down (CTX-05). Backed by a recursive `@`-import resolver (`expandClaudeMdChain`) that follows Claude Code's CLAUDE.md import syntax (CTX-06). MCP server enumeration covers both `fullAccess: true` (all 13 servers) and explicit `tools: ["mcp:exa", ...]` patterns (CTX-07).

## Files created

- `router/src/services/contextInspector/claudeMdChain.ts` — Recursive `@`-import resolver
  - `expandClaudeMdChain(rootPath): Promise<ChainResult>`
  - Reads first 4 KB of each file (matches Claude Code preset behavior)
  - Regex `/^@(\S+)/gm` for line-anchored imports
  - Tilde expansion (`~/path` → `$HOME/path`), absolute pass-through, relative-to-importing-file
  - Cycle detection via `Set<string>` of visited absolute paths
  - Missing files silently recorded in `missing[]`
  - Returns DFS-from-root entry order
- `router/src/services/contextInspector/claudeMdChain.spec.ts` — 6 tests, all pass
- `router/src/services/contextInspector/breakdown.ts` — 8-category estimator
  - `calculateBreakdown(spawn: SpawnConfig, liveTotalTokens: number): Promise<BreakdownResult>`
  - 8 categories in canonical order: `system_preset`, `builtin_tools`, `mcp_servers`, `skills_index`, `claudemd_chain`, `subagents`, `hooks_memory`, `history`
  - History clamped at `Math.max(0, liveTotal - sum(other 7))` — never negative
  - Token weight constants exported for downstream tests
- `router/src/services/contextInspector/breakdown.spec.ts` — 6 tests, all pass

## Token-per-category baseline values (RESEARCH.md section 1)

| Category | Constant | Tokens | Notes |
|---|---|---|---|
| system_preset | `SYSTEM_PRESET_TOKENS` | 4000 | Claude Code preset (excludeDynamicSections=true) |
| builtin_tools | `BUILTIN_TOOLS_TOKENS` | 6500 | Read/Write/Edit/Bash/Grep/Glob/Task/Agent/WebFetch/WebSearch/TodoWrite |
| mcp_servers | `MCP_AVG_TOKENS_PER_SERVER` × N | 1000 × loaded | small=400, medium=1200, large=3000 → avg 1000 |
| skills_index | `SKILLS_INDEX_DEFAULT_TOKENS` | 3000 | jarvis-marketplace + user + plugin + gsd:* (~2.5k alone) |
| subagents | `SUBAGENTS_INDEX_TOKENS` | 1000 | 18 GSD × ~50 tokens index |
| hooks_memory | `HOOKS_MEMORY_AVG_TOKENS` | 800 | OMEGA inject midpoint |
| claudemd_chain | dynamic | sum of resolved entries | bytes / 4 per entry |
| history | dynamic | `liveTotal - sum(7)` | clamped at 0 |

## 8-category canonical order (Plan 05 + UI must respect this)

1. `system_preset`
2. `builtin_tools`
3. `mcp_servers`
4. `skills_index`
5. `claudemd_chain`
6. `subagents`
7. `hooks_memory`
8. `history`

## @-import resolution semantics

| Syntax | Resolution |
|--------|------------|
| `@~/foo.md` | `$HOME/foo.md` (tilde expansion) |
| `@/abs/path.md` | absolute pass-through |
| `@./rel.md` or `@rel.md` | resolved against `dirname(currentFile)` |

Cycle detection: each absolute path visited at most once via `Set<string>`.
Missing files: silently recorded in `result.missing[]` (does NOT throw).

## Test results

12 tests passing across `claudeMdChain.spec.ts` (6) + `breakdown.spec.ts` (6).

Notable test coverage:
- `jarvis fullAccess` produces MCP category 10k-16k tokens with 13 server entries
- `cecilia` (inheritUserScope=false, no MCP) produces 0 tokens for MCP/subagents/hooks/skills
- History clamps at 0 when `liveTotal < sum(other 7)`
- Categories returned in exact canonical order

## Commits

- `58bb9db` feat(01-03): aggiungi resolver @-import per chain CLAUDE.md
- `2f97394` feat(01-03): aggiungi stima breakdown 8-categorie

## Notes

- Imports types from `./types.js` (Wave 0). Imports `expandClaudeMdChain` from `./claudeMdChain.js` (same plan).
- Plan 05 wires this into `GET /api/sessions/:id/breakdown` endpoint.
- TypeScript compilation: zero errors mentioning `breakdown.ts` or `claudeMdChain.ts` (pre-existing errors in unrelated `dashboard/api.ts` notch modules — not introduced by this plan).
