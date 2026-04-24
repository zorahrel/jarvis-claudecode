import { useState, useEffect, useCallback, useRef } from 'react'

export function usePolling<T>(
  fetchFn: () => Promise<T>,
  intervalMs = 5000,
): { data: T | null; error: string | null; refresh: () => void; loading: boolean; lastFetch: number } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastFetch, setLastFetch] = useState<number>(0)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const result = await fetchFn()
      if (mountedRef.current) {
        setData(result)
        setError(null)
        setLoading(false)
        setLastFetch(Date.now())
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      }
    }
  }, [fetchFn])

  useEffect(() => {
    mountedRef.current = true
    refresh()
    const id = setInterval(refresh, intervalMs)
    return () => {
      mountedRef.current = false
      clearInterval(id)
    }
  }, [refresh, intervalMs])

  return { data, error, refresh, loading, lastFetch }
}

// ─────────────────────────────────────────────────────────────
// Realtime WebSocket layer — mirror of router/src/dashboard/ws.ts
// One shared WebSocket per browser tab, subscribers pick events by type.
// Falls back to polling gracefully: when the socket is down, `connected`
// is false and subscribers simply never receive events (polling in other
// hooks keeps working).
// ─────────────────────────────────────────────────────────────

export interface SessionEventData {
  key: string
  channel?: string
  target?: string
  agent?: string | null
  model?: string | null
  alive?: boolean
  pending?: boolean
  messageCount?: number
  reason?: 'created' | 'message-start' | 'message-end' | 'killed' | 'timeout' | 'lifetime'
  ts: number
}

export interface ExchangeEventData {
  key: string
  user: string
  assistant: string
  timestamp: number
  agent?: string | null
  channel?: string
  model?: string | null
  wallMs?: number
  apiMs?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
}

export interface LogEventData {
  ts: number
  level: string
  module: string
  msg: string
  extra?: Record<string, unknown>
}

export interface ResponseTimingData {
  ts: number
  key: string
  wallMs: number
  apiMs: number
  model: string
}

export interface CompactionEventData {
  ts: number
  key: string
  tokensBefore: number
  threshold: number
  compactionCount: number
  summaryPreview?: string
  hardReset?: boolean
}

export type RouterEvent =
  | { type: 'hello'; data: { serverTime: number; protocolVersion: number } }
  | { type: 'ping'; data: { ts: number } }
  | { type: 'session.created'; data: SessionEventData }
  | { type: 'session.updated'; data: SessionEventData }
  | { type: 'session.killed'; data: SessionEventData }
  | { type: 'session.compacted'; data: CompactionEventData }
  | { type: 'log'; data: LogEventData }
  | { type: 'stats'; data: Record<string, unknown> }
  | { type: 'exchange.new'; data: ExchangeEventData }
  | { type: 'response.timing'; data: ResponseTimingData }

type Listener = (event: RouterEvent) => void

interface RealtimeClient {
  subscribe: (fn: Listener) => () => void
  connected: () => boolean
  lastEventAt: () => number
  onConnectionChange: (fn: () => void) => () => void
}

function createRealtimeClient(): RealtimeClient {
  const listeners = new Set<Listener>()
  const connListeners = new Set<() => void>()
  let ws: WebSocket | null = null
  let connectedFlag = false
  let lastEventTs = 0
  let attempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let pageVisible = typeof document === 'undefined' ? true : !document.hidden

  function fire(event: RouterEvent) {
    lastEventTs = Date.now()
    for (const fn of listeners) {
      try { fn(event) } catch { /* listener bug — ignore */ }
    }
  }

  function setConnected(v: boolean) {
    if (connectedFlag === v) return
    connectedFlag = v
    for (const fn of connListeners) {
      try { fn() } catch { /* ignore */ }
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    const delay = Math.min(30_000, 1000 * Math.pow(2, attempt))
    attempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (pageVisible) connect()
    }, delay)
  }

  function connect() {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = `${proto}//${window.location.host}/ws`
      ws = new WebSocket(url)
    } catch {
      scheduleReconnect()
      return
    }
    ws.onopen = () => {
      attempt = 0
      setConnected(true)
    }
    ws.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(String(ev.data)) as RouterEvent
        if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
          fire(parsed)
        }
      } catch {
        /* malformed frame — ignore */
      }
    }
    ws.onerror = () => {
      // onclose will fire next — handle there
    }
    ws.onclose = () => {
      setConnected(false)
      ws = null
      if (pageVisible) scheduleReconnect()
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      pageVisible = !document.hidden
      if (pageVisible) {
        attempt = 0
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
        connect()
      }
    })
  }

  // Kick off the first connect on the next tick so importers can attach first.
  if (typeof window !== 'undefined') {
    setTimeout(connect, 0)
  }

  return {
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    connected: () => connectedFlag,
    lastEventAt: () => lastEventTs,
    onConnectionChange(fn) {
      connListeners.add(fn)
      return () => { connListeners.delete(fn) }
    },
  }
}

// Singleton instance — shared across all pages/hooks.
let sharedClient: RealtimeClient | null = null
function getClient(): RealtimeClient {
  if (!sharedClient) sharedClient = createRealtimeClient()
  return sharedClient
}

export function getRealtimeClient(): RealtimeClient {
  return getClient()
}

export interface UseRealtimeResult<T> {
  connected: boolean
  lastEventAt: number
  data: T
}

/**
 * Subscribe to a subset of RouterEvent types and reduce them into a state value.
 * The hook does NOT manage its own socket — all subscribers share one singleton WS.
 */
export function useRealtime<T>(
  eventTypes: string[],
  initialValue: T,
  reducer: (prev: T, event: RouterEvent) => T,
): UseRealtimeResult<T> {
  const client = getClient()
  const [data, setData] = useState<T>(initialValue)
  const [connected, setConnectedState] = useState<boolean>(() => client.connected())
  const [lastEventAt, setLastEventAt] = useState<number>(() => client.lastEventAt())

  // Keep reducer + types in refs so the effect body doesn't resubscribe on every render.
  const reducerRef = useRef(reducer)
  reducerRef.current = reducer
  const typesKey = eventTypes.join('|')
  const typesRef = useRef<Set<string>>(new Set(eventTypes))
  useEffect(() => {
    typesRef.current = new Set(eventTypes)
  }, [typesKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const unsub = client.subscribe((event) => {
      if (!typesRef.current.has(event.type)) return
      setLastEventAt(Date.now())
      setData((prev) => reducerRef.current(prev, event))
    })
    const unsubConn = client.onConnectionChange(() => setConnectedState(client.connected()))
    return () => { unsub(); unsubConn() }
  }, [client])

  return { connected, lastEventAt, data }
}

/** Subscribe only to connection state (for global LIVE indicator). */
export function useRealtimeStatus(): { connected: boolean; lastEventAt: number } {
  const client = getClient()
  const [connected, setConnected] = useState<boolean>(() => client.connected())
  const [lastEventAt, setLastEventAt] = useState<number>(() => client.lastEventAt())

  useEffect(() => {
    const unsubConn = client.onConnectionChange(() => setConnected(client.connected()))
    // Tick lastEventAt forward whenever any event arrives
    const unsub = client.subscribe(() => setLastEventAt(Date.now()))
    return () => { unsub(); unsubConn() }
  }, [client])

  return { connected, lastEventAt }
}
