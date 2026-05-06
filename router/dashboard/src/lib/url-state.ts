/**
 * URL state helpers for clean (non-hash) routing.
 *
 * Uses the History API instead of `location.hash`. Indexable, deep-linkable,
 * and supports browser back/forward natively.
 *
 * Backward compat: existing `#/foo?bar` or `#foo` URLs (from old saved tabs)
 * are normalized to `/foo?bar` on load.
 */

const PAGES = new Set([
  "overview", "channels", "routes", "agents", "tools", "skills",
  "memory", "cron", "sessions", "logs", "analytics", "settings",
])

export function currentPage(): string {
  // First path segment; fall back to "overview" for "/" or unknown.
  const seg = window.location.pathname.replace(/^\/+/, "").split("/")[0] ?? ""
  if (PAGES.has(seg)) return seg
  return "overview"
}

export function currentSearch(): URLSearchParams {
  return new URLSearchParams(window.location.search)
}

export function navigate(target: string, opts: { replace?: boolean } = {}): void {
  // Accept any of:
  //   "tools"            → /tools
  //   "/tools"           → /tools
  //   "tools?filter=foo" → /tools?filter=foo
  //   "#/tools?filter=x" → /tools?filter=x   (legacy hash form, rewritten)
  //   "#tools"           → /tools           (legacy hash form, rewritten)
  let normalized = target
  if (normalized.startsWith("#")) normalized = normalized.replace(/^#\/?/, "")
  if (!normalized.startsWith("/")) normalized = "/" + normalized
  if (opts.replace) {
    window.history.replaceState({}, "", normalized)
  } else {
    window.history.pushState({}, "", normalized)
  }
  // Notify subscribers — pushState/replaceState don't fire popstate.
  window.dispatchEvent(new PopStateEvent("popstate"))
}

export function subscribe(callback: () => void): () => void {
  const handler = () => callback()
  window.addEventListener("popstate", handler)
  return () => window.removeEventListener("popstate", handler)
}

/**
 * One-shot migration: if the URL still uses `#/foo` style (a saved bookmark
 * from before this rewrite), rewrite it to `/foo` and replace state so back
 * doesn't loop.
 */
export function migrateLegacyHash(): void {
  const h = window.location.hash
  if (!h || h === "#") return
  const target = h.replace(/^#\/?/, "")
  navigate(target, { replace: true })
}
