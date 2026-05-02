import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { ContextSessionsResponse, CruftResponse } from '../api/client'

interface UseContextPollingResult {
  data: ContextSessionsResponse | null
  cruft: CruftResponse | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  /** Wall-clock ms of last successful fetch. */
  lastFetchedAt: number | null
}

/**
 * Polls /api/local-sessions + /api/sessions/cruft on the given interval.
 *
 * Memory-leak guards (CTX-13):
 *   - clearInterval on unmount
 *   - skip fetch when document.hidden (tab in background)
 *   - latestRequestId pattern: late responses from cancelled requests are discarded
 *   - last good data preserved when an individual fetch fails
 */
export function useContextPolling(intervalMs: number = 5000): UseContextPollingResult {
  const [data, setData] = useState<ContextSessionsResponse | null>(null)
  const [cruft, setCruft] = useState<CruftResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)

  const requestIdRef = useRef(0)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    const myId = ++requestIdRef.current
    try {
      const [sessionsResp, cruftResp] = await Promise.all([
        api.contextSessions(),
        api.sessionsCruft(),
      ])
      // Discard late responses from cancelled or superseded requests
      if (!mountedRef.current || myId !== requestIdRef.current) return
      setData(sessionsResp)
      setCruft(cruftResp)
      setError(null)
      setLastFetchedAt(Date.now())
    } catch (e) {
      if (!mountedRef.current || myId !== requestIdRef.current) return
      setError(e instanceof Error ? e.message : 'errore sconosciuto')
    } finally {
      if (mountedRef.current && myId === requestIdRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    refresh()
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      refresh()
    }
    const id = window.setInterval(tick, intervalMs)
    return () => {
      mountedRef.current = false
      window.clearInterval(id)
    }
  }, [intervalMs, refresh])

  return { data, cruft, loading, error, refresh, lastFetchedAt }
}
