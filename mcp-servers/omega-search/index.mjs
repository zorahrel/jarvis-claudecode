#!/usr/bin/env node
/**
 * omega-search — minimal single-tool MCP server (zero deps).
 *
 * Exposes ONE on-demand tool, `omega_search`, that proxies OMEGA's local HTTP
 * API (GET :3343/search). This is the PULL half of Jarvis memory: instead of the
 * old omega-surface.py hook injecting top-K memories into every prompt (noisy),
 * the agent calls this tool only when it actually needs to recall past
 * decisions/fixes/preferences — mirroring OpenClaw's `memory_search`.
 *
 * Mounted as a PARKED gateway child (autoMount:false): brought online with
 * gateway_mount({name:"omega"}) when recall is wanted, otherwise absent from the
 * tool pool. Speaks newline-delimited JSON-RPC over stdio (MCP stdio transport).
 */
import { createInterface } from "node:readline";
import http from "node:http";

const API = process.env.OMEGA_HTTP_URL || "http://127.0.0.1:3343";
const NAME = "omega-search";
const VERSION = "1.0.0";

const TOOL = {
  name: "omega_search",
  description:
    "Search Jarvis episodic memory (OMEGA, past sessions) for relevant prior " +
    "decisions, fixes, preferences, or context. Pull-based recall: call this " +
    "when you need to remember earlier work — it is NOT injected automatically.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to recall (natural language)" },
      limit: { type: "number", description: "Max memories to return (default 5)", default: 5 },
    },
    required: ["query"],
  },
};

function omegaSearch(query, limit) {
  return new Promise((resolve) => {
    const url = `${API}/search?q=${encodeURIComponent(String(query).slice(0, 512))}&limit=${Number(limit) || 5}`;
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const payload = JSON.parse(data);
          const hits = (payload.results || []).map((r) => {
            const meta = r.metadata || {};
            const text = String(r.memory || "").replace(/\s+/g, " ").trim();
            const tag = meta.event_type || meta.memory_type || "memory";
            const topic = meta.topic ? ` (${meta.topic})` : "";
            return `- [${tag}]${topic} ${text.slice(0, 600)}`;
          });
          resolve(hits.length ? hits.join("\n") : "No relevant memories found.");
        } catch {
          resolve("OMEGA search: unparseable response.");
        }
      });
    });
    req.on("error", () => resolve("OMEGA unreachable (:3343 daemon down?)."));
    req.on("timeout", () => { req.destroy(); resolve("OMEGA search timed out."); });
  });
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(req) {
  const { id, method, params } = req;
  // Notifications (no id) need no reply.
  if (id === undefined || id === null) return;

  if (method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        // Echo the client's protocol version for maximum compatibility.
        protocolVersion: (params && params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: VERSION },
      },
    });
  }
  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: [TOOL] } });
  }
  if (method === "tools/call") {
    const args = (params && params.arguments) || {};
    if (params && params.name === "omega_search") {
      const text = await omegaSearch(args.query, args.limit);
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    }
    return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params && params.name}` } });
  }
  if (method === "ping") {
    return send({ jsonrpc: "2.0", id, result: {} });
  }
  // Unknown method → proper JSON-RPC error so the client never hangs.
  return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let req;
  try { req = JSON.parse(s); } catch { return; }
  Promise.resolve(handle(req)).catch(() => {});
});
