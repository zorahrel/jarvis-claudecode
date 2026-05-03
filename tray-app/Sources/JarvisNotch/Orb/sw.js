// Self-uninstalling service worker. The React notch refactor (2026-05-01)
// removed the SW-based shell caching that used to back this. Any client
// that still has the legacy SW cached will hit this shim, immediately
// unregister, and clear all caches. On the next page load there is no
// SW between browser and origin.
self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", async (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch {}
    try { await self.registration.unregister(); } catch {}
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const c of clients) { try { c.navigate(c.url); } catch {} }
  })());
});
