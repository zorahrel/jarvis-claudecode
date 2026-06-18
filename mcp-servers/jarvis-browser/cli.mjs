#!/usr/bin/env node
/**
 * jbrowser — CLI front for the jarvis-browser daemon.
 * The daemon auto-starts on first use. All sessions are isolated by name.
 */
import { rpc } from "./lib/client.mjs";

const [, , cmd, ...rest] = process.argv;
const has = (f) => { const i = rest.indexOf(f); if (i >= 0) { rest.splice(i, 1); return true; } return false; };
const opt = (f, d) => { const i = rest.indexOf(f); if (i >= 0) { const v = rest[i + 1]; rest.splice(i, 2); return v; } return d; };

function out(o) { console.log(typeof o === "string" ? o : JSON.stringify(o, null, 2)); }
function obs(r) {
  // pretty-print an observe/act result compactly
  if (r.url) console.log(`# ${r.title || ""}\n# ${r.url}${r.count != null ? `  (${r.count} elements)` : ""}`);
  console.log(r.text ?? JSON.stringify(r, null, 2));
}

const HELP = `jbrowser — local parallel isolated browser sessions (Jarvis)

  jbrowser status                      live sessions + daemon info
  jbrowser nav   <name> <url>          create/reuse session <name>, navigate, show snapshot
  jbrowser snap  <name> [--full]       re-snapshot (incremental by default)
  jbrowser click <name> <ref>
  jbrowser fill  <name> <ref> <text>   clear+type into a field
  jbrowser type  <name> <ref> <text>   type key-by-key
  jbrowser press <name> <key> [ref]    e.g. Enter, Tab, Escape
  jbrowser check|uncheck <name> <ref>
  jbrowser select <name> <ref> <value>
  jbrowser scroll <name> [dy]          default 600
  jbrowser text  <name> [ref]          readable innerText (truncated)
  jbrowser extract <name> '<json>'     {"title":"h1","links":{"selector":"a","all":true,"attr":"href"}}
  jbrowser shot  <name> [--full] [--ref N]   screenshot -> file path
  jbrowser read  <name> ["question"]         SEE the screen via moondream -> text (no image in context)
  jbrowser eval  <name> '<js>'         run JS in the page (returns value)

  Auth / local-cache:
  jbrowser login <name> <url> [--wait-selector CSS|--wait-url SUB] [--timeout MS]
                                       open a VISIBLE window for sign-in/sign-up; YOU complete it,
                                       the login is then cached in the profile (reused headless later)
  jbrowser whoami <name>               which sites this profile is logged into (cookie hosts; names only)
  jbrowser save-state <name> [handle] [--origins https://a,https://b]
                                       export the login cache (cookies always; localStorage only for
                                       visited origins — save right after login, or pass --origins)
  jbrowser load-state <name> <handle> [--headed]   seed a session from a saved state handle
                                       (--path <file.json> for an arbitrary file needs JARVIS_BROWSER_ALLOW_STATE_PATH=1)
  jbrowser profiles                    list on-disk persistent profiles (durable login caches)
  jbrowser rm-profile <name>           delete a profile (to Trash; must not be live)
  jbrowser import-chrome <name> [--domains a.com,b.com] [--profile Default] [--dry-run]
                                       seed a session from your REAL Chrome cookies (macOS); reuses
                                       existing logins (never reads passwords). --dry-run = list scope.

  jbrowser close <name> | jbrowser close-all

Options: --headed (visible window), --ephemeral (no persistent profile/login), --full (full snapshot)
Session names are isolated: different names never share cookies/tabs and run in parallel.
Login flow: "jbrowser login <name> <signin-url>" opens a real window → you type your own password/2FA
→ "jbrowser whoami <name>" confirms. Never enter credentials through automation; the human signs in.`;

// Strip global flags FIRST, then read the session name — otherwise a leading
// flag (e.g. `jbrowser nav --headed work url`) would be captured as the name and
// spawn a junk profile dir named after the flag.
const flags = { persist: !has("--ephemeral"), headed: has("--headed") };
const name = rest[0];
const NO_NAME = ["status", "close-all", "profiles", "help", "--help", "-h", undefined];
if (!NO_NAME.includes(cmd) && (name === undefined || /^-/.test(name))) {
  console.error(`error: '${cmd}' needs a session name as its first argument (got ${name === undefined ? "none" : `'${name}'`}).`);
  process.exit(2);
}

try {
  switch (cmd) {
    case "status": out(await rpc("status")); break;
    case "nav": {
      const url = rest[1];
      if (!name || !url) throw new Error("usage: jbrowser nav <name> <url>");
      obs(await rpc("navigate", { name, url, ...flags })); break;
    }
    case "snap": obs(await rpc("snapshot", { name, incremental: !has("--full"), ...flags })); break;
    case "click": obs(await rpc("act", { name, action: "click", ref: Number(rest[1]), ...flags })); break;
    case "fill": obs(await rpc("act", { name, action: "fill", ref: Number(rest[1]), text: rest.slice(2).join(" "), ...flags })); break;
    case "type": obs(await rpc("act", { name, action: "type", ref: Number(rest[1]), text: rest.slice(2).join(" "), ...flags })); break;
    case "press": {
      const maybeRef = rest[2] !== undefined ? Number(rest[2]) : undefined;
      obs(await rpc("act", { name, action: "press", key: rest[1], ref: maybeRef, ...flags })); break;
    }
    case "check": obs(await rpc("act", { name, action: "check", ref: Number(rest[1]), ...flags })); break;
    case "uncheck": obs(await rpc("act", { name, action: "uncheck", ref: Number(rest[1]), ...flags })); break;
    case "select": obs(await rpc("act", { name, action: "select", ref: Number(rest[1]), value: rest[2], ...flags })); break;
    case "scroll": obs(await rpc("act", { name, action: "scroll", dy: Number(rest[1] || 600), ...flags })); break;
    case "text": out(await rpc("getText", { name, ref: rest[1] !== undefined ? Number(rest[1]) : undefined, ...flags })); break;
    case "extract": out(await rpc("extract", { name, fields: JSON.parse(rest[1] || "{}"), ...flags })); break;
    case "shot": out(await rpc("screenshot", { name, fullPage: has("--full"), ref: opt("--ref") !== undefined ? Number(opt("--ref")) : undefined, ...flags })); break;
    case "read": { const long = has("--long"); const q = rest.slice(1).join(" ") || undefined; out(await rpc("readScreen", { name, question: q, long, ...flags })); break; }
    case "eval": out(await rpc("eval", { name, expression: rest.slice(1).join(" "), ...flags })); break;
    case "login": {
      const waitUrl = opt("--wait-url");
      const waitSelector = opt("--wait-selector");
      const timeout = opt("--timeout");
      const url = rest[1];
      const r = await rpc("login", { name, url, waitUrl, waitSelector, timeoutMs: timeout !== undefined ? Number(timeout) : undefined });
      obs(r);
      if (r.handoff) console.log(`\n→ A visible window is open. Sign in / sign up there yourself (password, 2FA, CAPTCHA).\n→ When done: jbrowser whoami ${name}`);
      else console.log(`\n→ signedIn=${r.signedIn}. Verify with: jbrowser whoami ${name}`);
      break;
    }
    case "whoami": out(await rpc("whoami", { name })); break;
    case "save-state": {
      const path = opt("--path"); // arbitrary file (needs JARVIS_BROWSER_ALLOW_STATE_PATH=1)
      const origins = opt("--origins"); // comma-separated origins to visit so their localStorage is captured
      out(await rpc("saveState", { name, state: rest[1], path, origins: origins ? origins.split(",").map((s) => s.trim()).filter(Boolean) : undefined }));
      break;
    }
    case "load-state": {
      const path = opt("--path");
      const handle = rest[1];
      if (!handle && !path) throw new Error("usage: jbrowser load-state <name> <handle> | jbrowser load-state <name> --path <file.json>");
      out(await rpc("loadState", { name, state: handle, path, headed: flags.headed }));
      break;
    }
    case "profiles": out(await rpc("profiles")); break;
    case "rm-profile": out(await rpc("removeProfile", { name })); break;
    case "import-chrome": {
      const { importChrome } = await import("./import-chrome.mjs");
      const domainsRaw = opt("--domains");
      const profile = opt("--profile") || "Default";
      const dryRun = has("--dry-run");
      out(await importChrome({
        session: name,
        domains: domainsRaw ? domainsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [],
        profile, dryRun, headed: flags.headed,
      }));
      break;
    }
    case "close": out(await rpc("close", { name })); break;
    case "close-all": out(await rpc("closeAll")); break;
    case "help": case "--help": case "-h": case undefined: console.log(HELP); break;
    default: console.error(`unknown command: ${cmd}\n`); console.log(HELP); process.exit(2);
  }
} catch (e) {
  console.error("error:", e?.message || String(e));
  process.exit(1);
}
