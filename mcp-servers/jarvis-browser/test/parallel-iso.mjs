#!/usr/bin/env node
/**
 * Verifies the three things the tool exists for:
 *   A) N concurrent sessions are ISOLATED (no cookie/localStorage bleed) and run
 *      in PARALLEL (wall time ≈ one session, not the sum).
 *   B) Deterministic interaction works (snapshot -> fill -> click -> read back).
 *   C) Lifecycle is clean (closeAll leaves zero sessions).
 */
import { rpc } from "../lib/client.mjs";

let failures = 0;
const assert = (cond, msg) => { console.log(`${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures++; };
const t = (ms) => `${ms}ms`;

await rpc("closeAll"); // start from a clean fleet

// ---------- A) isolation + parallelism ----------
const NAMES = ["isoA", "isoB", "isoC"];
console.log(`\n[A] ${NAMES.length} concurrent isolated sessions`);
const t0 = Date.now();
const perSession = await Promise.all(NAMES.map(async (name) => {
  const tn = Date.now();
  await rpc("navigate", { name, url: "https://example.com" });
  // write a per-session marker into localStorage + a cookie
  await rpc("eval", { name, expression: `localStorage.setItem('who', ${JSON.stringify(name)}); document.cookie='who=${name};path=/'; return 'set';` });
  // read both back
  const ls = await rpc("eval", { name, expression: `return localStorage.getItem('who');` });
  const ck = await rpc("eval", { name, expression: `return document.cookie;` });
  return { name, ls: ls.result, ck: ck.result, ms: Date.now() - tn };
}));
const parallelMs = Date.now() - t0;

for (const r of perSession) {
  assert(r.ls === r.name, `session ${r.name}: localStorage.who === "${r.name}" (got ${JSON.stringify(r.ls)})`);
  assert(r.ck.includes(`who=${r.name}`) && !NAMES.filter(n => n !== r.name).some(n => r.ck.includes(`who=${n}`)),
    `session ${r.name}: cookie isolated (got ${JSON.stringify(r.ck)})`);
}
const slowest = Math.max(...perSession.map(r => r.ms));
assert(parallelMs < slowest * 1.8, `ran in parallel: wall ${t(parallelMs)} < 1.8× slowest-single ${t(slowest)}`);

const st1 = await rpc("status");
assert(st1.sessions.length === NAMES.length, `daemon reports ${NAMES.length} live sessions (got ${st1.sessions.length})`);

// ---------- B) deterministic interaction ----------
console.log(`\n[B] snapshot -> fill -> click -> read back`);
const form = "data:text/html," + encodeURIComponent(`
  <h1>Login</h1>
  <input id="u" placeholder="username">
  <input id="p" type="password" placeholder="password">
  <button onclick="document.getElementById('out').textContent='hello '+document.getElementById('u').value">Sign in</button>
  <div id="out"></div>`);
const nav = await rpc("navigate", { name: "form", url: form });
console.log("  snapshot:\n" + nav.text.split("\n").map(l => "    " + l).join("\n"));
const refU = (nav.text.match(/\[(\d+)\] textbox "username"/) || [])[1];
const refBtn = (nav.text.match(/\[(\d+)\] button "Sign in"/) || [])[1];
assert(!!refU && !!refBtn, `snapshot exposed username(ref ${refU}) + button(ref ${refBtn})`);
await rpc("act", { name: "form", action: "fill", ref: Number(refU), text: "attilio" });
const afterClick = await rpc("act", { name: "form", action: "click", ref: Number(refBtn) });
const outVal = await rpc("eval", { name: "form", expression: `return document.getElementById('out').textContent;` });
assert(outVal.result === "hello attilio", `click ran the handler with typed value (got ${JSON.stringify(outVal.result)})`);
assert(typeof afterClick.text === "string", "act returned an incremental snapshot delta");

// extract structured (0 LLM)
const ex = await rpc("extract", { name: "form", fields: { heading: "h1" } });
assert(ex.data.heading === "Login", `extract pulled heading deterministically (got ${JSON.stringify(ex.data.heading)})`);

// ---------- C) lifecycle ----------
console.log(`\n[C] lifecycle`);
await rpc("closeAll");
const st2 = await rpc("status");
assert(st2.sessions.length === 0, `closeAll left 0 sessions (got ${st2.sessions.length})`);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} — parallel wall ${t(parallelMs)}`);
process.exit(failures === 0 ? 0 : 1);
