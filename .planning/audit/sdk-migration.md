# SDK migration audit — `claude --print` → `@anthropic-ai/claude-agent-sdk`

Date: 2026-04-26
SDK version verified: `0.2.119`
CLI binary current: `@anthropic-ai/claude-code@^2.1.92`

---

## 1. Why migrate (experimental evidence)

Same prompt, same model (`claude-opus-4-7`), same `settingSources`, same auth (subscription):

| Integration | Tool chosen | `run_in_background` | Time |
|---|---|---|---|
| Router (CLI `--print`) | `Task` | **false** | 443s sync |
| SDK (`query()` standalone) | `Agent` | **true** | 765s bg |

The `--print` mode biases the model toward sync because it interprets the operational context as "non-interactive single-shot". The SDK presents itself as a persistent multi-turn integration, and the model picks bg consistently for long work.

**Other gains** (secondary, not the trigger):
- `query()` returns an `AsyncIterable` of typed events — no NDJSON parsing
- `hooks` API exposes `PreToolUse` / `PostToolUse` / `Stop` programmatically (we currently can't intercept these)
- Output schema validation via `outputFormat: { type: 'json_schema', schema }`
- File checkpointing built-in (`enableFileCheckpointing` + `Query.rewindFiles()`)
- `maxBudgetUsd`, `taskBudget`, `agentProgressSummaries` first-class
- `interrupt()` on the `Query` handle for clean cancellation
- The SDK auto-loads `cli.js` via `process.execPath`, no external `claude` binary required at runtime

**Cost model**: identical. SDK uses the same auth as the local CLI (`CLAUDE_CODE_OAUTH_TOKEN` env, OAuth login, or API key — whatever the binary already resolves). No subscription change needed.

---

## 2. Flag-by-flag mapping

Source: `router/src/services/claude.ts` `buildSpawnArgs()` lines 285-366.

| Current CLI flag | SDK option | Notes |
|---|---|---|
| `--print` | (implicit in `query()`) | Removed — SDK is always headless-ish |
| `--permission-mode <mode>` | `permissionMode: PermissionMode` | Same enum (`acceptEdits` / `bypassPermissions` / `default` / `plan` / `dontAsk`) |
| `--model <id>` | `model: string` | Same |
| `--setting-sources user,project,local` | `settingSources: SettingSource[]` | Array form. Pass `[]` for SDK isolation |
| `--exclude-dynamic-system-prompt-sections` | `systemPrompt: { type: 'preset', preset: 'claude_code', excludeDynamicSections: true }` | Now a property of the preset prompt config |
| `--verbose --input-format stream-json --output-format stream-json` | (implicit) | `query()` always streams events; no flag needed |
| `--output-format json` (fresh) | (handled by collecting until `result` event) | `askClaudeFresh` consumes the iterator until `type === "result"` |
| `--effort <level>` | `effort: EffortLevel` | Same enum |
| `--mcp-config <json>` | `mcpServers: Record<string, McpServerConfig>` | Inline object instead of JSON arg |
| `--strict-mcp-config` | `strictMcpConfig: true` | Same semantics |
| `--disallowed-tools "Write Edit ..."` | `disallowedTools: string[]` | Array form |
| `--append-system-prompt <s>` (subagents) | `systemPrompt: { type: 'preset', preset: 'claude_code', append: SUBAGENT_SYSTEM_PROMPT }` | Append goes into the preset object |
| `bypassPermissions` mode | `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true` | **NEW required pairing** — SDK refuses bypass without this safety flag |

**Flags we don't currently use but are now first-class options**:
- `fallbackModel` — replaces our manual `agent.fallbacks` loop in `askClaudeInternal`
- `maxTurns` — bounded conversation
- `maxBudgetUsd` — hard $ cap per query
- `hooks` — programmatic hook callbacks (PreToolUse/PostToolUse/etc)
- `forkSession` / `resume` / `sessionId` / `continue` — session management
- `persistSession: false` — for cron one-shots that shouldn't pollute `~/.claude/projects/`
- `includeHookEvents`, `includePartialMessages` — finer-grained event stream
- `agentProgressSummaries` — periodic ~30s present-tense summary events from running subagents
- `enableFileCheckpointing` + `Query.rewindFiles()` — undo-stack for tool edits

---

## 3. Stream parsing — current vs SDK

### Current (NDJSON via stdout)

`spawnPersistentProcess` (claude.ts:512-741) uses `readline` on `proc.stdout` and `JSON.parse` per line. Event handling:

1. `event.type === "result"` → resolve pendingResolve, extract `result`, `duration_ms`, `duration_api_ms`, `usage`, `total_cost_usd`
2. `event.type === "assistant"` → walk `event.message.content` (or fallback `event.content`), capture:
   - `tool_use` blocks where `name in {Bash, Task, Agent}` and `input.run_in_background === true` → record in `bgToolUseStarts` Map
   - `tool_use` blocks for `Write` / `Edit` → push `input.file_path` into `pendingFiles`
3. `event.type === "system"` (init) + `event.message?.model` → set `pp.resolvedModel`
4. `extractTaskNotificationFromEvent(event)` → handle `<task-notification>` envelope → `handleTaskNotification`
5. stderr buffer scan for `rate_limit` / `429` / `overloaded` → reject with `RATE_LIMIT`

### SDK (`AsyncIterable<SDKMessage>`)

Same event types, typed instead of `JSON.parse`. Key SDK message types:
- `SDKAssistantMessage` — `{ type: "assistant", uuid, message: { role, content, model, ... } }`
- `SDKResultMessage` — `{ type: "result", subtype, result, duration_ms, duration_api_ms, usage, total_cost_usd, num_turns, ... }`
- `SDKSystemMessage` — `{ type: "system", subtype: "init" | "task_notification" | ..., ... }`
- `SDKUserMessage` — synthetic user messages (where `<task-notification>` arrives)
- `SDKPartialAssistantMessage` — only when `includePartialMessages: true`

**Migration is mechanical**: replace `rl.on("line", line => { const event = JSON.parse(line); ... })` with `for await (const ev of q) { ... }`. The shape of `ev` matches what we already parse.

**Critical**: `extractTaskNotificationFromEvent` already handles both `event.type === "system"` (sparse) and `event.type === "user"` (rich). This logic transfers verbatim — the SDK emits the same message envelopes, just typed.

---

## 4. Persistent multi-turn sessions

This is the **highest-risk** part of the migration because the SDK's session model differs from "stdin-write-loop on a long-lived child".

### Current model

We spawn `claude --print --input-format stream-json` once per `sessionKey`, keep stdin open, write `{"type":"user","message":{...}}\n` per turn. Each turn produces a `result` event, then the process waits for next stdin. Handles:
- per-session conversation history (maintained server-side by the CLI)
- inactivity timeout (kill process after N minutes)
- max lifetime (kill process after N hours)
- compaction (kill + respawn with summary as first user turn)
- rate-limit early reject (stderr scan)

### SDK options for the same behaviour

The SDK supports two patterns:

#### (a) Re-`query()` per turn with `resume: sessionId`

Each turn is a fresh `query()` call. `query()` returns `Query` which is `AsyncIterable<SDKMessage> & { interrupt, sessionId, ... }`. The first turn returns a `sessionId`; subsequent turns pass `resume: sessionId` to continue.

**Pros**: clean per-turn lifecycle, no "long-lived process" state to manage
**Cons**: each turn spawns a new subprocess (cli.js boot ~200-500ms latency overhead per turn — confirmed by grep'ing `process.execPath` usage)

#### (b) Single long-running `query()` with `prompt: AsyncIterable<SDKUserMessage>`

The `prompt` parameter accepts `string | AsyncIterable<SDKUserMessage>`. We construct an async iterator, push user messages on demand, the SDK's underlying CLI process stays alive consuming our iterator's output.

**Pros**: no per-turn spawn cost, matches our current model 1:1
**Cons**: more complex async coordination (we own the producer side), interrupt semantics need to be tested

**Recommended**: pattern (b) — same behaviour as today, just typed. Use a `PushableAsyncIterable<SDKUserMessage>` (~30 lines of helper code).

```typescript
function makePushable<T>(): { iterable: AsyncIterable<T>; push: (v: T) => void; end: () => void } {
  const queue: T[] = [];
  let resolve: ((v: IteratorResult<T>) => void) | null = null;
  let done = false;
  return {
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(r => {
          if (queue.length) r({ value: queue.shift()!, done: false });
          else if (done) r({ value: undefined as any, done: true });
          else resolve = r;
        }),
      }),
    },
    push: (v) => { if (resolve) { resolve({ value: v, done: false }); resolve = null; } else queue.push(v); },
    end: () => { done = true; if (resolve) resolve({ value: undefined as any, done: true }); },
  };
}
```

### Compaction in SDK

Our compaction kills the process and respawns. With the SDK we can do better:
- **Option A (1:1 port)**: end the iterable, `await query` to drain, then start a new `query()` call with summary prepended as first user message. Same as today.
- **Option B (SDK-native)**: try `forkSession: true` with a custom `sessionId` — but this preserves history, doesn't compact it, so doesn't solve our actual problem. Stick with Option A.

### Cancellation

`query()` returns `Query` which has `interrupt()` — graceful stop signal to the model. Cleaner than our current `proc.kill("SIGTERM")` followed by 3s force-SIGKILL.

---

## 5. Areas needing per-area decisions

### 5.1 Tool list
We pass `tools: string[]` from `agent.tools`. SDK accepts `tools?: string[] | { type: 'preset'; preset: 'claude_code' }`. We currently don't restrict tools positively (only via `--disallowed-tools` for readonly). With SDK we can:
- Continue with full preset + `disallowedTools`, OR
- Pass an explicit allowlist for stricter routes

Recommendation: keep current behaviour for parity. Pass `tools: { type: 'preset', preset: 'claude_code' }` + `disallowedTools` when readonly. Migrate to allowlist later as a follow-up.

### 5.2 MCP injection
Currently we serialize `mcpServers` as JSON CLI arg. SDK takes the object directly. Cleaner. **Note**: the SDK's `McpServerConfig` type may differ slightly from what we read in `readMcpServers()` (which reads from `~/.claude/.mcp.json`). Spike needed to confirm shape compatibility.

### 5.3 Notify token / env injection
Today we inject `JARVIS_NOTIFY_TOKEN`, `JARVIS_NOTIFY_CHANNEL`, etc. via `env` arg of `spawn()`. SDK has `env?: { [k: string]: string | undefined }` option — same mechanism, cleaner API. No behaviour change.

### 5.4 Workspace cwd
Today: `spawn(cli, args, { cwd: workspace })`. SDK: `cwd?: string` option. 1:1.

### 5.5 Rate-limit detection
Today: scan stderr buffer. SDK: provides a typed `stderr?: (data: string) => void` callback. Same mechanism, slightly cleaner. Keep the regex but move into the callback.

### 5.6 Process exit / death
Today: `proc.on("close", ...)` and `proc.on("error", ...)` reject pendingReject and clean up timers. SDK: the iterator throws on process error and ends naturally on success. Wrap in `try/catch` around the `for await` loop.

### 5.7 Hooks
We **don't currently use programmatic hooks**. The SDK exposes `PreToolUse` / `PostToolUse` / `Stop` / `SessionStart` / `Setup` etc. as JS callbacks. Future opportunity (tool-call instrumentation, audit trail, custom permission UI) but **not a migration requirement**.

### 5.8 fullAccess routes
Today: bypassPermissions + all MCP servers + no disallowed list. SDK: `permissionMode: 'bypassPermissions'` **requires** `allowDangerouslySkipPermissions: true` paired. New required addition — easy to forget, document in `buildSpawnArgs` replacement.

### 5.9 stdin file/image content
Today we construct `{ type: "user", message: { role: "user", content: [...image/text...] } }` and `stdin.write()`. SDK's `SDKUserMessage` shape is identical (it's literally the same envelope). 1:1 port.

---

## 6. Risks and unknowns

### High
1. **Pattern (b) async iterable consumption** — the SDK's behaviour with a long-lived async iterable producer needs empirical validation:
   - Does it truly multiplex turns over a single subprocess?
   - Does inactivity on the producer cause the CLI to time out or stay alive?
   - Does `query.interrupt()` cleanly stop the active turn without ending the subprocess?
   - **Mitigation**: 1-day spike with a minimal multi-turn script before committing

2. **Session resumption format** — if pattern (a) ends up needed, `resume: sessionId` reads from `~/.claude/projects/<project-hash>/<sessionId>.jsonl`. Need to verify our session keys map cleanly to SDK session IDs (UUIDs).

### Medium
3. **MCP config shape** — `readMcpServers()` reads `~/.claude/.mcp.json` raw. SDK's `McpServerConfig` is a typed union (stdio / sse / http). May need a shape adapter.

4. **Cron `askClaudeFresh` flow** — currently a separate code path (`streaming: false`). With SDK both flows use `query()`; just consume until `result` and unsubscribe. Slightly different control flow in `cron.ts` callers — they expect a Promise<result>, easy to keep.

5. **`exclude-dynamic-system-prompt-sections` semantics** — the flag and the SDK option both move dynamic context into the first user message. Need to verify our `buildContextFromCache()` injection still composes cleanly (we already inject context as first user turn; double-injection or order conflict possible).

### Low
6. **Subagent `--append-system-prompt`** — moving from CLI flag to `systemPrompt.append` is purely syntactic.

7. **`--exclude-dynamic-system-prompt-sections` flag still exists in current CLI** — if we keep both code paths during migration (feature flag), we need to ensure both branches behave identically.

---

## 7. Migration plan (phased)

### Phase 0 — spike (4-6h)
- Standalone script in `router/scripts/` that reproduces our persistent-process behaviour (pattern b) with the SDK
- Verify: multi-turn over single subprocess, interrupt, error propagation, MCP injection, env vars
- Output: confirmed `query()` lifecycle pattern + any required helpers (`PushableAsyncIterable`)

### Phase 1 — adapter layer (1 day)
- New file `services/claude-sdk.ts` — implements the same public API as `claude.ts` (`askClaude`, `askClaudeFresh`, `sessionKey`, `killAllProcesses`) but using SDK
- Keep `claude.ts` untouched
- Add a config flag `claude.useSdk: boolean` (default false) in `config.yaml` that selects the implementation
- Both code paths coexist; can flip per-deployment

### Phase 2 — feature parity verification (1 day)
- Run both implementations side-by-side in dev
- Verify each capability: streaming response, tool tracking, file pendingFiles, task-notification handling, compaction, rate-limit reject, fallback model, env injection, MCP filtering, fileAccess:readonly, fullAccess
- Test each connector (telegram, discord, whatsapp, slash, cron) under both impls
- Regression checklist: see §8

### Phase 3 — cutover (2h)
- Flip default `useSdk: true` in deployed config
- Monitor logs for 48h
- Keep `claude.ts` checked in for one release as fallback
- After 1 week stable, delete `claude.ts` and the config flag

### Phase 4 — capability extensions (optional, weeks-later)
- Programmatic hooks for tool-call audit trail
- `agentProgressSummaries` for live "thinking" indicators
- `maxBudgetUsd` per-route cost caps
- `enableFileCheckpointing` + `rewindFiles` for undo
- `outputFormat: json_schema` for structured connector responses

---

## 8. Regression checklist (Phase 2 acceptance)

Each item must pass with `useSdk: true`:

- [ ] Multi-turn conversation on Telegram preserves history
- [ ] First-message context injection from `buildContextFromCache()` still fires
- [ ] Image messages from WhatsApp arrive as `SDKUserMessage` content blocks
- [ ] `--exclude-dynamic-system-prompt-sections` equivalent doesn't double-inject our context cache
- [ ] Subagent system prompt (`SUBAGENT_SYSTEM_PROMPT`) is appended via `systemPrompt.append`
- [ ] `fullAccess: true` route can use all MCP servers (e.g. `mcp__brave-search__*`)
- [ ] `fileAccess:readonly` route blocks Write/Edit/NotebookEdit/Bash(rm/mv)
- [ ] `--strict-mcp-config` equivalent (`strictMcpConfig: true`) prevents user-scope MCP leak
- [ ] Rate-limit detected on Anthropic 429/overloaded → fallback model triggers within 10s
- [ ] Process death (kill -9 mid-turn) rejects pendingReject within 1s, doesn't hang
- [ ] Inactivity timeout still kills the session after `INACTIVITY_TIMEOUT_MS`
- [ ] Compaction at 80% context window: summary captured, process respawned, conversation continues coherently
- [ ] `<task-notification>` envelope delivered child message with full footer (kind, tokens, output bytes)
- [ ] Bg task started in router/services/* completes and notifies origin channel
- [ ] `askClaudeFresh` (cron path) returns `{ result, sessionId, usage, costUsd }` matching current shape
- [ ] `bgToolUseStarts` Map fills correctly when SDK emits `Agent run_in_background:true` tool_use
- [ ] Cost / token tracking unchanged (same usage values reach `trackUsage`)
- [ ] `notifyToken` env vars reach the SDK process (`process.env.JARVIS_NOTIFY_*`)
- [ ] `notify.sh` hook script still fires (verify `~/.claude/notify.sh` invocation parity with CLI mode)
- [ ] Dashboard `session.compacted` and `notify.outbound` broadcasts still emit
- [ ] Graceful shutdown (SIGINT/SIGTERM) drains in-flight turns before killing

---

## 9. Effort estimate

| Phase | Effort | Risk |
|---|---|---|
| 0 — spike | 4-6h | low |
| 1 — adapter | 6-8h | medium |
| 2 — parity testing | 6-8h | medium-high (integration) |
| 3 — cutover | 1-2h | low (feature flag) |
| **Total to production parity** | **2-3 days** | |
| 4 — capability extensions | weeks (optional) | low |

The 2-3 day estimate assumes pattern (b) works as expected in spike. If pattern (a) is required instead, add 4-6h to Phase 1 for per-turn session management, but the SDK handles `resume` natively so the increment is small.

---

## 10. Open questions for the spike

1. With pattern (b), what happens when our async iterable yields no message for >N seconds? Does the SDK's underlying CLI subprocess time out? Document the actual timeout and adjust `INACTIVITY_TIMEOUT_MS` accordingly.
2. Does `query.interrupt()` cleanly end the iterator on the consumer side, or do we need to also `end()` our async iterable producer?
3. Is `pathToClaudeCodeExecutable` necessary (we currently `resolveCliPath()`) or does the bundled cli.js work as-is?
4. How does `mcpServers` interact with `strictMcpConfig: true`? Confirm user-scope `.mcp.json` is fully ignored (not just lower-priority).
5. With `permissionMode: 'bypassPermissions' + allowDangerouslySkipPermissions: true`, is there ANY prompt or just silent allow?
6. Token usage: confirm `SDKResultMessage.usage` includes `cache_creation_input_tokens` and `cache_read_input_tokens` in the same shape as today's NDJSON.

---

## 11. Recommendation

**Proceed with Phase 0 (spike)**. It's the cheapest information we can buy: 4-6h of work answers the high-risk unknowns and validates the 2-3 day total estimate. If the spike surfaces unexpected issues with pattern (b), we either solve them or fall back to pattern (a) with confidence about the increment.

Do **not** start Phase 1 before the spike validates pattern (b) — porting the whole adapter against the wrong assumption is the worst outcome.
