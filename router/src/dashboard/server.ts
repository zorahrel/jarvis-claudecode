import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "http";
import { createServer as createHttpsServer } from "https";
import { readFileSync, existsSync, statSync } from "fs";
import { join, extname } from "path";
import { logger, setDashboardLogHook } from "../services/logger";
import { pushLog, type LogEntry } from "./state";
import { handleApi } from "./api";
import { attachWebSocket, broadcast, clientCount } from "./ws";

// Re-export for external consumers (handler.ts, index.ts)
export { pushLog, trackMessage, trackResponseTime, getCliSessions } from "./state";
export { broadcast, clientCount } from "./ws";
export type { RouterEvent, SessionEventData, ExchangeEventData, NotifyOutboundEventData } from "./ws";

// Wire pino logs to dashboard buffer + broadcast (cheap when no WS clients).
setDashboardLogHook((level, module, msg, extra) => {
  pushLog(level, module, msg, extra);
  if (clientCount() === 0) return;
  const entry: LogEntry = {
    ts: Date.now(),
    level,
    module,
    msg,
    ...(extra && Object.keys(extra).length ? { extra } : {}),
  };
  broadcast({ type: "log", data: entry });
});

const log = logger.child({ module: "dashboard" });
const HOME = process.env.HOME!;

// ---- React static file serving ----
const DIST_DIR = join(HOME, ".claude/jarvis/router/dashboard/dist");
const USE_REACT = existsSync(join(DIST_DIR, "index.html"));

// ---- Notch orb static serving ----
// The Notch surfaces (native WKWebView in the tray app + dashboard iframe
// mirror) share the same orb bundle. The canonical copy lives under the
// tray-app source tree — the Swift WKWebView loads it directly from disk and
// the HTTP dashboard serves it from the same path here, so there's one source
// of truth with no build step or duplication.
const NOTCH_ORB_DIR = join(HOME, ".claude/jarvis/tray-app/Sources/JarvisNotch/Orb");
const NOTCH_ORB_PREFIX = "/notch/orb/";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
};

function serveStatic(res: ServerResponse, filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    const ext = extname(filePath);
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    const content = readFileSync(filePath);
    const headers: Record<string, string> = { "Content-Type": mime };
    if (filePath.includes("/assets/")) {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    } else if (ext === ".html") {
      // HTML shells (index.html, notch.html) must never be cached — they
      // embed hashed asset URLs that change on every build. A stale HTML
      // would point browsers at a bundle that no longer exists, or serve
      // an old `NotchMirror` with outdated styles.
      headers["Cache-Control"] = "no-cache, must-revalidate";
    }
    res.writeHead(200, headers);
    res.end(content);
    return true;
  } catch { return false; }
}

const EMBED_STYLE_INJECTION =
  '<style>html,body{background:#08090a !important;}</style>';

function serveEmbeddedNotch(res: ServerResponse, filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const html = readFileSync(filePath, "utf-8").replace(
      "</head>",
      `  ${EMBED_STYLE_INJECTION}\n</head>`,
    );
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, must-revalidate",
    });
    res.end(html);
    return true;
  } catch { return false; }
}

function serveReactIndex(res: ServerResponse): void {
  const html = readFileSync(join(DIST_DIR, "index.html"), "utf-8")
    .replace("<title>dashboard</title>", "<title>Jarvis Router</title>");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache, must-revalidate",
  });
  res.end(html);
}

function serveBuildMissing(res: ServerResponse): void {
  res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html><html><head><title>Jarvis Router</title><style>
body{font-family:system-ui;background:#08090a;color:#f7f8f8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
.card{max-width:520px;padding:32px;background:#141418;border:1px solid rgba(255,255,255,0.06);border-radius:8px;}
code{background:#08090a;padding:2px 6px;border-radius:3px;font-family:'JetBrains Mono',monospace;color:#7c88e6;}
h1{font-size:18px;margin:0 0 12px;}
p{color:#8a8f98;line-height:1.6;font-size:13px;}
</style></head><body><div class="card">
<h1>Dashboard build missing</h1>
<p>The React dashboard hasn't been built yet. Run:</p>
<p><code>cd ~/.claude/jarvis/router/dashboard && npx vite build</code></p>
<p>Then refresh this page. The API at <code>/api/*</code> remains available.</p>
</div></body></html>`);
}

export function startDashboard(port: number): void {
  if (USE_REACT) log.info("Serving React dashboard from %s", DIST_DIR);
  else log.warn("React build not found at %s — dashboard UI unavailable (API still works)", DIST_DIR);

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];

    // API routes — pass full url so query params are preserved
    if (pathname.startsWith("/api/")) {
      handleApi(req, res, url);
      return;
    }

    // Notch orb bundle — served from the tray-app source so the HTTP dashboard
    // and the native WKWebView stay byte-identical. 404 on miss (do NOT fall
    // through to the React index, or the iframe would render the dashboard
    // inside itself).
    if (pathname.startsWith(NOTCH_ORB_PREFIX)) {
      const rel = pathname.slice(NOTCH_ORB_PREFIX.length).replace(/\/+$/, "");
      if (!rel || rel.includes("..")) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      const orbPath = join(NOTCH_ORB_DIR, rel);
      // `notch.html?embed=dashboard` — inject a dark background override for
      // the dashboard iframe. The WKWebView loads the same URL without the
      // query param, so the native notch stays transparent (over-window
      // compositing requires it); the browser iframe gets an opaque backdrop
      // and no longer flashes the default white canvas.
      if (rel === "notch.html" && /[?&]embed=dashboard\b/.test(url)) {
        if (serveEmbeddedNotch(res, orbPath)) return;
      }
      if (orbPath.startsWith(NOTCH_ORB_DIR) && serveStatic(res, orbPath)) return;
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("orb asset not found");
      return;
    }

    if (!USE_REACT) {
      serveBuildMissing(res);
      return;
    }

    const filePath = join(DIST_DIR, pathname);
    if (filePath.startsWith(DIST_DIR) && serveStatic(res, filePath)) return;
    serveReactIndex(res);
  };

  // Bind to 127.0.0.1 by default so the dashboard is not reachable from the LAN.
  // Set DASHBOARD_BIND=0.0.0.0 (or another interface) to expose it on your network.
  // There is no auth — only expose if you trust every device on the network.
  const bindHost = process.env.DASHBOARD_BIND || "127.0.0.1";

  const httpServer = createHttpServer(handler);
  attachWebSocket(httpServer);
  httpServer.listen(port, bindHost, () => {
    log.info("Dashboard HTTP on http://%s:%d", bindHost, port);
  });

  const certDir = join(HOME, ".claude/jarvis/router/certs");
  const keyPath = join(certDir, "key.pem");
  const certPath = join(certDir, "cert.pem");
  if (existsSync(keyPath) && existsSync(certPath)) {
    try {
      const httpsServer = createHttpsServer(
        { key: readFileSync(keyPath), cert: readFileSync(certPath) },
        handler,
      );
      attachWebSocket(httpsServer as unknown as import("http").Server);
      httpsServer.listen(port + 1, bindHost, () => {
        log.info("Dashboard HTTPS on https://%s:%d", bindHost, port + 1);
      });
    } catch (err: any) {
      log.warn({ err: err?.message }, "HTTPS server failed to start");
    }
  }
}
