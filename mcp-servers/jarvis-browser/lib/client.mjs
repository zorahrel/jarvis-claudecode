/**
 * Thin client to the jarvis-browser daemon. Auto-spawns the daemon (detached)
 * if it is not already listening, so any caller — the CLI or each agent's MCP
 * front — transparently shares the one long-lived browser fleet.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(__dirname, "..", "daemon.mjs");
const PORT = Number(process.env.JARVIS_BROWSER_PORT || 3344);
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch { return false; }
}

let spawning = null;
export async function ensureDaemon() {
  if (await health()) return true;
  if (!spawning) {
    spawning = (async () => {
      const child = spawn(process.execPath, [DAEMON], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
      for (let i = 0; i < 50; i++) { // up to ~10s
        await sleep(200);
        if (await health()) return true;
      }
      throw new Error("jarvis-browser daemon failed to start");
    })();
  }
  try { return await spawning; } finally { spawning = null; }
}

export async function rpc(method, params = {}) {
  await ensureDaemon();
  const res = await fetch(`${BASE}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(120000),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}
