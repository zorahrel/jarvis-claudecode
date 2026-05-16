/**
 * Proactive HTTP-only OAuth token refresher for stdio+npx-mcp-remote MCPs.
 *
 * Problem: mcp-remote 0.1.x opens an unsolicited browser tab whenever it
 * encounters an expired access_token, BEFORE attempting the refresh handshake
 * with the cached refresh_token. With providers that issue short-TTL access
 * tokens (Vercel: 1h, Cloudflare: similar), every fresh Claude SDK session
 * that attaches the server pops a tab — even when the refresh would have
 * succeeded silently.
 *
 * Fix: pre-empt the expiry by refreshing tokens.json BEFORE mcp-remote ever
 * notices. We never spawn mcp-remote. We just:
 *
 *   1. Read each stdio+mcp-remote MCP from ~/.claude.json.
 *   2. For each, load `~/.mcp-auth/mcp-remote-VER/HASH_tokens.json`
 *      (HASH = md5 of URL).
 *   3. If `mtime + expires_in - REFRESH_BUFFER_SEC > now`, skip — fresh.
 *   4. Otherwise: discover the token endpoint via standard OAuth 2.1 /
 *      RFC 8414 metadata. Cache the discovery result next to the token file.
 *   5. POST grant_type=refresh_token to the token endpoint with the cached
 *      refresh_token and client_id (from client_info.json).
 *   6. Atomically rewrite tokens.json with the new access_token /
 *      refresh_token / expires_in.
 *
 * Result: when mcp-remote spawns (from any Claude session — router, GUI, CLI),
 * it always finds a fresh token. No browser tab. No popup.
 *
 * If discovery fails or the provider returns invalid_grant (refresh_token
 * actually revoked), we log WARN and let mcp-status's rescue pass quarantine
 * the server to mcp-pending.json on its next tick — that surfaces an
 * Approve button in the dashboard for explicit re-auth.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { logger } from "./logger";

const log = logger.child({ module: "mcp-token-refresher" });

const HOME = process.env.HOME ?? "";
const AUTH_ROOT = join(HOME, ".mcp-auth");
const CONFIG_PATH = join(HOME, ".claude.json");

/** How often we wake up to scan. 5 min is well under the typical 1h TTL. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;
/** Initial delay after boot — give the router time to settle. */
const INITIAL_DELAY_MS = 30 * 1000;
/** Refresh when the token is within this many seconds of expiry. 10 min
 *  buffer means even a 1h TTL gets refreshed 50 min in, well before any
 *  spawn could see it as expired. */
const REFRESH_BUFFER_SEC = 10 * 60;
/** HTTP request deadline. Token endpoints respond in <1s normally. */
const HTTP_TIMEOUT_MS = 10_000;

let intervalHandle: NodeJS.Timeout | null = null;
let initialHandle: NodeJS.Timeout | null = null;

interface TokensFile {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

interface ClientInfo {
  client_id: string;
  client_secret?: string;
  redirect_uris?: string[];
}

interface JarvisMeta {
  token_endpoint: string;
  discovered_at: number;
}

interface AsMetadata {
  token_endpoint?: string;
  issuer?: string;
}

interface ResourceMetadata {
  authorization_servers?: string[];
}

/** Find the freshest tokens.json + companion files for a given server URL. */
function locateAuthFiles(url: string): {
  hash: string;
  dir: string;
  tokensPath: string;
  clientInfoPath: string;
  metaPath: string;
} | null {
  if (!existsSync(AUTH_ROOT)) return null;
  const hash = createHash("md5").update(url).digest("hex");
  let best: { dir: string; mtime: number } | null = null;
  for (const verDir of readdirSync(AUTH_ROOT).filter(n => n.startsWith("mcp-remote-"))) {
    const dir = join(AUTH_ROOT, verDir);
    const tokensPath = join(dir, `${hash}_tokens.json`);
    if (!existsSync(tokensPath)) continue;
    const mtime = statSync(tokensPath).mtimeMs;
    if (!best || mtime > best.mtime) best = { dir, mtime };
  }
  if (!best) return null;
  return {
    hash,
    dir: best.dir,
    tokensPath: join(best.dir, `${hash}_tokens.json`),
    clientInfoPath: join(best.dir, `${hash}_client_info.json`),
    metaPath: join(best.dir, `${hash}_jarvis_meta.json`),
  };
}

/**
 * Discover the OAuth token_endpoint for an MCP server. Honors the MCP-spec
 * Protected Resource Metadata (PRM) if present, otherwise falls back to
 * RFC 8414 discovery against the URL's origin. Caches the result.
 */
async function discoverTokenEndpoint(serverUrl: string, metaPath: string): Promise<string | null> {
  // Cache check — re-use a recent discovery (24h TTL) instead of hitting the
  // network every tick.
  if (existsSync(metaPath)) {
    try {
      const cached = JSON.parse(readFileSync(metaPath, "utf-8")) as JarvisMeta;
      if (cached.token_endpoint && Date.now() - cached.discovered_at < 24 * 60 * 60 * 1000) {
        return cached.token_endpoint;
      }
    } catch { /* ignore corrupt cache */ }
  }

  const origin = new URL(serverUrl).origin;
  const candidates: string[] = [];

  // 1) PRM (RFC 9728) — points to the AS.
  try {
    const prmUrl = `${serverUrl.replace(/\/+$/, "")}/.well-known/oauth-protected-resource`;
    const res = await fetchWithTimeout(prmUrl);
    if (res.ok) {
      const prm = await res.json() as ResourceMetadata;
      for (const as of prm.authorization_servers ?? []) candidates.push(as);
    }
  } catch { /* ignore */ }

  // 2) Origin AS directly (most providers we've seen).
  candidates.push(origin);

  for (const as of candidates) {
    try {
      const asUrl = `${as.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`;
      const res = await fetchWithTimeout(asUrl);
      if (!res.ok) continue;
      const meta = await res.json() as AsMetadata;
      if (meta.token_endpoint) {
        const cache: JarvisMeta = { token_endpoint: meta.token_endpoint, discovered_at: Date.now() };
        try { writeFileSync(metaPath, JSON.stringify(cache, null, 2)); } catch { /* best-effort */ }
        return meta.token_endpoint;
      }
    } catch { /* try next candidate */ }
  }

  return null;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Atomically write tokens.json (write to .tmp, rename). Preserves 0600. */
function writeTokensAtomic(path: string, payload: TokensFile): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Perform the refresh for one server. Returns true on success. */
async function refreshOne(name: string, url: string): Promise<{ ok: boolean; reason?: string; refreshed?: boolean }> {
  const paths = locateAuthFiles(url);
  if (!paths) return { ok: true, reason: "no tokens.json on disk" };

  let tokens: TokensFile;
  try { tokens = JSON.parse(readFileSync(paths.tokensPath, "utf-8")) as TokensFile; }
  catch (e) { return { ok: false, reason: `read tokens: ${e instanceof Error ? e.message : String(e)}` }; }

  if (!tokens.refresh_token) return { ok: true, reason: "no refresh_token in tokens.json" };

  const mtimeMs = statSync(paths.tokensPath).mtimeMs;
  const expiresIn = tokens.expires_in ?? 0;
  const expiresAtMs = mtimeMs + expiresIn * 1000;
  const remainingSec = Math.floor((expiresAtMs - Date.now()) / 1000);

  if (remainingSec > REFRESH_BUFFER_SEC) {
    return { ok: true, reason: `still fresh (${remainingSec}s remaining)`, refreshed: false };
  }

  let clientInfo: ClientInfo;
  try { clientInfo = JSON.parse(readFileSync(paths.clientInfoPath, "utf-8")) as ClientInfo; }
  catch (e) { return { ok: false, reason: `read client_info: ${e instanceof Error ? e.message : String(e)}` }; }

  const tokenEndpoint = await discoverTokenEndpoint(url, paths.metaPath);
  if (!tokenEndpoint) return { ok: false, reason: "couldn't discover token_endpoint" };

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: clientInfo.client_id,
  });
  // Confidential clients (e.g. supabase) include client_secret.
  if (clientInfo.client_secret) body.set("client_secret", clientInfo.client_secret);

  let res: Response;
  try {
    res = await fetchWithTimeout(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: body.toString(),
    });
  } catch (e) {
    return { ok: false, reason: `POST ${tokenEndpoint}: ${e instanceof Error ? e.message : String(e)}` };
  }

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, reason: `${tokenEndpoint} returned ${res.status}: ${text.slice(0, 200)}` };
  }

  let parsed: TokensFile;
  try { parsed = JSON.parse(text) as TokensFile; }
  catch (e) { return { ok: false, reason: `parse response: ${e instanceof Error ? e.message : String(e)}` }; }

  if (!parsed.access_token) return { ok: false, reason: "response missing access_token" };

  // Merge: providers that don't rotate refresh_token omit it from the response —
  // keep the existing one in that case.
  const next: TokensFile = {
    ...tokens,
    ...parsed,
    refresh_token: parsed.refresh_token ?? tokens.refresh_token,
  };
  writeTokensAtomic(paths.tokensPath, next);

  log.info(
    { name, url, prevRemaining: remainingSec, newExpiresIn: next.expires_in },
    "[mcp-token-refresher] refreshed token",
  );
  return { ok: true, refreshed: true };
}

async function tick(): Promise<void> {
  if (!existsSync(CONFIG_PATH)) return;
  let conf: { mcpServers?: Record<string, { type?: string; command?: string; args?: string[] }> };
  try { conf = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); }
  catch { return; }

  const targets: { name: string; url: string }[] = [];
  for (const [name, cfg] of Object.entries(conf.mcpServers ?? {})) {
    if (cfg?.type !== "stdio") continue;
    if (!cfg.args?.some(a => a === "mcp-remote")) continue;
    const url = cfg.args.find(a => /^https?:\/\//.test(a));
    if (url) targets.push({ name, url });
  }

  if (targets.length === 0) {
    log.debug("[mcp-token-refresher] no stdio+mcp-remote servers to scan");
    return;
  }

  const results = await Promise.all(targets.map(t => refreshOne(t.name, t.url).then(r => ({ ...t, ...r }))));
  const refreshed = results.filter(r => r.refreshed);
  const errors = results.filter(r => !r.ok);
  // INFO at the tick boundary so operators can see the refresher heartbeat
  // and at-a-glance "which tokens did I just rotate" without enabling debug.
  log.info(
    { scanned: targets.length, refreshed: refreshed.length, errors: errors.length, refreshedNames: refreshed.map(r => r.name) },
    "[mcp-token-refresher] tick",
  );
  for (const e of errors) log.warn({ name: e.name, reason: e.reason }, "[mcp-token-refresher] refresh failed");
}

export function startMcpTokenRefresher(): void {
  if (intervalHandle) return;
  log.info({ intervalMs: POLL_INTERVAL_MS, bufferSec: REFRESH_BUFFER_SEC }, "MCP Token Refresher starting (HTTP-only)");
  initialHandle = setTimeout(() => {
    tick().catch(err => log.error({ err }, "[mcp-token-refresher] initial tick failed"));
  }, INITIAL_DELAY_MS);
  intervalHandle = setInterval(() => {
    tick().catch(err => log.error({ err }, "[mcp-token-refresher] tick failed"));
  }, POLL_INTERVAL_MS);
}

export function stopMcpTokenRefresher(): void {
  if (initialHandle) { clearTimeout(initialHandle); initialHandle = null; }
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}
