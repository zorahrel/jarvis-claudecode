import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// ── Legacy Service Worker cleanup ─────────────────────────────────────
// The pre-React notch bundle registered /sw.js which cached
// [/, /index.html] under the cache name 'jarvis-v3'. After the React
// refactor, /index.html no longer exists (renamed → /notch.html) and
// the SW shell stays out of date. On refresh, SW with its stale list
// would serve the wrong document and lose all formatting. Sweep it
// once on every load — idempotent.
async function unregisterLegacySW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) {
      try { await r.unregister(); } catch { /* ignore */ }
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      for (const k of keys) {
        try { await caches.delete(k); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    console.warn("[notch] SW cleanup failed", err);
  }
}
void unregisterLegacySW();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
