#!/usr/bin/env node
/**
 * jarvis-browser daemon — a single long-lived process that owns the whole
 * Chromium fleet and hands out ISOLATED browser sessions to N concurrent
 * callers (Claude agents via the MCP front, or the `jbrowser` CLI).
 *
 * Isolation model:
 *   - persistent session  -> chromium.launchPersistentContext(<profile dir>)  ⇒ own
 *                            process + own user-data-dir ⇒ durable login, fully
 *                            isolated. One profile = one process (serialized).
 *   - ephemeral session   -> sharedHub.newContext()  ⇒ cheap isolated context in
 *                            one shared Chromium ⇒ no login persistence, lightest.
 *
 * Reliability: per-session keyed lock (no self-races), idle-TTL reaper, a global
 * concurrency cap, `disconnected` pruning, graceful close-all on signals, single
 * instance guarded by the listen port. Token discipline lives at the response
 * layer: compact ref-based a11y snapshots + incremental diffs, screenshots saved
 * to disk and returned as PATHS (never inlined).
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SNAPSHOT_FN, serialize, diff } from "./lib/snapshot.mjs";

const PORT = Number(process.env.JARVIS_BROWSER_PORT || 3344);
const HOST = "127.0.0.1";
const MAX_SESSIONS = Number(process.env.JARVIS_BROWSER_MAX || 6);
const IDLE_TTL_MS = Number(process.env.JARVIS_BROWSER_IDLE_MS || 10 * 60 * 1000);
const ACTION_TIMEOUT = Number(process.env.JARVIS_BROWSER_ACTION_TIMEOUT || 15000);
const STATE = join(homedir(), ".claude/jarvis/state");
const PROFILES = join(STATE, "browser-profiles");
const SHOTS = join(STATE, "browser-shots");
const PIDFILE = join(STATE, "jarvis-browser.pid");
for (const d of [PROFILES, SHOTS]) mkdirSync(d, { recursive: true });

// Lightweight vision backend for READING screenshots without inlining pixels
// into the agent's context. Default = the local `moondream` wrapper (Moondream
// Cloud, ~0.7s, cheap); swap a competitor via JARVIS_VISION_CMD. Returns text.
const VISION_BIN = process.env.JARVIS_VISION_CMD || join(homedir(), ".claude/jarvis/scripts/moondream");
function runVision(imgPath, question, long) {
  return new Promise((resolve) => {
    // Guard argv flag-smuggling: the vision wrapper treats a leading-dash arg as a
    // flag (-l/--detect/--point), so a `question` starting with "-" would change
    // its mode instead of being asked. Reject it (a real query never starts with
    // a dash). spawn() uses no shell, so there is no shell-injection vector; and
    // imgPath is daemon-generated + sanitized, never a flag.
    if (question != null && /^-/.test(String(question).trim())) {
      return resolve({ ok: false, backend: VISION_BIN, text: "vision question must not start with '-'" });
    }
    const args = [imgPath];
    if (question) args.push(String(question));
    else if (long) args.push("-l");
    let child;
    try { child = spawn(VISION_BIN, args, { env: process.env }); }
    catch (e) { return resolve({ ok: false, backend: VISION_BIN, text: `vision unavailable: ${e.message}` }); }
    let out = "", err = "";
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 30000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(killer); resolve({ ok: false, backend: VISION_BIN, text: `vision error: ${e.message}` }); });
    child.on("close", (code) => {
      clearTimeout(killer);
      const text = (out || "").trim();
      if (code === 0 && text && text !== "(empty)") resolve({ ok: true, backend: "moondream", text });
      else resolve({ ok: false, backend: "moondream", text: text || (err || "").trim() || `vision exit ${code}` });
    });
  });
}

const log = (...a) => console.error("[jbrowserd]", ...a);
const startedAt = Date.now();

const launchArgs = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-blink-features=AutomationControlled",
];

const sanitize = (s) => String(s || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "default";

/** @type {Map<string, Session>} */
const sessions = new Map();
let sharedHub = null; // shared Chromium browser for ephemeral contexts

async function getHub() {
  if (sharedHub && sharedHub.isConnected()) return sharedHub;
  sharedHub = await chromium.launch({ headless: true, args: launchArgs });
  sharedHub.on("disconnected", () => { if (sharedHub && !sharedHub.isConnected()) sharedHub = null; });
  return sharedHub;
}

class Session {
  constructor(name, { persist, headed }) {
    this.name = name;
    this.persist = persist;
    this.headed = headed;
    this.context = null;
    this.browser = null; // set for persistent (the persistent context IS the browser owner)
    this.page = null;
    this.lastUsed = Date.now();
    this.lastSnap = null;
    this.ready = Promise.resolve(this); // reassigned by ensureSession with the real init() promise
    this._chain = Promise.resolve();
  }

  // keyed lock: serialize all ops on this session
  run(fn) {
    const next = this._chain.then(fn, fn);
    this._chain = next.then(() => {}, () => {});
    return next;
  }

  async init() {
    const profileDir = join(PROFILES, this.name);
    if (this.persist) {
      this.context = await chromium.launchPersistentContext(profileDir, {
        headless: !this.headed,
        args: launchArgs,
        viewport: { width: 1280, height: 900 },
      });
      this.context.on("close", () => sessions.delete(this.name));
    } else {
      const hub = await getHub();
      this.context = await hub.newContext({ viewport: { width: 1280, height: 900 } });
    }
    this.context.setDefaultTimeout(ACTION_TIMEOUT);
    this.context.setDefaultNavigationTimeout(Math.max(ACTION_TIMEOUT, 30000));
    this.page = this.context.pages()[0] || (await this.context.newPage());
    return this;
  }

  touch() { this.lastUsed = Date.now(); }

  async snapshot(max) { return this.page.evaluate(SNAPSHOT_FN, { max: max || 200 }); }

  // re-snapshot and return incremental delta (or full if requested)
  async observe({ incremental = true, max } = {}) {
    const snap = await this.snapshot(max);
    const prev = this.lastSnap;
    this.lastSnap = snap;
    if (incremental) return { ...diff(prev, snap), url: snap.url, title: snap.title, count: snap.elements.length };
    return { text: serialize(snap), full: true, url: snap.url, title: snap.title, count: snap.elements.length };
  }

  locator(ref) {
    if (ref === undefined || ref === null) throw new Error("ref required");
    return this.page.locator(`[data-jbref="${Number(ref)}"]`);
  }

  async close() {
    try { await this.context?.close(); } catch {}
    sessions.delete(this.name);
  }
}

async function ensureSession({ name, persist = true, headed = false }) {
  const key = sanitize(name);

  // Fast path: a map entry exists (possibly still initializing). Awaiting its
  // `ready` promise both serializes same-name creation (no second launch / no
  // SingletonLock collision / no orphaned context) AND guarantees `page` is set
  // before any caller uses the session.
  const hit = sessions.get(key);
  if (hit) {
    try { await hit.ready; hit.touch(); return { session: hit, created: false }; }
    catch { /* its init failed and it removed itself — fall through and recreate */ }
  }

  // Make room if at cap. This awaits, so re-check the map afterward for a racer.
  if (sessions.size >= MAX_SESSIONS && !sessions.has(key)) {
    const victim = [...sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (victim && Date.now() - victim.lastUsed > 5000) await victim.close();
    else throw new Error(`session cap reached (${MAX_SESSIONS}); all sessions busy`);
  }
  const racer = sessions.get(key);
  if (racer) {
    try { await racer.ready; racer.touch(); return { session: racer, created: false }; }
    catch { /* recreate */ }
  }

  const s = new Session(key, { persist, headed });
  // Assign `ready` and publish to the map SYNCHRONOUSLY (no await between) so the
  // cap slot is reserved and concurrent same-key callers observe a ready promise.
  s.ready = s.init().then(() => s, (e) => { sessions.delete(key); throw e; });
  sessions.set(key, s);
  await s.ready;
  return { session: s, created: true };
}

// ---- RPC methods ----
const methods = {
  async status() {
    return {
      pid: process.pid,
      port: PORT,
      uptimeMs: Date.now() - startedAt,
      cap: MAX_SESSIONS,
      idleTtlMs: IDLE_TTL_MS,
      hub: !!(sharedHub && sharedHub.isConnected()),
      sessions: [...sessions.values()].map((s) => ({
        name: s.name, persist: s.persist, headed: s.headed,
        url: s.page?.url() || null, title: s.lastSnap?.title || null,
        idleMs: Date.now() - s.lastUsed,
      })),
    };
  },

  async ensure(p) {
    const { session, created } = await ensureSession(p);
    return session.run(async () => {
      session.touch();
      return { name: session.name, created, persist: session.persist, url: session.page.url() };
    });
  },

  async navigate(p) {
    // Scheme allowlist: keep the fleet on the web. file://, chrome://, view-source:
    // etc. are blocked so a (hypothetically) injected navigate can't read local
    // files for exfiltration. Opt out only via JARVIS_BROWSER_ALLOW_ALL_SCHEMES=1.
    if (!process.env.JARVIS_BROWSER_ALLOW_ALL_SCHEMES) {
      let proto;
      try { proto = new URL(p.url).protocol; } catch { throw new Error(`invalid url: ${p.url}`); }
      if (!["http:", "https:", "about:", "data:"].includes(proto)) throw new Error(`scheme not allowed: ${proto} (set JARVIS_BROWSER_ALLOW_ALL_SCHEMES=1 to override)`);
    }
    const { session } = await ensureSession(p);
    return session.run(async () => {
      session.touch();
      await session.page.goto(p.url, { waitUntil: p.waitUntil || "domcontentloaded" });
      session.lastSnap = null; // fresh page
      const obs = await session.observe({ incremental: false, max: p.max });
      return { ok: true, ...obs };
    });
  },

  async snapshot(p) {
    const { session } = await ensureSession(p);
    return session.run(async () => {
      session.touch();
      return session.observe({ incremental: p.incremental !== false, max: p.max });
    });
  },

  async act(p) {
    const { session } = await ensureSession(p);
    return session.run(async () => {
      session.touch();
      const a = p.action;
      const loc = (p.ref !== undefined) ? session.locator(p.ref) : null;
      switch (a) {
        case "click": await loc.click({ timeout: ACTION_TIMEOUT }); break;
        case "dblclick": await loc.dblclick({ timeout: ACTION_TIMEOUT }); break;
        case "hover": await loc.hover({ timeout: ACTION_TIMEOUT }); break;
        case "fill": await loc.fill(p.text ?? "", { timeout: ACTION_TIMEOUT }); break;
        case "type": await loc.pressSequentially(p.text ?? "", { timeout: ACTION_TIMEOUT, delay: 10 }); break;
        case "check": await loc.check({ timeout: ACTION_TIMEOUT }); break;
        case "uncheck": await loc.uncheck({ timeout: ACTION_TIMEOUT }); break;
        case "select": await loc.selectOption(p.value, { timeout: ACTION_TIMEOUT }); break;
        case "press": await (loc ? loc.press(p.key, { timeout: ACTION_TIMEOUT }) : session.page.keyboard.press(p.key)); break;
        case "scroll": await session.page.mouse.wheel(0, p.dy ?? 600); break;
        case "scrollTo": await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT }); break;
        case "back": await session.page.goBack({ waitUntil: "domcontentloaded" }); session.lastSnap = null; break;
        case "wait": await session.page.waitForTimeout(Math.min(p.ms ?? 1000, 10000)); break;
        default: throw new Error(`unknown action: ${a}`);
      }
      const obs = await session.observe({ incremental: true, max: p.max });
      return { ok: true, action: a, ...obs };
    });
  },

  async getText(p) {
    const { session } = await ensureSession(p);
    return session.run(async () => {
      session.touch();
      const max = Math.min(p.max ?? 4000, 20000);
      const t = (p.ref !== undefined)
        ? await session.locator(p.ref).innerText({ timeout: ACTION_TIMEOUT })
        : await session.page.evaluate(() => document.body.innerText);
      const clean = (t || "").replace(/\n{3,}/g, "\n\n").trim();
      return { text: clean.slice(0, max), truncated: clean.length > max, length: clean.length };
    });
  },

  async extract(p) {
    const { session } = await ensureSession(p);
    return session.run(async () => {
      session.touch();
      // fields: { key: cssSelector | {selector, attr} }  -> structured scrape, 0 LLM
      const data = await session.page.evaluate((fields) => {
        const out = {};
        for (const [k, spec] of Object.entries(fields)) {
          const sel = typeof spec === "string" ? spec : spec.selector;
          const all = !!(spec && spec.all);
          const attr = spec && spec.attr;
          const read = (el) => attr ? el.getAttribute(attr) : (el.innerText || el.value || "").trim();
          if (all) out[k] = Array.from(document.querySelectorAll(sel)).map(read);
          else { const el = document.querySelector(sel); out[k] = el ? read(el) : null; }
        }
        return out;
      }, p.fields || {});
      return { data };
    });
  },

  async eval(p) {
    const { session } = await ensureSession(p);
    return session.run(async () => {
      session.touch();
      // Escape hatch: run agent-supplied JS IN THE PAGE. `new Function` is built
      // and executed inside page.evaluate, i.e. in the browser page sandbox — it
      // CANNOT reach the Node host, filesystem, or env. This is the same trust
      // boundary as Playwright's page.evaluate / dev-browser's model: the agent
      // can only script a page it already fully controls. Not host code-exec.
      const r = await session.page.evaluate((src) => {
        const fn = new Function(`return (async () => { ${src} })()`); // page-context only
        return fn();
      }, p.expression);
      let out = r;
      try { out = JSON.parse(JSON.stringify(r)); } catch { out = String(r); }
      const s = typeof out === "string" ? out : JSON.stringify(out);
      // Consistent shape (mirrors getText): on truncation `result` is always the
      // truncated STRING, never a half-serialized object. Caller can rely on type.
      const truncated = s.length > 8000;
      return truncated ? { result: s.slice(0, 8000) + "…", truncated: true, length: s.length } : { result: out };
    });
  },

  async screenshot(p) {
    const { session } = await ensureSession(p);
    return session.run(async () => {
      session.touch();
      const ts = String(Date.now());
      const path = join(SHOTS, `${session.name}-${ts}.png`);
      if (p.ref !== undefined) await session.locator(p.ref).screenshot({ path });
      else await session.page.screenshot({ path, fullPage: !!p.fullPage });
      return { path };
    });
  },

  // Read the screen with a lightweight vision model (moondream) — returns TEXT,
  // never pixels. The agent "sees" the page without loading an image into its
  // context. `question` = a specific query; otherwise a caption.
  async readScreen(p) {
    const { session } = await ensureSession(p);
    return session.run(async () => {
      session.touch();
      const ts = String(Date.now());
      const path = join(SHOTS, `${session.name}-${ts}.png`);
      if (p.ref !== undefined) await session.locator(p.ref).screenshot({ path });
      else await session.page.screenshot({ path, fullPage: !!p.fullPage });
      const v = await runVision(path, p.question, p.long);
      return { path, vision: v.text, backend: v.backend, ok: v.ok, question: p.question || null };
    });
  },

  async close(p) {
    const key = sanitize(p.name);
    const s = sessions.get(key);
    if (s) await s.close();
    return { ok: true, closed: !!s };
  },

  async closeAll() {
    const names = [...sessions.keys()];
    await Promise.allSettled([...sessions.values()].map((s) => s.close()));
    try { if (sharedHub) await sharedHub.close(); } catch {}
    sharedHub = null;
    return { ok: true, closed: names };
  },
};

// ---- idle reaper ----
const reaper = setInterval(async () => {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (now - s.lastUsed > IDLE_TTL_MS) {
      log(`reaping idle session: ${s.name} (idle ${Math.round((now - s.lastUsed) / 1000)}s)`);
      await s.close().catch(() => {});
    }
  }
  if (sessions.size === 0 && sharedHub) { try { await sharedHub.close(); } catch {} sharedHub = null; }
}, 30000);
reaper.unref?.();

// ---- HTTP server ----
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, pid: process.pid }));
  }
  if (req.method !== "POST" || req.url !== "/rpc") { res.writeHead(404); return res.end(); }
  // Control-plane guard. This daemon drives untrusted web pages, and browsers can
  // reach 127.0.0.1 — so a visited page must not be able to POST commands here
  // (CSRF) or read them back via DNS rebinding. Browsers always attach Origin/
  // Referer/Sec-Fetch-Site on a cross-origin POST; node fetch (our CLI/MCP client)
  // attaches none of these (it does send Sec-Fetch-Mode, so that one is NOT a
  // discriminator and must not be checked).
  if (req.headers.origin || req.headers.referer || req.headers["sec-fetch-site"]) {
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "forbidden: browser-originated request" }));
  }
  if (String(req.headers["content-type"] || "").split(";")[0].trim() !== "application/json") {
    res.writeHead(415, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "content-type must be application/json" }));
  }
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(String(req.headers.host || ""))) {
    res.writeHead(421, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "bad host (rebinding guard)" }));
  }
  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 5e6) req.destroy(); });
  req.on("end", async () => {
    let id = null;
    try {
      const { method, params, id: rid } = JSON.parse(body || "{}");
      id = rid;
      // own-property lookup only — never resolve inherited Object.prototype fns
      // (constructor, hasOwnProperty, …) as callable RPC methods.
      const fn = Object.prototype.hasOwnProperty.call(methods, method) ? methods[method] : null;
      if (typeof fn !== "function") throw new Error(`unknown method: ${method}`);
      const result = await fn(params || {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, result }));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, error: e?.message || String(e) }));
    }
  });
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { log(`port ${PORT} in use — another daemon is running; exiting`); process.exit(0); }
  log("server error:", e.message); process.exit(1);
});

server.listen(PORT, HOST, () => {
  writeFileSync(PIDFILE, String(process.pid));
  log(`listening on http://${HOST}:${PORT} (cap=${MAX_SESSIONS}, idleTtl=${IDLE_TTL_MS}ms, pid=${process.pid})`);
});

async function shutdown(sig) {
  log(`${sig} — closing ${sessions.size} session(s)`);
  clearInterval(reaper);
  await methods.closeAll().catch(() => {});
  try { rmSync(PIDFILE, { force: true }); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref?.();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
