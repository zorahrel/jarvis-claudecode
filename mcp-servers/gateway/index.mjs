#!/usr/bin/env node
/**
 * mcp-gateway — a dynamic MCP "MCP of MCPs".
 *
 * Loaded ONCE at session boot as a normal stdio MCP server. From then on it can
 * mount/unmount *child* MCP servers at runtime and proxy their tools, emitting
 * `notifications/tools/list_changed` so the client (Claude Code) picks up new
 * tools WITHOUT restarting the session.
 *
 * Child tools are exposed namespaced as `<child>__<tool>`. Three always-on meta
 * tools manage the registry:
 *   - gateway_list                     → mounted children + their tools
 *   - gateway_mount {name, ...config}  → connect a child, register its tools, notify
 *   - gateway_unmount {name}           → disconnect a child, drop its tools, notify
 *
 * Children persist in gateway-config.json so they reconnect on next boot.
 * It also writes a flat registry to ../../state/mcp-gateway-tools.json for the
 * dashboard to read (server → tools).
 *
 * Child transports supported: stdio ({command,args,env}) and http ({url,headers}).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Where the persistent child registry lives. Override with MCP_GATEWAY_CONFIG.
const CONFIG_PATH = process.env.MCP_GATEWAY_CONFIG || join(__dirname, "gateway-config.json");
// Optional: a flat server→tools snapshot for external dashboards to read.
// Disabled unless MCP_GATEWAY_REGISTRY is set to a writable path.
const REGISTRY_PATH = process.env.MCP_GATEWAY_REGISTRY || null;
const SEP = "__"; // namespace separator: <child>__<tool>

const log = (...a) => console.error("[mcp-gateway]", ...a);

// ---- persistence ----
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { children: [] };
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")); }
  catch (e) { log("config parse error:", e.message); return { children: [] }; }
}
function saveConfig(children) {
  const serializable = children.map(({ name, transport, command, args, env, url, headers }) =>
    ({ name, transport, command, args, env, url, headers }));
  writeFileSync(CONFIG_PATH, JSON.stringify({ children: serializable }, null, 2) + "\n");
}
function writeRegistry(state) {
  if (!REGISTRY_PATH) return;
  try {
    mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
    const out = {};
    for (const [name, c] of state.children) {
      out[name] = { transport: c.cfg.transport, tools: c.tools.map((t) => t.name), error: c.error || null };
    }
    writeFileSync(REGISTRY_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), children: out }, null, 2) + "\n");
  } catch (e) { log("registry write error:", e.message); }
}

// ---- runtime state ----
const state = {
  children: new Map(),       // name -> { cfg, client, tools:[{name,description,inputSchema}], error }
  toolIndex: new Map(),      // prefixedName -> { child, original }
};

function rebuildToolIndex() {
  state.toolIndex.clear();
  for (const [name, c] of state.children) {
    for (const t of c.tools) {
      state.toolIndex.set(`${name}${SEP}${t.name}`, { child: name, original: t.name });
    }
  }
}

function makeTransport(cfg) {
  if (cfg.transport === "stdio") {
    return new StdioClientTransport({
      command: cfg.command,
      args: cfg.args || [],
      env: { ...process.env, ...(cfg.env || {}) },
    });
  }
  if (cfg.transport === "http") {
    const opts = cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined;
    return new StreamableHTTPClientTransport(new URL(cfg.url), opts);
  }
  if (cfg.transport === "sse") {
    const opts = cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined;
    return new SSEClientTransport(new URL(cfg.url), opts);
  }
  throw new Error(`unknown transport: ${cfg.transport}`);
}

async function connectChild(cfg) {
  const client = new Client({ name: `gateway->${cfg.name}`, version: "1.0.0" }, { capabilities: {} });
  const transport = makeTransport(cfg);
  await client.connect(transport);
  const { tools } = await client.listTools();
  return {
    cfg,
    client,
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    error: null,
  };
}

async function mountChild(cfg) {
  if (state.children.has(cfg.name)) {
    await unmountChild(cfg.name);
  }
  const c = await connectChild(cfg);
  state.children.set(cfg.name, c);
  rebuildToolIndex();
  return c;
}

async function unmountChild(name) {
  const c = state.children.get(name);
  if (!c) return false;
  try { await c.client.close(); } catch { /* ignore */ }
  state.children.delete(name);
  rebuildToolIndex();
  return true;
}

// ---- build the gateway server ----
const server = new Server(
  { name: "gateway", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
);

const META_TOOLS = [
  {
    name: "gateway_list",
    description: "List child MCP servers mounted in the gateway and the tools each exposes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "gateway_mount",
    description:
      "Mount a child MCP server at runtime and expose its tools (namespaced <name>__<tool>). " +
      "stdio: pass transport='stdio', command, args[], env{}. http/sse: pass transport, url, headers{}. " +
      "The new tools appear immediately via tools/list_changed — no session restart needed.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique child name (becomes the tool prefix)" },
        transport: { type: "string", enum: ["stdio", "http", "sse"], default: "stdio" },
        command: { type: "string", description: "stdio: executable" },
        args: { type: "array", items: { type: "string" }, description: "stdio: arguments" },
        env: { type: "object", description: "stdio: extra env vars" },
        url: { type: "string", description: "http/sse: endpoint URL" },
        headers: { type: "object", description: "http/sse: request headers (e.g. Authorization)" },
      },
      required: ["name"],
    },
  },
  {
    name: "gateway_unmount",
    description: "Unmount a child MCP server and remove its tools (emits tools/list_changed).",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
];

function allTools() {
  const out = [...META_TOOLS];
  for (const [name, c] of state.children) {
    for (const t of c.tools) {
      out.push({
        name: `${name}${SEP}${t.name}`,
        description: `[${name}] ${t.description || ""}`.trim(),
        inputSchema: t.inputSchema || { type: "object", properties: {} },
      });
    }
  }
  return out;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools() }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  // ---- meta tools ----
  if (name === "gateway_list") {
    const children = [...state.children.entries()].map(([n, c]) => ({
      name: n, transport: c.cfg.transport, error: c.error || null,
      tools: c.tools.map((t) => t.name),
    }));
    return { content: [{ type: "text", text: JSON.stringify({ children }, null, 2) }] };
  }

  if (name === "gateway_mount") {
    try {
      const cfg = {
        name: args.name,
        transport: args.transport || "stdio",
        command: args.command, args: args.args, env: args.env,
        url: args.url, headers: args.headers,
      };
      if (!cfg.name) throw new Error("name is required");
      const c = await mountChild(cfg);
      saveConfig([...state.children.values()].map((x) => x.cfg));
      writeRegistry(state);
      await server.sendToolListChanged();
      return { content: [{ type: "text", text: JSON.stringify({ mounted: cfg.name, tools: c.tools.map((t) => `${cfg.name}${SEP}${t.name}`) }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error mounting: ${e.message}` }], isError: true };
    }
  }

  if (name === "gateway_unmount") {
    try {
      const ok = await unmountChild(args.name);
      saveConfig([...state.children.values()].map((x) => x.cfg));
      writeRegistry(state);
      await server.sendToolListChanged();
      return { content: [{ type: "text", text: JSON.stringify({ unmounted: ok ? args.name : null, found: ok }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error unmounting: ${e.message}` }], isError: true };
    }
  }

  // ---- proxied child tool ----
  const entry = state.toolIndex.get(name);
  if (!entry) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  const child = state.children.get(entry.child);
  if (!child) {
    return { content: [{ type: "text", text: `Child ${entry.child} not mounted` }], isError: true };
  }
  try {
    const result = await child.client.callTool({ name: entry.original, arguments: args });
    return result;
  } catch (e) {
    return { content: [{ type: "text", text: `Proxy error (${entry.child}.${entry.original}): ${e.message}` }], isError: true };
  }
});

// ---- boot ----
const cfg = loadConfig();
for (const childCfg of cfg.children || []) {
  try {
    await mountChild(childCfg);
    log(`mounted ${childCfg.name} (${childCfg.transport}) — ${state.children.get(childCfg.name).tools.length} tools`);
  } catch (e) {
    log(`failed to mount ${childCfg.name}: ${e.message}`);
    state.children.set(childCfg.name, { cfg: childCfg, client: null, tools: [], error: e.message });
  }
}
rebuildToolIndex();
writeRegistry(state);

await server.connect(new StdioServerTransport());
log(`ready — ${state.children.size} children, ${state.toolIndex.size} proxied tools + 3 meta`);
