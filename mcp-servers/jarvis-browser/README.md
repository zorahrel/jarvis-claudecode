# jarvis-browser

Local **parallel, isolated, token-careful** browser sessions for Jarvis.

One long-lived daemon owns the whole Chromium fleet and hands out browser
sessions to N concurrent callers (Claude agents via the MCP, or the `jbrowser`
CLI). Different session **names never share state and run in parallel**; the same
name reuses one warm, logged-in browser. Raw Playwright — **no Docker, no cloud,
no API key, data never leaves the Mac.**

## Why this exists

The other browser tools each miss the parallel-isolated case:

| Tool | Gap for "N parallel isolated sessions" |
|---|---|
| `claude-in-chrome` | drives the user's **real** Chrome → agents collide |
| `chrome-devtools-mcp` | single persistent profile → only one logged-in session |
| `browser-learn` (Stagehand) | one-shot act/extract, no live persistent session |
| `firecrawl` | static scrape, no interaction |

`jarvis-browser` fills exactly that gap: many isolated, persistent, interactive
sessions at once, with compact output that stays cheap on tokens.

## Architecture

```
 Claude agent ─┐                         ┌─ session "tg-123"  → persistent profile (own process, durable login)
 Claude agent ─┤── MCP front (mcp.mjs) ──┤─ session "wa-456"  → persistent profile (own process)
 jbrowser CLI ─┘     │ auto-spawns       └─ session "scrape"  → ephemeral context (shared hub, lightest)
                     ▼
              daemon.mjs  (one process, http://127.0.0.1:3344)
              · name→session map · keyed locks · idle reaper · concurrency cap · graceful close-all
```

- **Isolation**: persistent session = `launchPersistentContext(<profile dir>)` (own
  process + user-data-dir → durable login, full isolation). Ephemeral session =
  `newContext()` in one shared Chromium (cheapest, fully isolated, no login).
- **Token discipline**: every read is a compact ref-based a11y snapshot
  (`[3] button "Sign in"`), **incremental by default** (only what changed).
  Screenshots are saved to disk and returned as a **path** (never inlined — read
  with `moondream <path>`). No raw DOM, no second LLM in the loop.
- **Reliability**: per-session keyed lock (no self-races), TOCTOU-safe creation
  (concurrent same-name calls share one session via a `ready` promise — no
  orphans, no SingletonLock collision), idle-TTL reaper, global concurrency cap,
  `disconnected` pruning, graceful close-all on signals, single instance guarded
  by the listen port, launchd crash-restart with persistent-profile survival.
- **Security**: the daemon drives untrusted web pages that can reach 127.0.0.1,
  so the `/rpc` control plane rejects browser-originated requests (any
  `Origin`/`Referer`/`Sec-Fetch-Site`), requires `application/json`, and pins the
  `Host` to localhost (anti DNS-rebinding). `navigate` is scheme-allowlisted
  (http/https/about/data); `eval` runs only in the page sandbox.

## CLI

```bash
jbrowser nav    work https://news.ycombinator.com   # isolated session "work"
jbrowser snap   work                                 # incremental snapshot
jbrowser click  work 3
jbrowser fill   work 1 "hello"
jbrowser press  work Enter
jbrowser extract work '{"titles":{"selector":".titleline a","all":true}}'
jbrowser shot   work --full        # → /path/to/png
jbrowser read   work "is there a captcha?"   # SEE the screen via moondream → text (no image in context)
jbrowser status                    # live sessions
jbrowser close  work               # or: jbrowser close-all
```
`--ephemeral` = throwaway context (no persistent login). `--headed` = visible window.

## MCP tools

Registered as `jarvis-browser` in `~/.claude.json` (CLI + every router spawn).
Tools are deferred via tool-search, so they cost ~0 baseline context until used:
`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`,
`browser_type`, `browser_press`, `browser_select`, `browser_scroll`,
`browser_get_text`, `browser_extract`, `browser_screenshot`,
`browser_read_screen`, `browser_eval`, `browser_close`, `browser_status`.

**Seeing the screen** (`browser_read_screen` / `jbrowser read`): a screenshot is
captured and read by a **lightweight local vision model** (`moondream` →
Moondream Cloud, ~0.7s) that returns a **text** description/answer — the image is
never loaded into the agent's context. Pass a `question` for a specific query.
Swap the backend with `JARVIS_VISION_CMD` (any `cmd <img> ["question"]` CLI).

`JARVIS_BROWSER_NS` (set per router spawn) namespaces every session so concurrent
agents never collide by accident.

## Config (env)

| var | default | meaning |
|---|---|---|
| `JARVIS_BROWSER_PORT` | 3344 | daemon port |
| `JARVIS_BROWSER_MAX` | 6 | max concurrent live sessions |
| `JARVIS_BROWSER_IDLE_MS` | 600000 | idle session reaping (10 min) |
| `JARVIS_BROWSER_ACTION_TIMEOUT` | 15000 | per-action timeout |

## Ops

- Daemon auto-starts on first use. Always-on via launchd:
  `launchctl kickstart -k gui/$(id -u)/com.jarvis.browser`
- Test: `node test/parallel-iso.mjs` (isolation + parallelism + lifecycle),
  `node test/mcp-smoke.mjs` (MCP front).

## When NOT to use

- Static scrape with no interaction → `firecrawl`.
- A web action you'll repeat many times → `browser-learn` (0-token cached replay).
- DevTools / CLS / network / perf deep-dive → `chrome-devtools-mcp`.
- Acting in the user's *real* logged-in Chrome → `claude-in-chrome`.
- Public-site scraping needing stealth/residential proxies → a cloud session
  (Browserbase/Steel), opt-in only — never for authenticated/personal data.
