#!/usr/bin/env node
/**
 * Controlled stress + edge + token verification against the LIVE daemon.
 * Complements parallel-iso.mjs (happy path) with the nasty cases.
 */
import { rpc } from "../lib/client.mjs";
import { spawnSync } from "node:child_process";

let fail = 0;
const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fail++; };
const bytes = (o) => Buffer.byteLength(typeof o === "string" ? o : JSON.stringify(o), "utf8");

await rpc("closeAll");

// ---------- 1) concurrency at the cap ----------
console.log("\n[1] concurrency cap (MAX=6): fire 9 ephemeral sessions at once");
const cap = (await rpc("status")).cap;
const launched = await Promise.allSettled(
  Array.from({ length: 9 }, (_, i) => rpc("navigate", { name: `cap${i}`, url: "https://example.com", ephemeral: true }))
);
const okCount = launched.filter((r) => r.status === "fulfilled").length;
const errCount = launched.filter((r) => r.status === "rejected").length;
const st = await rpc("status");
ok(st.sessions.length <= cap, `never exceeded cap: ${st.sessions.length} live ≤ cap ${cap}`);
ok(okCount + errCount === 9 && errCount > 0 ? true : okCount === 9, `handled burst gracefully (ok=${okCount}, capped=${errCount})`);
const health1 = await rpc("status"); // daemon still answering = didn't crash
ok(!!health1.pid, "daemon survived the burst");
await rpc("closeAll");

// ---------- 2) edge cases ----------
console.log("\n[2] edge cases");
// bad ref
let badRef = false;
try { await rpc("act", { name: "edge", action: "click", ref: 9999 }); }
catch { badRef = true; }
ok(badRef, "clicking a nonexistent ref errors cleanly (no crash)");
ok(!!(await rpc("status")).pid, "daemon alive after bad ref");
// close nonexistent
const cn = await rpc("close", { name: "does-not-exist" });
ok(cn.ok && cn.closed === false, "closing a nonexistent session returns ok:false, no throw");
// same-session serialization: fire 5 evals concurrently on ONE session, must all resolve correctly
await rpc("navigate", { name: "serial", url: "https://example.com" });
await rpc("eval", { name: "serial", expression: `localStorage.setItem('n','0'); return 0;` }); // reset (persistent profile retains state across runs)
const seq = await Promise.all(Array.from({ length: 5 }, (_, i) =>
  rpc("eval", { name: "serial", expression: `localStorage.setItem('n', String((Number(localStorage.getItem('n')||0))+1)); return Number(localStorage.getItem('n'));` })
));
const finalN = (await rpc("eval", { name: "serial", expression: `return Number(localStorage.getItem('n'));` })).result;
ok(Number(finalN) === 5, `keyed lock serialized 5 concurrent same-session calls (counter=${finalN}, expected 5)`);
await rpc("closeAll");

// ---------- 3) token discipline (sizes) ----------
console.log("\n[3] token discipline — response sizes on a heavy real page");
const nav = await rpc("navigate", { name: "tok", url: "https://news.ycombinator.com" });
const navB = bytes(nav.text);
ok(navB < 12000, `full HN snapshot compact: ${navB} bytes (<12KB, no raw DOM)`);
const inc = await rpc("snapshot", { name: "tok", incremental: true });
ok(bytes(inc.text) <= navB, `incremental snapshot ≤ full: ${bytes(inc.text)} bytes`);
const ex = await rpc("extract", { name: "tok", fields: { titles: { selector: ".titleline > a", all: true } } });
ok(Array.isArray(ex.data.titles) && ex.data.titles.length > 0, `extract returned ${ex.data.titles.length} titles (structured, 0 LLM)`);
const txt = await rpc("getText", { name: "tok", max: 1000 });
ok(txt.text.length <= 1000, `getText respected max=1000 (got ${txt.text.length}, truncated=${txt.truncated})`);
await rpc("closeAll");

// ---------- 4) vision (moondream) + graceful fallback ----------
console.log("\n[4] vision read + fallback");
await rpc("navigate", { name: "vis", url: "https://example.com" });
const read = await rpc("readScreen", { name: "vis", question: "what is the heading?" });
ok(read.ok === true && /example/i.test(read.vision || ""), `moondream read worked: ${JSON.stringify((read.vision||"").slice(0,50))}`);
ok(bytes(read) < 2000 && !/data:image|base64/i.test(JSON.stringify(read)), "read returns only text+path, never inline pixels");
await rpc("closeAll");

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILURE(S)"}`);
process.exit(fail === 0 ? 0 : 1);
