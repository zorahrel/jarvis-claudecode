#!/usr/bin/env node
/**
 * mcp-distilled — exposes "distilled" workflows as MCP tools.
 *
 * A distillate is a directory under DISTILLED_DIR (default
 * ~/.claude/jarvis/distilled) containing:
 *   manifest.json  { name, description, inputSchema?, timeoutMs? }
 *   run            executable; receives the tool arguments as JSON on stdin,
 *                  prints its result to stdout (plain text or JSON)
 *
 * Directories starting with "_" (e.g. _drafts) are ignored — drafts are
 * promoted with approve.sh. The directory is rescanned on every tools/list,
 * so a gateway remount always picks up the current set.
 *
 * Mounted as a gateway child ("distilled") — tools appear as distilled__<name>.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const DISTILLED_DIR = process.env.DISTILLED_DIR || join(homedir(), ".claude/jarvis/distilled");
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 1_000_000;

const log = (...a) => console.error("[distilled]", ...a);

function scan() {
  const out = new Map(); // toolName -> { dir, manifest }
  if (!existsSync(DISTILLED_DIR)) return out;
  for (const entry of readdirSync(DISTILLED_DIR)) {
    if (entry.startsWith("_") || entry.startsWith(".")) continue;
    const dir = join(DISTILLED_DIR, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const manifestPath = join(dir, "manifest.json");
      const runPath = join(dir, "run");
      if (!existsSync(manifestPath) || !existsSync(runPath)) {
        log(`skip ${entry}: missing manifest.json or run`);
        continue;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const name = String(manifest.name || entry);
      if (!NAME_RE.test(name)) {
        log(`skip ${entry}: invalid tool name "${name}"`);
        continue;
      }
      if (!manifest.description) {
        log(`skip ${entry}: manifest.description required`);
        continue;
      }
      out.set(name, { dir, manifest });
    } catch (e) {
      log(`skip ${entry}: ${e.message}`);
    }
  }
  return out;
}

function runDistillate(dir, manifest, args) {
  const timeout = Math.min(Number(manifest.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  return new Promise((resolve) => {
    const child = spawn(join(dir, "run"), [], {
      cwd: dir,
      env: { ...process.env, DISTILLED_DIR },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", truncated = false, settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, text: `timeout after ${timeout}ms` });
    }, timeout);
    child.stdout.on("data", (b) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += b.toString("utf8");
      else truncated = true;
    });
    child.stderr.on("data", (b) => { if (stderr.length < 20_000) stderr += b.toString("utf8"); });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, text: `spawn error: ${e.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const body = stdout.trim() + (truncated ? "\n[output truncated]" : "");
      if (code === 0) resolve({ ok: true, text: body || "(no output)" });
      else resolve({ ok: false, text: `exit ${code}\n${body}\n${stderr.trim()}`.trim() });
    });
    try {
      child.stdin.write(JSON.stringify(args ?? {}));
      child.stdin.end();
    } catch { /* child died before stdin — close handler reports it */ }
  });
}

const server = new Server(
  { name: "mcp-distilled", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...scan().entries()].map(([name, { manifest }]) => ({
    name,
    description: manifest.description,
    inputSchema: manifest.inputSchema || { type: "object", properties: {} },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const entry = scan().get(name);
  if (!entry) {
    return { content: [{ type: "text", text: `unknown distillate: ${name}` }], isError: true };
  }
  const res = await runDistillate(entry.dir, entry.manifest, args);
  return { content: [{ type: "text", text: res.text }], isError: !res.ok };
});

await server.connect(new StdioServerTransport());
log(`ready — serving ${DISTILLED_DIR}`);
