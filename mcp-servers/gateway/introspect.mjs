#!/usr/bin/env node
/**
 * introspect.mjs — connect to a set of MCP servers and dump their tool lists.
 *
 * Input: a JSON file path (argv[2]) holding an array of server descriptors:
 *   [{ name, transport:"stdio", command, args?, env? } |
 *    { name, transport:"http"|"sse", url, headers? }]
 * Output (stdout): { "<name>": { tools: [{name,description}], error: null } , ... }
 *
 * Used by the router to populate the dashboard's per-MCP tool view. The router
 * only passes servers it already knows are CONNECTED (from `claude mcp list`),
 * so no OAuth popups are triggered here. Each connect is bounded by a timeout.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { readFileSync } from "fs";

const TIMEOUT_MS = Number(process.env.INTROSPECT_TIMEOUT_MS || 8000);

function makeTransport(cfg) {
  if (cfg.transport === "stdio") {
    return new StdioClientTransport({
      command: cfg.command, args: cfg.args || [],
      env: { ...process.env, ...(cfg.env || {}) },
      stderr: "ignore",
    });
  }
  const opts = cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined;
  if (cfg.transport === "sse") return new SSEClientTransport(new URL(cfg.url), opts);
  return new StreamableHTTPClientTransport(new URL(cfg.url), opts);
}

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms (${label})`)), ms)),
  ]);
}

async function introspect(cfg) {
  const client = new Client({ name: "introspect", version: "1.0.0" }, { capabilities: {} });
  const transport = makeTransport(cfg);
  try {
    await withTimeout(client.connect(transport), TIMEOUT_MS, "connect");
    const { tools } = await withTimeout(client.listTools(), TIMEOUT_MS, "listTools");
    return { tools: tools.map((t) => ({ name: t.name, description: t.description || "" })), error: null };
  } catch (e) {
    return { tools: [], error: e.message };
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

const file = process.argv[2];
if (!file) { console.error("usage: introspect.mjs <jobs.json>"); process.exit(1); }
const jobs = JSON.parse(readFileSync(file, "utf8"));

const results = {};
await Promise.all(jobs.map(async (cfg) => {
  results[cfg.name] = await introspect(cfg);
}));

process.stdout.write(JSON.stringify(results));
process.exit(0);
