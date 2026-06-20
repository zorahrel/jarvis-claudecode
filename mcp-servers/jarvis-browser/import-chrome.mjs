#!/usr/bin/env node
/**
 * jbrowser import-chrome — seed a jarvis-browser session from the user's REAL
 * Chrome cookies, so the session is instantly logged into everything Chrome is.
 *
 * It REUSES existing sessions; it never types passwords and never creates
 * accounts. It reads only the Cookies store — NOT Login Data (saved passwords).
 *
 * macOS classic scheme ("v10" cookies, no App-Bound Encryption):
 *   key = PBKDF2-HMAC-SHA1(keychainPassword, "saltysalt", 1003, 16)
 *   plaintext = AES-128-CBC-decrypt(iv = 16 spaces, ciphertext = value[3:])
 *   strip PKCS7 padding, then strip a leading 32-byte SHA256(host_key) if present
 *   (newer Chrome binds the cookie to its host with that prefix).
 * The Keychain read (`security find-generic-password`) triggers a one-time macOS
 * consent prompt — that OS gate is the authorization, by design.
 *
 * Usage:
 *   jbrowser import-chrome <session> [--domains a.com,b.com] [--profile Default] [--dry-run] [--headed]
 *   --dry-run   list importable domains + cookie counts (NO Keychain, NO values)
 */
import { execFileSync } from "node:child_process";
import { pbkdf2Sync, createDecipheriv, createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { copyFileSync, rmSync, existsSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { rpc } from "./lib/client.mjs";

const STATES = join(homedir(), ".claude/jarvis/state/browser-states");

function cookiesDbPath(profile) {
  return join(homedir(), "Library/Application Support/Google/Chrome", profile, "Cookies");
}

// Work on a private copy so a running Chrome can't lock us out and we never touch
// the live profile. Bring the WAL/SHM siblings so recently-written rows are seen.
function snapshotDb(src) {
  const dst = join(tmpdir(), `jbrowser-chrome-${process.pid}-${Date.now()}.db`);
  copyFileSync(src, dst);
  for (const ext of ["-wal", "-shm"]) if (existsSync(src + ext)) { try { copyFileSync(src + ext, dst + ext); } catch {} }
  return dst;
}

function queryRows(dbPath, domains) {
  let where = "";
  if (domains.length) {
    // Precise match: the domain itself (host-only apex) OR any subdomain / leading-
    // dot domain cookie (host_key ends with ".<domain>"). Domains are pre-sanitized
    // to hostname chars, so no quotes/%/_ can reach the literal — no LIKE wildcard
    // surprises and no substring over-match (e.g. "oogle.com" won't hit google.com).
    const clauses = domains.map((d) => `host_key = '${d}' OR host_key LIKE '%.${d}'`).join(" OR ");
    where = `WHERE ${clauses}`;
  }
  const sql = `SELECT host_key, name, path, hex(encrypted_value) AS enc, expires_utc, is_secure, is_httponly, samesite FROM cookies ${where};`;
  const out = execFileSync("sqlite3", ["-json", dbPath, sql], { maxBuffer: 256 * 1024 * 1024 }).toString().trim();
  return out ? JSON.parse(out) : [];
}

function keychainKey() {
  // Triggers the macOS Keychain consent prompt for "Chrome Safe Storage".
  const pw = execFileSync("security", ["find-generic-password", "-ws", "Chrome Safe Storage"]).toString().replace(/\n$/, "");
  return pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
}

function decryptValue(encHex, key, hostKey) {
  const buf = Buffer.from(encHex, "hex");
  if (buf.subarray(0, 3).toString() !== "v10") return null; // only the classic macOS scheme
  const iv = Buffer.alloc(16, 0x20); // 16 spaces
  const dec = createDecipheriv("aes-128-cbc", key, iv);
  dec.setAutoPadding(false);
  let out = Buffer.concat([dec.update(buf.subarray(3)), dec.final()]);
  const pad = out[out.length - 1]; // strip PKCS7
  if (pad > 0 && pad <= 16) out = out.subarray(0, out.length - pad);
  const hostHash = createHash("sha256").update(hostKey).digest(); // newer Chrome host-binding prefix
  if (out.length >= 32 && out.subarray(0, 32).equals(hostHash)) out = out.subarray(32);
  return out.toString("utf8");
}

// Chrome expires_utc = microseconds since 1601-01-01; 0 = session cookie.
function toUnixSeconds(us) {
  const n = Number(us);
  if (!n) return -1;
  return Math.floor(n / 1e6 - 11644473600);
}
const SAME_SITE = { "-1": "Lax", 0: "None", 1: "Lax", 2: "Strict" };

function toPlaywrightCookie(row, key) {
  const value = decryptValue(row.enc, key, row.host_key);
  if (value == null) return null;
  let sameSite = SAME_SITE[String(row.samesite)] || "Lax";
  const secure = !!row.is_secure;
  if (sameSite === "None" && !secure) sameSite = "Lax"; // Playwright rejects insecure None
  const path = row.path || "/";
  const base = { name: row.name, value, expires: toUnixSeconds(row.expires_utc), httpOnly: !!row.is_httponly, secure, sameSite };
  // Chrome host_key starting with "." = a DOMAIN cookie (shared with subdomains)
  // → set domain+path. Otherwise it's HOST-ONLY; crucially, __Host-/__Secure-
  // prefixed cookies FORBID a Domain attribute, so setting domain makes Chromium
  // silently drop them. Inject host-only cookies via `url` (no domain attribute),
  // baking the path into the url so it's preserved.
  if (row.host_key.startsWith(".")) return { ...base, domain: row.host_key, path };
  const scheme = secure ? "https" : "http";
  return { ...base, url: `${scheme}://${row.host_key}${path.startsWith("/") ? path : "/" + path}` };
}

function groupByHost(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.host_key, (m.get(r.host_key) || 0) + 1);
  return [...m.entries()].map(([domain, cookies]) => ({ domain, cookies })).sort((a, b) => b.cookies - a.cookies);
}

// Sanitize inputs + read matching cookie rows from a private DB snapshot, with one
// retry on a torn (WAL) live copy. Shared by the dry-run and the real decrypt paths.
function readChromeRows({ domains = [], profile = "Default" } = {}) {
  // Defense in depth: strip anything that isn't a hostname char (drops quotes, %,
  // _, spaces) so a domain can't perturb the SQL literal or act as a LIKE wildcard.
  const cleanDomains = (domains || []).map((d) => String(d).replace(/[^a-zA-Z0-9.\-]/g, "")).filter(Boolean);
  const cleanProfile = String(profile).replace(/[^a-zA-Z0-9 _-]/g, ""); // profile dir name only
  const src = cookiesDbPath(cleanProfile);
  if (!existsSync(src)) throw new Error(`no Chrome Cookies DB for profile '${cleanProfile}' at ${src}`);
  const read = () => {
    const db = snapshotDb(src);
    try { return queryRows(db, cleanDomains); }
    finally { for (const ext of ["", "-wal", "-shm"]) { try { rmSync(db + ext, { force: true }); } catch {} } }
  };
  let rows;
  try { rows = read(); }
  catch (e) { if (/malformed|locked|disk image/i.test(String(e?.message))) rows = read(); else throw e; }
  return { rows, profile: cleanProfile, domains: cleanDomains };
}

// Dry-run: which hosts/counts WOULD be imported. No Keychain prompt, no values.
export function listChromeCookieHosts({ domains = [], profile = "Default" } = {}) {
  const { rows, profile: p } = readChromeRows({ domains, profile });
  const hosts = groupByHost(rows);
  return { dryRun: true, profile: p, totalCookies: rows.length, hostCount: hosts.length, hosts };
}

// Canonical Chrome → cookies decryption (macOS v10). Returns Playwright-shaped
// cookies + accounting. No daemon, no filesystem writes — pure. Triggers the
// Keychain consent prompt. Reused by importChrome (and vendored by topics-app).
export function decryptChromeCookies({ domains = [], profile = "Default" } = {}) {
  const { rows, profile: p, domains: d } = readChromeRows({ domains, profile });
  if (!rows.length) return { profile: p, domains: d, cookies: [], decrypted: 0, decryptFailed: 0, skippedEmpty: 0, appBoundEncrypted: 0 };
  const key = keychainKey(); // Keychain consent prompt here
  const cookies = [];
  let decryptFailed = 0, skippedEmpty = 0, appBoundEncrypted = 0;
  for (const r of rows) {
    const pfx = r.enc ? Buffer.from(r.enc.slice(0, 6), "hex").toString("latin1") : "";
    if (pfx && pfx !== "v10") { appBoundEncrypted++; continue; } // v20 = App-Bound Encryption (different scheme)
    let c;
    try { c = toPlaywrightCookie(r, key); } catch { decryptFailed++; continue; }
    if (!c) { decryptFailed++; continue; }
    if (c.value === "") { skippedEmpty++; continue; } // legitimately empty — skip, but account for it
    cookies.push(c);
  }
  return { profile: p, domains: d, cookies, decrypted: cookies.length, decryptFailed, skippedEmpty, appBoundEncrypted };
}

export async function importChrome({ session, domains = [], profile = "Default", dryRun = false, headed = false }) {
  if (dryRun) return listChromeCookieHosts({ domains, profile });
  const { profile: p, cookies, decrypted, decryptFailed, skippedEmpty, appBoundEncrypted } = decryptChromeCookies({ domains, profile });
  if (!cookies.length) return { ok: true, imported: 0, note: "no matching cookies", appBoundEncrypted };

  // The state file holds DECRYPTED session tokens — write it private (0600) in a
  // private dir (0700). writeFileSync's mode is umask-masked, so chmod explicitly.
  mkdirSync(STATES, { recursive: true, mode: 0o700 });
  try { chmodSync(STATES, 0o700); } catch {}
  const cleanDomains = (domains || []).map((d) => String(d).replace(/[^a-zA-Z0-9.\-]/g, "")).filter(Boolean);
  const handle = `chrome-${p.replace(/[^a-zA-Z0-9_-]/g, "_")}${cleanDomains.length ? "-" + cleanDomains.join("_").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) : ""}`;
  const statePath = join(STATES, `${handle}.json`);
  writeFileSync(statePath, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
  try { chmodSync(statePath, 0o600); } catch {}
  const res = await rpc("loadState", { name: session, state: handle, headed });
  const out = { ok: true, profile: p, decrypted, decryptFailed, skippedEmpty, handle, ...res };
  if (appBoundEncrypted) {
    out.appBoundEncrypted = appBoundEncrypted;
    out.note = `${appBoundEncrypted} cookie(s) use App-Bound Encryption (v20) — not importable by the macOS v10 path`;
  }
  return out;
}

// CLI entry (only when run directly, not when imported by cli.mjs).
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const has = (f) => { const i = args.indexOf(f); if (i >= 0) { args.splice(i, 1); return true; } return false; };
  const opt = (f) => { const i = args.indexOf(f); if (i >= 0) { const v = args[i + 1]; args.splice(i, 2); return v; } return undefined; };
  const dryRun = has("--dry-run");
  const headed = has("--headed");
  const profile = opt("--profile") || "Default";
  const domainsRaw = opt("--domains");
  const domains = domainsRaw ? domainsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const session = args[0];
  if (!session) { console.error("usage: jbrowser import-chrome <session> [--domains a.com,b.com] [--profile Default] [--dry-run] [--headed]"); process.exit(2); }
  importChrome({ session, domains, profile, dryRun, headed })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error("error:", e?.message || String(e)); process.exit(1); });
}
