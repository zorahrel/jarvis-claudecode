---
status: partial
phase: 02-orchestrator-multi-session
source: [02-VERIFICATION.md]
started: 2026-05-10T13:35:00Z
updated: 2026-05-10T13:35:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Apple Reminders bidirectional iCloud sync (round-trip)
expected: POST /api/todos creates a todo → appears on iPhone Reminders app under list `Jarvis/ActiveTasks` within 15s; user checks it off on iPhone → `/api/todos` shows it gone within 8s (3s polling + iCloud lag).
how-to: (1) `curl -X POST -H 'content-type: application/json' -d '{"title":"UAT roundtrip"}' localhost:3340/api/todos` → (2) wait 15s → (3) check iPhone Reminders `Jarvis/ActiveTasks` list shows "UAT roundtrip" → (4) tap to complete on iPhone → (5) wait 8s → (6) `curl -s localhost:3340/api/todos | jq '.todos[] | select(.title=="UAT roundtrip")'` returns empty.
result: [pending]

### 2. Notch HUD visual rendering
expected: Notch in expanded mode shows (a) right-peek sidebar with active session badges (5 colors per status), (b) top/bottom thin strip with top-3 open todos. Tap todo = mark complete; long-press todo = session picker appears.
how-to: (1) `bash tray-app/make-app.sh && open tray-app/build/JarvisTray.app` → (2) start 2-3 Claude sessions under tmux → (3) expand notch → (4) verify sidebar shows live sessions with colored badges → (5) verify top-3 todo strip visible → (6) tap a todo → it disappears (completed) → (7) long-press a todo → picker with active pids opens.
result: [pending]

### 3. Notch reconnect-replay across router restart
expected: When the router process is killed and relaunched, the notch UI does not flash to empty — `lastSessionsPayload` is replayed on resubscribe.
how-to: (1) Notch open with active sessions visible → (2) `launchctl kickstart -k gui/$(id -u)/com.jarvis.router` → (3) observe notch UI for 5s → (4) sessions list should NOT flash empty before repopulating; reconnect should be visually seamless.
result: [pending]

### 4. Skill `/orchestrator` slash invocation in Claude Code
expected: In an interactive `claude` CLI session (NOT this orchestrator session), typing `/orchestrator` produces an Italian summary line followed by a JSON code block listing live sessions.
how-to: (1) Open new terminal → `claude` (fresh interactive session) → (2) type `/orchestrator` and press Enter → (3) verify response = Italian one-line summary (e.g. "3 sessioni attive: 1 in attesa, 2 working") + JSON code block with `pid`, `repo`, `status`, `suggestion`, `action` fields per session.
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps

(none yet — pending human execution)

## Notes

- Auto-pilot mode (Plan 02-05, ORC-20..22) is INTENTIONALLY DEFERRED behind a manual gate ≥1 week of stability data. NOT a UAT gap.
- Programmatic verification (level 1-4) PASSED in 02-VERIFICATION.md: 19/22 ORC requirements satisfied + 3/22 deferred by design; all 7/8 verifiable success criteria green; criterion 6 (auto-pilot) deferred.
- Live `tmux send-keys` end-to-end + audit log rotation + Reminders POST/list/complete round-trip via curl already verified during execution (see 02-02-SUMMARY.md and 02-04-SUMMARY.md "Live Verification Evidence" sections).
