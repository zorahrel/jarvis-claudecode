#!/usr/bin/env node
/**
 * jarvis-browser MCP front — stdio MCP server that exposes the daemon's
 * parallel-isolated browser sessions to Claude agents. Registered once in
 * ~/.claude.json; available in the CLI and every router spawn. The daemon
 * auto-starts on first tool call, so all agents share one managed fleet.
 *
 * Token discipline (enforced here, not optional):
 *  - snapshots are compact ref-based a11y lists, incremental by default;
 *  - screenshots are saved to disk and returned as a PATH (never inlined —
 *    use the `moondream <path>` CLI to read them if needed);
 *  - prefer: navigate -> read [ref] lines -> act by ref -> minimal re-snapshot.
 *
 * Per-task isolation: pass a distinct `session` name per concurrent task. Same
 * name = same browser (shared cookies, calls serialized); different names never
 * share state and run in parallel. `JARVIS_BROWSER_NS` (set per router spawn)
 * namespaces every session so concurrent agents never collide by accident.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { rpc } from "./lib/client.mjs";

// Auto-namespace per agent: the router sets JARVIS_SESSION_KEY on every spawn,
// inherited by this stdio MCP. So two concurrent agents that both use session
// "main" still get fully isolated browsers (tg-123__main vs wa-456__main) with
// zero coordination. Bare CLI / interactive use has no key → plain names.
const NS = process.env.JARVIS_BROWSER_NS || process.env.JARVIS_SESSION_KEY || "";
const ns = (s) => (NS ? `${NS}__${s || "main"}` : (s || "main"));

const SESSION = { type: "string", description: "Session name. Distinct names are fully isolated (own cookies/profile) and run in parallel; same name reuses the same logged-in browser. Default: 'main'." };

const TOOLS = [
  { name: "browser_navigate", description: "Create/reuse an isolated browser session and navigate to a URL. Returns a compact accessibility snapshot: lines like `[3] button \"Sign in\"`. Use those [ref] numbers with the other tools. Persistent by default (logins survive). Set ephemeral:true for a throwaway isolated context, headed:true to show a window.",
    schema: { type: "object", required: ["url"], properties: { session: SESSION, url: { type: "string" }, ephemeral: { type: "boolean", description: "throwaway context, no persistent login" }, headed: { type: "boolean", description: "visible window (default headless)" }, max: { type: "number", description: "max elements in snapshot (default 200)" } } } },
  { name: "browser_snapshot", description: "Re-read the current page as a compact ref-based a11y snapshot. Incremental by default (only what changed since last snapshot — ~0 tokens when stable). Pass full:true for the complete element list.",
    schema: { type: "object", properties: { session: SESSION, full: { type: "boolean" }, max: { type: "number" } } } },
  { name: "browser_click", description: "Click the element with the given [ref] from the latest snapshot.",
    schema: { type: "object", required: ["ref"], properties: { session: SESSION, ref: { type: "number" } } } },
  { name: "browser_fill", description: "Clear and type text into the input/textarea with the given [ref].",
    schema: { type: "object", required: ["ref", "text"], properties: { session: SESSION, ref: { type: "number" }, text: { type: "string" } } } },
  { name: "browser_type", description: "Type text key-by-key into [ref] (for inputs that need real keystrokes / autocomplete).",
    schema: { type: "object", required: ["ref", "text"], properties: { session: SESSION, ref: { type: "number" }, text: { type: "string" } } } },
  { name: "browser_press", description: "Press a key (e.g. Enter, Tab, Escape, ArrowDown). Optionally target a [ref], else the focused element.",
    schema: { type: "object", required: ["key"], properties: { session: SESSION, key: { type: "string" }, ref: { type: "number" } } } },
  { name: "browser_select", description: "Select an option (by value or label) in a <select> [ref].",
    schema: { type: "object", required: ["ref", "value"], properties: { session: SESSION, ref: { type: "number" }, value: { type: "string" } } } },
  { name: "browser_scroll", description: "Scroll the page vertically by dy pixels (default 600; negative scrolls up).",
    schema: { type: "object", properties: { session: SESSION, dy: { type: "number" } } } },
  { name: "browser_get_text", description: "Return readable page text (innerText, truncated). Pass a [ref] to read just that element. Use to READ content, not to find actionable elements (use browser_snapshot for those).",
    schema: { type: "object", properties: { session: SESSION, ref: { type: "number" }, max: { type: "number" } } } },
  { name: "browser_extract", description: "Deterministically scrape structured data with CSS selectors — 0 LLM tokens. fields example: {\"title\":\"h1\",\"prices\":{\"selector\":\".price\",\"all\":true},\"link\":{\"selector\":\"a.next\",\"attr\":\"href\"}}.",
    schema: { type: "object", required: ["fields"], properties: { session: SESSION, fields: { type: "object", additionalProperties: true } } } },
  { name: "browser_screenshot", description: "Save a screenshot to disk and return its file PATH (pixels are NOT inlined). Use this only when you need the FILE (to save/share). To SEE what's on screen, prefer browser_read_screen (lighter, returns text). fullPage:true for the whole page, or a [ref] for one element.",
    schema: { type: "object", properties: { session: SESSION, fullPage: { type: "boolean" }, ref: { type: "number" } } } },
  { name: "browser_read_screen", description: "SEE the current page via a lightweight vision model (moondream) — returns a TEXT description/answer WITHOUT loading any image into your context (cheap on tokens, and offloads vision from Claude). Pass `question` for a specific query (e.g. \"is there a captcha?\", \"what's the error message?\"), else you get a caption. Use this instead of browser_screenshot when you just need to understand what's rendered (charts, images, canvas, captchas, visual layout the a11y snapshot can't convey).",
    schema: { type: "object", properties: { session: SESSION, question: { type: "string", description: "what to ask about the screen; omit for a general caption" }, ref: { type: "number", description: "read just one element instead of the page" }, fullPage: { type: "boolean" }, long: { type: "boolean", description: "longer caption (ignored if question set)" } } } },
  { name: "browser_eval", description: "Run JavaScript in the page and return the result (escape hatch for what the other tools can't do). Runs in the page sandbox only.",
    schema: { type: "object", required: ["expression"], properties: { session: SESSION, expression: { type: "string", description: "JS body; use `return ...` to return a value" } } } },
  { name: "browser_login", description: "Open a VISIBLE (headed) browser window at a sign-in OR sign-up URL and HAND OFF to the human to complete it — you never type the password, 2FA code, or solve the CAPTCHA. The session is persistent, so once the person signs in the login is CACHED in the profile and reused on later (even headless) visits with the same session name. Returns once the window is open (handoff:true). Optionally pass waitSelector/waitUrl to block until a post-login element/URL appears (bounded ~110s); for slower sign-ins, just call browser_whoami afterwards to confirm. Promotes an existing headless session of the same name to headed automatically.",
    schema: { type: "object", required: ["url"], properties: { session: SESSION, url: { type: "string", description: "login or signup page URL" }, waitSelector: { type: "string", description: "optional CSS selector that appears once signed in — blocks until visible (or timeout)" }, waitUrl: { type: "string", description: "optional URL substring the page navigates to once signed in" }, timeoutMs: { type: "number", description: "max wait for waitSelector/waitUrl (capped ~110000)" }, max: { type: "number" } } } },
  { name: "browser_whoami", description: "Inventory which sites this session's profile is logged into: cookie HOSTS with a likely-logged-in heuristic (presence of auth/session cookies). Returns cookie NAMES + counts only — never secret values. Use to verify a login handoff succeeded or to answer 'are we still signed into X?'.",
    schema: { type: "object", properties: { session: SESSION } } },
  { name: "browser_save_state", description: "Export this session's authenticated state into the managed state store under a handle — a PORTABLE login cache. Cookies are always captured; localStorage is captured ONLY for origins this session has visited in-process (so save right after browser_login while still on the site, or pass origins). Token-in-localStorage logins (Firebase/Supabase/Auth0 SPAs) NEED the origin captured; cookie-only logins don't. Returns the stored path and a warning if localStorage wasn't captured.",
    schema: { type: "object", properties: { session: SESSION, state: { type: "string", description: "handle to store under (defaults to the session name)" }, origins: { type: "array", items: { type: "string" }, description: "origins to visit before snapshot so their localStorage is captured, e.g. [\"https://app.example.com\"]" } } } },
  { name: "browser_load_state", description: "Seed a session from a state previously saved with browser_save_state (injects its cookies + localStorage). The safe way to reuse an existing local login cache without re-authenticating. Pass headed:true to then drive the now-logged-in window.",
    schema: { type: "object", required: ["state"], properties: { session: SESSION, state: { type: "string", description: "handle previously saved with browser_save_state" }, headed: { type: "boolean" } } } },
  { name: "browser_profiles", description: "List the on-disk persistent profiles (durable login caches), flagging which are currently live and when each was last used.",
    schema: { type: "object", properties: {} } },
  { name: "browser_close", description: "Close a session (frees its browser). Omit session to close ALL sessions.",
    schema: { type: "object", properties: { session: { type: "string" } } } },
  { name: "browser_status", description: "List live browser sessions and daemon info (names, URLs, idle time, capacity).",
    schema: { type: "object", properties: {} } },
];

const server = new Server({ name: "jarvis-browser", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })),
}));

const text = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

// Render an observe/act result compactly for the agent. Full snapshots already
// carry their own url/title/count header (from serialize); incremental diffs do
// not, so we prepend a one-line head only then — no duplicated lines.
function renderObs(r) {
  const body = r.text != null ? r.text : "";
  if (r.full) return text(body);
  const head = [];
  if (r.action) head.push(`[${r.action}]`);
  if (r.url) head.push(r.url);
  if (r.count != null) head.push(`${r.count} els`);
  return text([head.join(" "), body].filter(Boolean).join("\n"));
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  const s = ns(a.session);
  try {
    switch (name) {
      case "browser_navigate": return renderObs(await rpc("navigate", { name: s, url: a.url, persist: !a.ephemeral, headed: !!a.headed, max: a.max }));
      case "browser_snapshot": return renderObs(await rpc("snapshot", { name: s, incremental: !a.full, max: a.max }));
      case "browser_click": return renderObs(await rpc("act", { name: s, action: "click", ref: a.ref }));
      case "browser_fill": return renderObs(await rpc("act", { name: s, action: "fill", ref: a.ref, text: a.text }));
      case "browser_type": return renderObs(await rpc("act", { name: s, action: "type", ref: a.ref, text: a.text }));
      case "browser_press": return renderObs(await rpc("act", { name: s, action: "press", key: a.key, ref: a.ref }));
      case "browser_select": return renderObs(await rpc("act", { name: s, action: "select", ref: a.ref, value: a.value }));
      case "browser_scroll": return renderObs(await rpc("act", { name: s, action: "scroll", dy: a.dy }));
      case "browser_get_text": return text(await rpc("getText", { name: s, ref: a.ref, max: a.max }));
      case "browser_extract": return text(await rpc("extract", { name: s, fields: a.fields }));
      case "browser_screenshot": return text(await rpc("screenshot", { name: s, fullPage: !!a.fullPage, ref: a.ref }));
      case "browser_read_screen": return text(await rpc("readScreen", { name: s, question: a.question, ref: a.ref, fullPage: !!a.fullPage, long: !!a.long }));
      case "browser_eval": return text(await rpc("eval", { name: s, expression: a.expression }));
      case "browser_login": {
        const r = await rpc("login", { name: s, url: a.url, waitUrl: a.waitUrl, waitSelector: a.waitSelector, timeoutMs: a.timeoutMs, max: a.max });
        const lead = r.handoff
          ? "HANDOFF: a visible window is open. The HUMAN must complete sign-in/sign-up there (password, 2FA, CAPTCHA) — do NOT type credentials yourself. Then call browser_whoami to confirm."
          : (r.signedIn ? "sign-in detected (waitUrl/waitSelector matched)." : "wait timed out — sign-in not detected yet; call browser_whoami to check.");
        const summary = { handoff: r.handoff, signedIn: r.signedIn, totalCookies: r.totalCookies, loggedInDomains: (r.domains || []).filter((d) => d.likelyLoggedIn).map((d) => d.domain) };
        return text(`${lead}\n${JSON.stringify(summary)}\n\n${r.text || ""}`);
      }
      case "browser_whoami": return text(await rpc("whoami", { name: s }));
      case "browser_save_state": return text(await rpc("saveState", { name: s, state: a.state, origins: a.origins }));
      case "browser_load_state": return text(await rpc("loadState", { name: s, state: a.state, headed: !!a.headed }));
      case "browser_profiles": return text(await rpc("profiles"));
      case "browser_close": return text(a.session === undefined ? await rpc("closeAll") : await rpc("close", { name: s }));
      case "browser_status": return text(await rpc("status"));
      default: throw new Error(`unknown tool: ${name}`);
    }
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `error: ${e?.message || String(e)}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[jarvis-browser-mcp] ready");
