import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Pause, Play, Trash2, ArrowDown } from 'lucide-react'
import { Button } from './ui/Button'
import { Badge } from './ui/Badge'
import { EmptyState } from './ui/EmptyState'
import { ChannelIcon } from '../icons'
import {
  getRealtimeClient,
  useRealtimeStatus,
  type RouterEvent,
  type SessionEventData,
  type ExchangeEventData,
  type LogEventData,
  type ResponseTimingData,
  type NotifyOutboundData,
} from '../hooks/usePolling'

type VisibleType =
  | 'exchange.new'
  | 'session.created'
  | 'session.updated'
  | 'session.killed'
  | 'log'
  | 'response.timing'
  | 'notify.outbound'

interface FeedEntry {
  id: string
  ts: number
  event: RouterEvent
}

const MAX_BUFFER = 500

const ALL_TYPES: { id: VisibleType; label: string }[] = [
  { id: 'exchange.new', label: 'Exchanges' },
  { id: 'session.created', label: 'Session created' },
  { id: 'session.updated', label: 'Session updated' },
  { id: 'session.killed', label: 'Session killed' },
  { id: 'response.timing', label: 'Timings' },
  { id: 'log', label: 'Logs (warn+)' },
  { id: 'notify.outbound', label: 'Notify out' },
]

const DEFAULT_VISIBLE = new Set<VisibleType>([
  'exchange.new',
  'session.created',
  'session.updated',
  'session.killed',
  'log',
  'notify.outbound',
])

interface FeedFiltersProps {
  visible: Set<VisibleType>
  onToggle: (t: VisibleType) => void
  channels: string[]
  channel: string
  onChannelChange: (c: string) => void
  agents: string[]
  agent: string
  onAgentChange: (a: string) => void
}

function FeedFilters(props: FeedFiltersProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        padding: '10px 12px',
        borderRadius: 'var(--radius)',
        border: '1px solid var(--border)',
        background: 'var(--bg-0)',
        alignItems: 'center',
      }}
    >
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {ALL_TYPES.map((t) => {
          const on = props.visible.has(t.id)
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => props.onToggle(t.id)}
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                padding: '3px 8px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border)',
                background: on ? 'var(--accent-tint-strong)' : 'transparent',
                color: on ? 'var(--text-1)' : 'var(--text-4)',
                cursor: 'pointer',
              }}
            >
              {t.label}
            </button>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', alignItems: 'center' }}>
        <select
          value={props.channel}
          onChange={(e) => props.onChannelChange(e.target.value)}
          style={{
            fontSize: 11,
            padding: '4px 8px',
            background: 'var(--bg-1)',
            color: 'var(--text-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--mono)',
          }}
        >
          <option value="">all channels</option>
          {props.channels.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select
          value={props.agent}
          onChange={(e) => props.onAgentChange(e.target.value)}
          style={{
            fontSize: 11,
            padding: '4px 8px',
            background: 'var(--bg-1)',
            color: 'var(--text-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--mono)',
          }}
        >
          <option value="">all agents</option>
          {props.agents.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>
    </div>
  )
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

function truncate(s: string, max: number): string {
  if (!s) return ''
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

function fmtMs(ms?: number): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

const rowShell: CSSProperties = {
  display: 'flex',
  gap: 12,
  padding: '10px 12px',
  borderBottom: '1px solid var(--border)',
  alignItems: 'flex-start',
}

const tsStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  color: 'var(--text-4)',
  flexShrink: 0,
  minWidth: 82,
  paddingTop: 2,
}

function EventRow({ entry }: { entry: FeedEntry }) {
  const ev = entry.event
  switch (ev.type) {
    case 'exchange.new':
      return <ExchangeRow ts={entry.ts} data={ev.data} />
    case 'session.created':
    case 'session.updated':
    case 'session.killed':
      return <SessionRow ts={entry.ts} kind={ev.type} data={ev.data} />
    case 'log':
      return <LogRow ts={entry.ts} data={ev.data} />
    case 'response.timing':
      return <TimingRow ts={entry.ts} data={ev.data} />
    case 'notify.outbound':
      return <NotifyOutboundRow ts={entry.ts} data={ev.data} />
    default:
      return null
  }
}

function ExchangeRow({ ts, data }: { ts: number; data: ExchangeEventData }) {
  return (
    <div style={rowShell}>
      <span style={tsStyle}>{fmtTime(ts)}</span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {data.channel && <ChannelIcon channel={data.channel} size={12} />}
          <Badge tone="accent" size="xs">{data.agent ?? '(unrouted)'}</Badge>
          {data.model && <Badge tone="neutral" size="xs">{data.model}</Badge>}
          <span style={{ fontSize: 10, color: 'var(--text-4)', fontFamily: 'var(--mono)' }}>
            {fmtMs(data.wallMs)} wall · {fmtMs(data.apiMs)} api
            {data.inputTokens != null && ` · ${data.inputTokens}→${data.outputTokens ?? 0}tok`}
          </span>
        </div>
        <div
          style={{
            padding: '6px 10px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-0)',
            border: '1px solid var(--border)',
            color: 'var(--text-2)',
            fontSize: 12,
            lineHeight: 1.45,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          <span style={{ fontSize: 10, color: 'var(--text-4)', marginRight: 8, fontFamily: 'var(--mono)' }}>user</span>
          {truncate(data.user, 400)}
        </div>
        <div
          style={{
            padding: '6px 10px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--accent-tint-weak, rgba(113,112,255,0.08))',
            border: '1px solid var(--accent-border, rgba(113,112,255,0.25))',
            color: 'var(--text-1)',
            fontSize: 12,
            lineHeight: 1.45,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          <span style={{ fontSize: 10, color: 'var(--text-4)', marginRight: 8, fontFamily: 'var(--mono)' }}>assistant</span>
          {truncate(data.assistant, 600)}
        </div>
      </div>
    </div>
  )
}

function SessionRow({
  ts,
  kind,
  data,
}: {
  ts: number
  kind: 'session.created' | 'session.updated' | 'session.killed'
  data: SessionEventData
}) {
  const color =
    kind === 'session.killed' ? 'var(--err)'
    : kind === 'session.created' ? 'var(--ok)'
    : data.pending ? 'var(--warn, #e69e28)'
    : 'var(--text-3)'
  const verb =
    kind === 'session.created' ? 'created'
    : kind === 'session.killed' ? 'killed'
    : data.reason === 'message-start' ? 'thinking…'
    : data.reason === 'message-end' ? 'idle'
    : 'updated'
  return (
    <div style={rowShell}>
      <span style={tsStyle}>{fmtTime(ts)}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flex: 1 }}>
        {data.channel && <ChannelIcon channel={data.channel} size={12} />}
        <span style={{ color, fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600 }}>{verb}</span>
        <Badge tone="accent" size="xs">{data.agent ?? '(none)'}</Badge>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-4)' }}>{data.key}</span>
        {data.model && <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-4)' }}>{data.model}</span>}
      </div>
    </div>
  )
}

function LogRow({ ts, data }: { ts: number; data: LogEventData }) {
  const color = data.level === 'error' ? 'var(--err)' : data.level === 'warn' ? 'var(--warn, #e69e28)' : 'var(--text-3)'
  return (
    <div style={rowShell}>
      <span style={tsStyle}>{fmtTime(ts)}</span>
      <div style={{ display: 'flex', gap: 8, flex: 1, minWidth: 0, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color, width: 46, flexShrink: 0 }}>
          {data.level}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-4)' }}>{data.module}</span>
        <span style={{ fontSize: 12, color: 'var(--text-2)', wordBreak: 'break-word' }}>
          {truncate(data.msg, 400)}
        </span>
      </div>
    </div>
  )
}

function TimingRow({ ts, data }: { ts: number; data: ResponseTimingData }) {
  return (
    <div style={rowShell}>
      <span style={tsStyle}>{fmtTime(ts)}</span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge tone="neutral" size="xs">timing</Badge>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-4)' }}>{data.key}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-2)' }}>
          {fmtMs(data.wallMs)} wall · {fmtMs(data.apiMs)} api · {data.model}
        </span>
      </div>
    </div>
  )
}

function NotifyOutboundRow({ ts, data }: { ts: number; data: NotifyOutboundData }) {
  return (
    <div style={rowShell}>
      <span style={tsStyle}>{fmtTime(ts)}</span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
        <Badge tone="accent" size="xs">notify</Badge>
        {data.channel && <ChannelIcon channel={data.channel} size={12} />}
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-3)' }}>
          {`→ ${data.channel}:${data.target}`}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {truncate(data.preview, 120)}
        </span>
      </div>
    </div>
  )
}

function eventChannel(ev: RouterEvent): string | undefined {
  switch (ev.type) {
    case 'exchange.new':
    case 'session.created':
    case 'session.updated':
    case 'session.killed':
      return ev.data.channel
    case 'notify.outbound':
      return ev.data.channel
    default:
      return undefined
  }
}

function eventAgent(ev: RouterEvent): string | undefined {
  switch (ev.type) {
    case 'exchange.new':
    case 'session.created':
    case 'session.updated':
    case 'session.killed':
      return ev.data.agent ?? undefined
    default:
      return undefined
  }
}

export interface ActivityStreamProps {
  initialChannel?: string
  initialAgent?: string
}

export function ActivityStream({ initialChannel = '', initialAgent = '' }: ActivityStreamProps) {
  const { connected, lastEventAt } = useRealtimeStatus()

  const [entries, setEntries] = useState<FeedEntry[]>([])
  const pendingRef = useRef<FeedEntry[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  const [visible, setVisible] = useState<Set<VisibleType>>(new Set(DEFAULT_VISIBLE))
  const [channel, setChannel] = useState(initialChannel)
  const [agent, setAgent] = useState(initialAgent)

  useEffect(() => { setChannel(initialChannel) }, [initialChannel])
  useEffect(() => { setAgent(initialAgent) }, [initialAgent])

  const [autoScroll, setAutoScroll] = useState(true)
  const autoScrollRef = useRef(autoScroll)
  autoScrollRef.current = autoScroll
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const client = getRealtimeClient()
    const unsub = client.subscribe((event) => {
      if (event.type === 'hello' || event.type === 'ping' || event.type === 'stats') return
      const entry: FeedEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: Date.now(),
        event,
      }
      if (pausedRef.current) {
        const buf = pendingRef.current
        buf.push(entry)
        if (buf.length > MAX_BUFFER) buf.splice(0, buf.length - MAX_BUFFER)
        setPendingCount(buf.length)
        return
      }
      setEntries((prev) => {
        const next = prev.concat(entry)
        if (next.length > MAX_BUFFER) next.splice(0, next.length - MAX_BUFFER)
        return next
      })
    })
    return unsub
  }, [])

  useEffect(() => {
    if (!autoScrollRef.current) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [entries])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (atBottom !== autoScroll) setAutoScroll(atBottom)
  }

  function toggleType(t: VisibleType) {
    setVisible((prev) => {
      const next = new Set(prev)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      return next
    })
  }

  function flushPending() {
    const buf = pendingRef.current
    if (buf.length === 0) return
    setEntries((prev) => {
      const next = prev.concat(buf)
      if (next.length > MAX_BUFFER) next.splice(0, next.length - MAX_BUFFER)
      return next
    })
    pendingRef.current = []
    setPendingCount(0)
  }

  function togglePause() {
    setPaused((prev) => {
      const next = !prev
      if (!next) flushPending()
      return next
    })
  }

  function clearFeed() {
    setEntries([])
    pendingRef.current = []
    setPendingCount(0)
  }

  function jumpToBottom() {
    setAutoScroll(true)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  const { channels, agents } = useMemo(() => {
    const cs = new Set<string>()
    const as = new Set<string>()
    for (const e of entries) {
      const c = eventChannel(e.event)
      if (c) cs.add(c)
      const a = eventAgent(e.event)
      if (a) as.add(a)
    }
    if (channel) cs.add(channel)
    if (agent) as.add(agent)
    return { channels: [...cs].sort(), agents: [...as].sort() }
  }, [entries, channel, agent])

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      const t = e.event.type
      if (t === 'log') {
        if (!visible.has('log')) return false
        const lvl = e.event.data.level
        if (lvl !== 'warn' && lvl !== 'error' && lvl !== 'fatal') return false
      } else if (
        t === 'exchange.new' ||
        t === 'session.created' ||
        t === 'session.updated' ||
        t === 'session.killed' ||
        t === 'response.timing' ||
        t === 'notify.outbound'
      ) {
        if (!visible.has(t)) return false
      } else {
        return false
      }
      if (channel) {
        const c = eventChannel(e.event)
        if (c !== channel) return false
      }
      if (agent) {
        const a = eventAgent(e.event)
        if (a !== agent) return false
      }
      return true
    })
  }, [entries, visible, channel, agent])

  const status = connected
    ? lastEventAt
      ? `Streaming · last event ${Math.max(0, Math.floor((Date.now() - lastEventAt) / 1000))}s ago · ${filtered.length} / ${entries.length}`
      : `Connected · waiting for first event · ${filtered.length} / ${entries.length}`
    : 'Disconnected — the feed will populate when the WebSocket reconnects'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{status}</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="ghost" size="xs" onClick={togglePause}>
            {paused ? <Play size={12} /> : <Pause size={12} />}
            <span style={{ marginLeft: 4 }}>
              {paused ? `Resume${pendingCount > 0 ? ` (${pendingCount} new)` : ''}` : 'Pause'}
            </span>
          </Button>
          {!autoScroll && (
            <Button variant="secondary" size="xs" onClick={jumpToBottom}>
              <ArrowDown size={12} />
              <span style={{ marginLeft: 4 }}>Jump to latest</span>
            </Button>
          )}
          <Button variant="ghost" size="xs" onClick={clearFeed}>
            <Trash2 size={12} />
            <span style={{ marginLeft: 4 }}>Clear</span>
          </Button>
        </div>
      </div>

      <FeedFilters
        visible={visible}
        onToggle={toggleType}
        channels={channels}
        channel={channel}
        onChannelChange={setChannel}
        agents={agents}
        agent={agent}
        onAgentChange={setAgent}
      />

      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{
          flex: 1,
          minHeight: 280,
          maxHeight: 'calc(100vh - 280px)',
          overflow: 'auto',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--border)',
          background: 'var(--bg-1)',
        }}
      >
        {filtered.length === 0 ? (
          <div style={{ padding: 24 }}>
            <EmptyState
              title={connected ? 'No events yet' : 'Waiting for connection'}
              hint={
                connected
                  ? 'Send a message through any configured channel — the turn will stream in here.'
                  : 'The page falls back to polling-only UI until the WebSocket reconnects.'
              }
            />
          </div>
        ) : (
          filtered.map((e) => <EventRow key={e.id} entry={e} />)
        )}
      </div>
    </div>
  )
}
