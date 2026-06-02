import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const transport = new StdioClientTransport({ command: "node", args: [join(__dirname, "..", "mcp.mjs")] });
const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.length, "->", tools.map(t => t.name).join(", "));

const nav = await client.callTool({ name: "browser_navigate", arguments: { session: "mcpsmoke", url: "https://example.com" } });
console.log("\nnavigate ->\n" + nav.content[0].text.split("\n").map(l => "  " + l).join("\n"));

const status = await client.callTool({ name: "browser_status", arguments: {} });
const st = JSON.parse(status.content[0].text);
console.log("\nstatus: sessions=" + st.sessions.length + " names=" + st.sessions.map(s=>s.name).join(","));

const close = await client.callTool({ name: "browser_close", arguments: {} });
console.log("close-all ->", close.content[0].text);

await client.close();
console.log("\nMCP smoke OK");
process.exit(0);
