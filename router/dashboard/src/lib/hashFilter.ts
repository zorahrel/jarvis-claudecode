/**
 * Hash-filter utilities shared across dashboard pages.
 *
 * URL scheme:
 *   #/<page>?filter=<type>:<urlencoded-value>
 *   #/<page>?<key>=<value>&<key>=<value>
 *
 * Contract with Sessions.tsx: the same `?filter=<type>:<value>` grammar is
 * reused on every page that needs to cross-link entities (routes, agents,
 * channels, analytics). Every page gets the same parser via `parseHashFilter`
 * and builds links via `buildHashLink`.
 */

export interface HashFilter {
  type: string
  value: string
}

/** Split `#/foo?bar=baz` into `{ page, params }`. */
export function parseHashLocation(hash: string): { page: string; params: URLSearchParams } {
  const trimmed = (hash || '').replace(/^#/, '')
  const qIdx = trimmed.indexOf('?')
  const pageRaw = qIdx < 0 ? trimmed : trimmed.slice(0, qIdx)
  const qs = qIdx < 0 ? '' : trimmed.slice(qIdx + 1)
  const page = pageRaw.replace(/^\//, '') || 'overview'
  return { page, params: new URLSearchParams(qs) }
}

/**
 * Parse the `?filter=type:value` param out of a raw hash. Returns null when
 * the filter is missing or malformed.
 */
export function parseHashFilter(hash: string): HashFilter | null {
  const { params } = parseHashLocation(hash)
  const raw = params.get('filter')
  if (!raw) return null
  const sep = raw.indexOf(':')
  if (sep <= 0) return null
  const type = raw.slice(0, sep)
  const value = decodeURIComponent(raw.slice(sep + 1))
  if (!type || !value) return null
  return { type, value }
}

/** Build `#/<page>?filter=<type>:<value>` (encoded) or `#/<page>` when no filter. */
export function buildHashLink(page: string, filter?: HashFilter | null, extra?: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  if (filter) params.set('filter', `${filter.type}:${encodeURIComponent(filter.value)}`)
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === null || v === '') continue
      params.set(k, String(v))
    }
  }
  const qs = params.toString()
  // Filter value is already encoded, so decode once to keep the URL readable.
  const clean = qs.replace(/filter=([^&]+)/, (_, raw) => `filter=${decodeURIComponent(raw)}`)
  return qs ? `#/${page}?${clean}` : `#/${page}`
}

/** Shorthand for a link that only carries a `focus=<name>` param. */
export function buildFocusLink(page: string, name: string): string {
  return `#/${page}?focus=${encodeURIComponent(name)}`
}

/** Read `?focus=<name>` from a hash. Returns empty string when absent. */
export function parseHashFocus(hash: string): string {
  const { params } = parseHashLocation(hash)
  return params.get('focus') || ''
}

/** Read an arbitrary param from the hash (e.g. `agent`, `period`, `groupBy`). */
export function parseHashParam(hash: string, key: string): string {
  const { params } = parseHashLocation(hash)
  return params.get(key) || ''
}
