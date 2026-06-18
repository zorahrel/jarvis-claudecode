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
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync, readdirSync, readFileSync, renameSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { SNAPSHOT_FN, serialize, diff } from "./lib/snapshot.mjs";

const PKG_DIR = dirname(fileURLToPath(import.meta.url)); // this package's dir (for setup hints)

const PORT = Number(process.env.JARVIS_BROWSER_PORT || 3344);
const HOST = "127.0.0.1";
const MAX_SESSIONS = Number(process.env.JARVIS_BROWSER_MAX || 6);
const IDLE_TTL_MS = Number(process.env.JARVIS_BROWSER_IDLE_MS || 10 * 60 * 1000);
const ACTION_TIMEOUT = Number(process.env.JARVIS_BROWSER_ACTION_TIMEOUT || 15000);
const STATE = join(homedir(), ".claude/jarvis/state");
const PROFILES = join(STATE, "browser-profiles");
const SHOTS = join(STATE, "browser-shots");
const STATES = join(STATE, "browser-states"); // exported storageState JSONs (portable authed sessions)
const PIDFILE = join(STATE, "jarvis-browser.pid");
for (const d of [PROFILES, SHOTS, STATES]) mkdirSync(d, { recursive: true });
// State files hold decrypted session cookies — keep the dir owner-only.
try { chmodSync(STATES, 0o700); } catch {}

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

// Group cookies by host and flag the ones that look like auth/session state, so a
// caller can answer "is this profile logged into X?" without seeing cookie VALUES
// (we return only names + counts — never the secret values).
// NOTE this is a NAME heuristic, not proof of authentication: it deliberately
// EXCLUDES csrf/xsrf/__Host-/__Secure- and a broad httpOnly fallback, because
// logged-OUT sites (e.g. github sets _gh_sess + a CSRF token to anonymous
// visitors) set those too — including them produced false "logged in" positives.
// For an authoritative signal use login()'s waitSelector/waitUrl (signedIn).
// Excludes login|logged on purpose: those are usually boolean UI flags (e.g.
// github sets a PERSISTENT logged_in=no to anonymous visitors) — matching them
// turned anonymous sessions into false positives. Real credentials are session/
// auth/token/sid/jwt/_user-style names.
const AUTH_COOKIE_RE = /sess|session|^auth|_auth|authn|identity|jwt|^sid$|_sid$|access[_-]?token|refresh[_-]?token|remember|_user$/i;
function classifyCookies(cookies) {
  const now = Date.now() / 1000;
  const byDomain = new Map();
  for (const c of cookies) {
    const host = String(c.domain || "").replace(/^\./, "");
    if (!host) continue;
    let v = byDomain.get(host);
    if (!v) { v = { domain: host, cookies: 0, authCookies: 0, authPersistent: 0, names: [] }; byDomain.set(host, v); }
    v.cookies++;
    if (AUTH_COOKIE_RE.test(c.name)) {
      v.authCookies++;
      // A PERSISTENT auth-named cookie (real future expiry, not session-scoped) is
      // a much stronger sign of an actual login: anonymous visitors get session-
      // scoped cookies (e.g. logged-out github's _gh_sess, expires=-1), whereas a
      // signed-in site typically sets a persistent auth/session token.
      if (typeof c.expires === "number" && c.expires > now) v.authPersistent++;
    }
    if (v.names.length < 12) v.names.push(c.name);
  }
  const domains = [...byDomain.values()]
    // hasAuthCookies = factual (auth-NAMED cookie present, logged in or not).
    // likelyLoggedIn = stronger HINT (a persistent auth cookie) — still a heuristic.
    .map((v) => ({ ...v, hasAuthCookies: v.authCookies > 0, likelyLoggedIn: v.authPersistent > 0 }))
    .sort((a, b) => b.cookies - a.cookies);
  return { totalCookies: cookies.length, domainCount: domains.length, heuristic: "cookie-name+persistence; verify a real sign-in via login() waitSelector/waitUrl", domains };
}

// Keep the fleet on the web. Shared by navigate/login/loadState so no goto path
// skips it: file://, chrome://, view-source: etc. are blocked so an (injected)
// navigation can't read local files. Opt out only via JARVIS_BROWSER_ALLOW_ALL_SCHEMES=1.
function assertAllowedScheme(url) {
  if (process.env.JARVIS_BROWSER_ALLOW_ALL_SCHEMES) return;
  let proto;
  try { proto = new URL(url).protocol; } catch { throw new Error(`invalid url: ${url}`); }
  if (!["http:", "https:", "about:", "data:"].includes(proto)) {
    throw new Error(`scheme not allowed: ${proto} (set JARVIS_BROWSER_ALLOW_ALL_SCHEMES=1 to override)`);
  }
}

// storageState files are the ONLY host-filesystem primitive exposed to callers,
// so keep it closed by default: a state is addressed by a sanitized HANDLE that
// always lands in STATES/<handle>.json. An arbitrary absolute `path` is allowed
// only behind an opt-in env gate (mirrors the scheme allowlist) — this prevents
// an injected instruction from steering an agent into reading/overwriting host
// files via save/loadState.
function resolveStatePath({ path, state, name }) {
  if (path) {
    if (!process.env.JARVIS_BROWSER_ALLOW_STATE_PATH) {
      throw new Error("custom state path disabled; use { state: <handle> } (lands in browser-states/), or set JARVIS_BROWSER_ALLOW_STATE_PATH=1 to allow arbitrary paths");
    }
    return path;
  }
  return join(STATES, `${sanitize(state || name)}.json`);
}

// State ops (save/load/login) promise a DURABLE login cache, which an ephemeral
// (in-memory hub) session can't provide. If a live session under this key is
// ephemeral, fail loudly instead of silently binding to a throwaway context.
function assertPersistentForState(key, op) {
  const live = sessions.get(key);
  if (live && live.persist === false) {
    throw new Error(`session '${key}' is live but EPHEMERAL — ${op} needs a persistent session. Close it first or use a different name.`);
  }
}

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
      // Retry the persistent launch: when a session is promoted (headless→headed)
      // or relaunched right after a close (e.g. idle-reaper churn), the prior
      // process may still hold the profile's SingletonLock for a few hundred ms.
      // A bounded retry turns that transient collision into a clean launch.
      for (let attempt = 0; ; attempt++) {
        try {
          this.context = await chromium.launchPersistentContext(profileDir, {
            headless: !this.headed,
            args: launchArgs,
            viewport: { width: 1280, height: 900 },
          });
          break;
        } catch (e) {
          const msg = String(e?.message || e);
          // Friendly hint: headed needs the FULL Chromium build, not the headless shell.
          if (this.headed && /Executable doesn't exist|please run the following command/i.test(msg)) {
            throw new Error(`headed mode needs the full Chromium build (only the headless shell is cached) — run \`npx playwright install chromium\` in ${PKG_DIR}. Original: ${msg}`);
          }
          if (attempt < 4 && /SingletonLock|ProcessSingleton|ProfileInUse|Failed to create a ProcessSingleton/i.test(msg)) {
            await new Promise((r) => setTimeout(r, 300));
            continue;
          }
          throw e;
        }
      }
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
  // Never evict a HEADED session: it's almost always a visible login window a
  // human is mid-handoff in (login is non-blocking, so its lastUsed ages while
  // the person does 2FA) — killing it would close the sign-in out from under them.
  if (sessions.size >= MAX_SESSIONS && !sessions.has(key)) {
    const victim = [...sessions.values()].filter((s) => !s.headed).sort((a, b) => a.lastUsed - b.lastUsed)[0];
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
    assertAllowedScheme(p.url);
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

  // Open (or promote to) a HEADED persistent window and HAND OFF to the human to
  // sign in or sign up. This NEVER types credentials — it surfaces a real, visible
  // browser the person drives (password / 2FA / CAPTCHA all stay human). The
  // persistent profile then caches the authenticated session for later reuse.
  // Non-blocking by default: returns once the window is open. Pass waitUrl or
  // waitSelector for a bounded wait (capped under the RPC client timeout); for
  // long sign-ins, just poll `whoami` afterwards instead.
  async login(p) {
    if (p.url) assertAllowedScheme(p.url);
    const key = sanitize(p.name || "login");
    // Obtain a HEADED PERSISTENT session, promoting an existing one if needed.
    // A concurrent navigate/whoami (which default headed:false) can recreate the
    // session headless between our close and ensureSession — and ensureSession
    // returns an existing hit as-is, ignoring our headed:true. So we verify the
    // result is actually headed and re-promote rather than falsely reporting a
    // visible window. Bounded to avoid a livelock under pathological concurrency.
    let session = null;
    for (let attempt = 0; attempt < 3 && !session; attempt++) {
      const existing = sessions.get(key);
      if (existing) {
        try { await existing.ready; } catch {}
        // Close a headless OR ephemeral live session so we can relaunch
        // headed+persistent on the same profile dir (on-disk cookies preserved).
        // Close THROUGH its lock so an in-flight op isn't torn out from under it;
        // init()'s retry absorbs the brief SingletonLock overlap on relaunch.
        if (!existing.headed || !existing.persist) {
          try { await existing.run(() => existing.close()); } catch { try { await existing.close(); } catch {} }
        }
      }
      const got = await ensureSession({ name: key, persist: true, headed: true });
      if (got.session.headed) session = got.session;
      else { try { await got.session.run(() => got.session.close()); } catch {} } // racer made it headless — retry
    }
    if (!session) throw new Error("login: could not obtain a headed window (a concurrent op kept recreating the session headless) — retry");
    return session.run(async () => {
      session.touch();
      if (p.url) {
        await session.page.goto(p.url, { waitUntil: p.waitUntil || "domcontentloaded" });
        session.lastSnap = null;
      }
      let signedIn = null;
      if (p.waitUrl || p.waitSelector) {
        const ms = Math.min(p.timeoutMs ?? 110000, 110000); // stay under the 120s RPC client timeout
        try {
          if (p.waitUrl) await session.page.waitForURL((u) => String(u).includes(p.waitUrl), { timeout: ms });
          else await session.page.waitForSelector(p.waitSelector, { timeout: ms, state: "visible" });
          signedIn = true;
        } catch { signedIn = false; }
        session.lastSnap = null;
      }
      const cookies = await session.context.cookies();
      const obs = await session.observe({ incremental: false, max: p.max });
      return { ok: true, headed: session.headed, handoff: !(p.waitUrl || p.waitSelector), signedIn, ...obs, ...classifyCookies(cookies) };
    });
  },

  // "Who is this profile logged in as?" — inventory of cookie HOSTS with a
  // likely-logged-in heuristic. Returns cookie NAMES + counts only, never values.
  async whoami(p) {
    const { session } = await ensureSession({ name: p.name, persist: p.persist !== false, headed: !!p.headed });
    return session.run(async () => {
      session.touch();
      const cookies = await session.context.cookies();
      return classifyCookies(cookies);
    });
  },

  // Export this profile's storageState (cookies + per-origin localStorage) to a
  // JSON file — a PORTABLE authed session. Log in once, then reuse it elsewhere.
  async saveState(p) {
    const path = resolveStatePath(p);
    assertPersistentForState(sanitize(p.name), "save-state");
    const { session } = await ensureSession({ name: p.name, persist: p.persist !== false });
    return session.run(async () => {
      session.touch();
      // storageState() snapshots localStorage ONLY for origins this context has an
      // in-process page for — it does NOT read the persistent profile's on-disk
      // Local Storage. So a save from a reaped/reattached profile (page sitting at
      // about:blank) exports cookies only. Visiting the given origins first loads
      // their localStorage so it gets captured.
      for (const origin of (Array.isArray(p.origins) ? p.origins : [])) {
        try { assertAllowedScheme(origin); await session.page.goto(origin, { waitUntil: "domcontentloaded" }); } catch {}
      }
      mkdirSync(dirname(path), { recursive: true });
      const st = await session.context.storageState({ path });
      try { chmodSync(path, 0o600); } catch {} // contains cookie values — owner-only
      const cookies = st.cookies?.length || 0;
      const origins = st.origins?.length || 0;
      const res = { ok: true, path, cookies, origins };
      if (cookies > 0 && origins === 0) {
        res.warning = "localStorage NOT captured (origins:0): storageState only snapshots origins this session visited in-process, not the on-disk profile. Cookie-only logins are fine; for token-in-localStorage logins (Firebase/Supabase/Auth0 SPAs) run save-state right after login while still on the site, or pass origins:[\"https://site\"].";
      }
      return res;
    });
  },

  // Seed a session from an exported storageState JSON: inject its cookies and,
  // for each origin, its localStorage. The safe "leverage a local cache" path —
  // no profile cloning, no secret decryption.
  async loadState(p) {
    const path = resolveStatePath(p);
    assertPersistentForState(sanitize(p.name), "load-state");
    let st;
    try { st = JSON.parse(readFileSync(path, "utf8")); }
    catch (e) { throw new Error(`cannot read state ${path}: ${e.message}`); }
    const { session } = await ensureSession({ name: p.name, persist: p.persist !== false, headed: !!p.headed });
    return session.run(async () => {
      session.touch();
      // addCookies validates the WHOLE batch and throws on any malformed entry, so
      // one bad cookie in a hand-edited/cross-version state file would load none.
      // Try the batch, then fall back to per-cookie so the valid ones still load.
      let cookiesLoaded = 0, cookiesSkipped = 0;
      const cks = Array.isArray(st.cookies) ? st.cookies : [];
      if (cks.length) {
        try { await session.context.addCookies(cks); cookiesLoaded = cks.length; }
        catch {
          for (const c of cks) {
            try { await session.context.addCookies([c]); cookiesLoaded++; } catch { cookiesSkipped++; }
          }
        }
      }
      let originsLoaded = 0, originsFailed = 0;
      for (const o of (st.origins || [])) {
        if (!o?.origin || !Array.isArray(o.localStorage) || !o.localStorage.length) continue;
        try {
          assertAllowedScheme(o.origin);
          await session.page.goto(o.origin, { waitUntil: "domcontentloaded" });
          await session.page.evaluate((items) => {
            for (const it of items) { try { localStorage.setItem(it.name, it.value); } catch {} }
          }, o.localStorage);
          originsLoaded++;
        } catch { originsFailed++; }
      }
      session.lastSnap = null;
      return { ok: true, cookiesLoaded, cookiesSkipped, originsLoaded, originsFailed };
    });
  },

  // List on-disk profiles (the durable login caches), flagging which are live.
  async profiles() {
    const live = new Set([...sessions.keys()]);
    let entries = [];
    try { entries = readdirSync(PROFILES, { withFileTypes: true }); } catch {}
    const list = entries.filter((d) => d.isDirectory()).map((d) => {
      let mtimeMs = 0;
      try { mtimeMs = statSync(join(PROFILES, d.name)).mtimeMs; } catch {}
      return { name: d.name, live: live.has(d.name), lastModified: new Date(mtimeMs).toISOString() };
    }).sort((a, b) => (Number(b.live) - Number(a.live)) || b.lastModified.localeCompare(a.lastModified));
    return { count: list.length, liveCount: live.size, profiles: list };
  },

  // Delete a profile's durable login cache. Guarded (must not be live) and uses
  // the Trash, never an unrecoverable rm, unless Trash is unavailable.
  async removeProfile(p) {
    const key = sanitize(p.name);
    if (sessions.has(key)) throw new Error(`profile '${key}' is live — close it first`);
    const dir = join(PROFILES, key);
    if (!existsSync(dir)) return { ok: true, removed: false, reason: "not found" };
    const dest = join(homedir(), ".Trash", `jbrowser-profile-${key}-${Date.now()}`);
    try { renameSync(dir, dest); return { ok: true, removed: true, trashedTo: dest }; }
    catch (e) {
      rmSync(dir, { recursive: true, force: true });
      return { ok: true, removed: true, trashedTo: null, note: `trash failed (${e.message}); removed in place` };
    }
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
