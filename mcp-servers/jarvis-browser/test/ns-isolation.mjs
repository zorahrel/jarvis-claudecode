import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rpc } from "../lib/client.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const MCP = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp.mjs");
async function agent(key, url) {
  const tr = new StdioClientTransport({ command: "node", args: [MCP], env: { ...process.env, JARVIS_SESSION_KEY: key } });
  const c = new Client({ name: "a", version: "1" }, { capabilities: {} });
  await c.connect(tr);
  const r = await c.callTool({ name: "browser_navigate", arguments: { session: "main", url } });
  console.log(`[${key}] -> ${r.isError ? "ERROR " + r.content[0].text : "ok"}`);
  await c.close();
}
await Promise.all([ agent("tg-111", "https://example.com"), agent("wa-222", "https://example.org") ]);
const st = await rpc("status");
console.log("daemon sessions:");
for (const s of st.sessions) console.log("  " + s.name + " -> " + s.url);
const ok = st.sessions.length === 2 && new Set(st.sessions.map(s => s.url)).size === 2;
console.log(ok ? '\n✓ AUTO-ISOLATED: both agents used session "main" yet got separate browsers' : "\n✗ NOT isolated");
await rpc("closeAll");
process.exit(ok ? 0 : 1);
