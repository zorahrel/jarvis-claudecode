# Plan 01-07 — Polling Hook + Routing — SUMMARY

**Status:** COMPLETE
**Wave:** 3
**Date:** 2026-05-01
**Self-Check:** PASSED

## Objective achieved

5s polling for the Context tab with all memory-leak guards (CTX-13). Context tab reachable from the dashboard nav as a first-class page (`#/context`).

## Hook API

```typescript
useContextPolling(intervalMs: number = 5000): {
  data: ContextSessionsResponse | null
  cruft: CruftResponse | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  lastFetchedAt: number | null
}
```

## Memory-leak guards (4 mechanisms)

1. **clearInterval on unmount** — `return () => window.clearInterval(id)` in the `useEffect` cleanup
2. **Visibility-aware pause** — `if (document.hidden) return` skips fetch when tab is in background
3. **Race-id guard** — `requestIdRef` increments per request; late responses with stale id are discarded
4. **Mount guard** — `mountedRef` flag prevents state updates on unmounted components (avoids React warnings)

Last good data is preserved when an individual fetch fails — error displayed inline ("ultimo fetch fallito: ...") but `data` and `cruft` keep their previous values.

## Files created (2 new)

- `router/dashboard/src/hooks/useContextPolling.ts` — the polling hook
- `router/dashboard/src/pages/Context.tsx` — page wrapper (renders `<ContextTab />`)

## Files modified (3)

- `router/dashboard/src/components/ContextTab.tsx` — refactored: removed `useState` + `useEffect` + inline `fetchAll`; uses `useContextPolling(5000)` hook; added freshness indicator "aggiornato Xs fa"
- `router/dashboard/src/components/Sidebar.tsx` — added nav entry `{ id: 'context', label: 'Context', hint: 'Token usage, breakdown and cruft detection per Claude session' }` between Sessions and Analytics
- `router/dashboard/src/App.tsx` — added `import { Context } from './pages/Context'` + `case 'context': return <Context onToast={addToast} />` in the switch

## Sidebar/App.tsx integration pattern

The dashboard uses a hash-based router (no react-router) where:
- `App.tsx` reads `window.location.hash` → maps to `page` state
- `Sidebar.tsx` exports `navItems` array of `{ id, label, hint }`
- Clicking a nav entry sets `window.location.hash = id`
- App switches on `page` to render the matching `<PageComponent onToast={addToast} />`

To add a new tab: add an entry to `navItems`, add an import + a `case` in App.tsx. That's the entire contract.

## Hand-off to Plan 08

Plan 08 must:
1. Run `cd router/dashboard && npm install` (deps not yet installed in jarvis-ci worktree)
2. Run `cd router/dashboard && npm run build` — produces `router/dashboard/dist/` consumed by the router static server
3. Verify dashboard build succeeds with zero TypeScript errors related to context/* files
4. Restart router via `launchctl kickstart -k gui/$(id -u)/com.jarvis.router` — **AVVISARE utente** di query attive prima del kickstart (memoria utente: feedback_router_restart_inflight)
5. UAT manual checklist:
   - Open `localhost:3340` → click "Context" in sidebar → tab loads
   - Verify aggregate header shows numbers (`N sessioni`, `XXk token`, `$X.XXXX`)
   - Verify at least 1 session row with colored progress bar
   - Click a session row → verify breakdown stacked bar renders 8 segments
   - For at least one router-spawned session: cost is non-zero, sessionKey is non-null (proves BLOCKER 1 + MAJOR 5)
   - Verify cruft panel shows at least 1 agent (or "Nessun cruft" message)
   - Verify storico recente shows last 10 sessions
   - Verify disco footer shows ~986 MB / ~2012 JSONL (live numbers)
   - Heap snapshot: leave tab open 10 min, take Chrome DevTools heap snapshot before/after, verify retained delta < 5 MB
   - Switch to another tab → verify polling pauses (no network calls in DevTools Network panel for >5s when document.hidden)

## Commits

- `<task1>` feat(01-07): hook useContextPolling 5s + refactor ContextTab senza useState/useEffect
- `<task2>` feat(01-07): route /context + entry Sidebar (tra Sessions e Analytics)

## Notes

- The hook uses `window.setInterval` (not `setTimeout` recursion) — simpler and the `requestIdRef` pattern handles overlapping requests cleanly.
- `Context.tsx` page wrapper accepts `onToast` prop for consistency but doesn't use it (no toast-worthy events in the polling cycle yet — could be added in v2 if user requests).
- The freshness indicator ("aggiornato Xs fa") in the header gives the user a real-time signal that polling is working.
