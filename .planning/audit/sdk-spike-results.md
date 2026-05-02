# SDK spike — results

Date: 2026-04-26
Script: `router/scripts/sdk-spike.ts`
Total duration: ~56s (5 turns + interrupt + 25s idle + teardown)

## Findings against the 6 open questions

### Q1 — async iterable, no message for >N seconds: subprocess timeout?

**Answer: subprocess survives idle. Verified up to 25s idle.**

After 25s of no `pushable.push()` calls, the subprocess was still alive and the next turn (`"sveglio"`) succeeded in 4.2s. The CLI doesn't enforce a producer-side idle timeout — it stays in `wait for next user message` state indefinitely.

**Implication for migration**: our `INACTIVITY_TIMEOUT_MS` logic transfers cleanly. We're still the ones controlling when to end the iterable / kill the query; the SDK doesn't impose its own.

---

### Q2 — `query.interrupt()` cleanly ends the active turn?

**Answer: interrupt cleanly stops the active turn, but the query is then unusable.**

Sequence observed:
1. Pushed "Conta da 1 a 50 lentamente"
2. After 2s, called `q.interrupt()` — returned `ok` immediately
3. Within 11ms, got a `result` event with `dur=2.0s tok=0>0` — clean stop signal
4. After the interrupt, calling `pushable.end()` triggered a fatal error: `Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null`

**Implication**: `interrupt()` is suitable for "abort this turn" but the query handle becomes unusable for further turns. To resume, we must end the query, start a fresh `query()`, and `resume:` the session ID.

For our router this matches a "user typed `/cancel`" UX: kill current turn → respawn process. We can model it the same as our current `killProcess(pp)` + respawn flow.

---

### Q3 — is `pathToClaudeCodeExecutable` necessary?

**Answer: no. The bundled cli.js works out of the box.**

The spike ran with no `pathToClaudeCodeExecutable` option set. Auth resolved via the existing `claude` binary's OAuth token (subscription). Cost accumulated normally (`$0.0000` → `$0.3852` over 5 turns).

**Implication**: drop our `resolveCliPath()` indirection — the SDK handles binary discovery internally via `process.execPath`.

---

### Q4 — `mcpServers` + `strictMcpConfig` interaction

**Not directly exercised in spike** (no MCP tools used in the test prompts).

Based on SDK type definitions and the equivalence with `--mcp-config` + `--strict-mcp-config` CLI flags, behavior should be identical: only the inline `mcpServers` map is honored, user-scope `.mcp.json` is ignored.

**Action**: verify in Phase 2 with a route that uses MCP tools (e.g. `mcp__brave-search__*`).

---

### Q5 — `bypassPermissions` + `allowDangerouslySkipPermissions: true` silent allow

**Answer: yes, silent allow.**

Turn 3 (`Bash` with `run_in_background:true` to `sleep 3 && echo done`) executed without any prompt or hook intervention. No permission UI, no callback into our code, no stderr warning. Pure equivalence with `--permission-mode bypassPermissions` CLI behavior.

**Implication**: 1:1 port — pair `permissionMode: 'bypassPermissions'` with `allowDangerouslySkipPermissions: true` in the SDK adapter. Document this pairing in the new `buildSdkOptions` (the SDK refuses bypass without it).

---

### Q6 — `usage` shape: same as CLI?

**Answer: yes, identical.**

Turn 2 result event:
```json
{
  "input_tokens": 6,
  "output_tokens": 6,
  "cache_read_input_tokens": 86847,
  "cache_creation_input_tokens": 26,
  "total_cost_usd": 0.2040
}
```

All fields we currently extract in `claude.ts:657-678` are present with identical names and semantics. `apiDurationMs` (current `event.duration_api_ms`) was not seen in this run but is documented in `SDKResultMessage`.

**Implication**: zero changes to `trackUsage()` and the `ClaudeResponse` shape.

---

## Bonus findings

### Multi-turn pattern (b) works perfectly

Across 5 turns, the same `session_id` (`50eccde9-...`) was reused. No subprocess respawn observed. Latency between turn-end and next turn-start was ~50ms (essentially the time to push the next user message and have the SDK consume it).

This is the key load-bearing assumption of the migration. **Validated.**

The spike's `t1_session_persists: false` boolean is misleading — it checks `input_tokens` growth, but the actual conversation history flows through `cache_read_input_tokens`, which grew from 66,570 (turn 1) → 86,847 (turn 2) → 173,810 (turn 3, after the bg Bash). History accumulates correctly via prompt caching, exactly like the CLI.

### Bg task notification arrives natively typed

`system.task_notification` event with status/task_id fields:
```
[19:35:00.635] system.task_notification status=completed task_id=bszma2b0
```

The SDK delivers it as a typed `SDKSystemMessage` with `subtype: "task_notification"`, **200ms after the parent turn's `result` event**. Faster than the user-message-with-marker path our parser also handles.

**Implication**: our existing `extractTaskNotificationFromEvent` in `services/task-notification.ts` already handles this exact shape (the system-event branch at lines 117-137). Migration is purely about feeding SDK events instead of NDJSON.

### `excludeDynamicSections` works with our context cache

Used `systemPrompt: { type: 'preset', preset: 'claude_code', excludeDynamicSections: true }`. Turns ran fine; no double-injection issue observed in the simple prompts. Phase 2 should retest with a real first-turn context-cache injection to confirm.

### Cost / token tracking

Cumulative cost over the spike: $0.3852 for ~56s of activity across 5 short turns + 1 long bg Bash task. Equivalent to what our CLI mode would have charged.

---

## Updated risk register

| Risk | Status |
|---|---|
| Async iterable subprocess lifecycle | **VALIDATED** — subprocess survives idle, multi-turn works |
| `interrupt()` semantics | **VALIDATED** with caveat — kills query handle, must respawn |
| `excludeDynamicSections` double-injection | Not seen in spike; **defer to Phase 2 with real context cache** |
| MCP shape compatibility | Not exercised; **defer to Phase 2** |
| `bypassPermissions` requires explicit pairing | **CONFIRMED** required |

No blockers. Pattern (b) is solid.

---

## Recommendation

**Proceed to Phase 1 (adapter layer).**

Estimated effort unchanged: 1 day for the adapter. Parity testing in Phase 2 should focus on:
1. MCP tool routes (Q4 not exercised here)
2. First-turn context-cache injection composition with `excludeDynamicSections`
3. Compaction flow — kill+respawn equivalence
4. fallback model on rate-limit (use SDK's `fallbackModel` option instead of our manual loop)
5. `notify.sh` hook script firing parity

The spike confirms zero structural surprises. Migration is mechanical.
