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
  jbrowser close <name> | jbrowser close-all

Options: --headed (visible window), --ephemeral (no persistent profile/login), --full (full snapshot)
Session names are isolated: different names never share cookies/tabs and run in parallel.`;

const name = rest[0];
const flags = { persist: !has("--ephemeral"), headed: has("--headed") };

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
    case "close": out(await rpc("close", { name })); break;
    case "close-all": out(await rpc("closeAll")); break;
    case "help": case "--help": case "-h": case undefined: console.log(HELP); break;
    default: console.error(`unknown command: ${cmd}\n`); console.log(HELP); process.exit(2);
  }
} catch (e) {
  console.error("error:", e?.message || String(e));
  process.exit(1);
}
