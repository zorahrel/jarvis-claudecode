import { useEffect, useMemo, useState } from 'react'

type Frequency = 'daily' | 'weekdays' | 'interval' | 'monthly' | 'custom'

const DAYS: Array<{ v: number; label: string }> = [
  { v: 1, label: 'Lun' },
  { v: 2, label: 'Mar' },
  { v: 3, label: 'Mer' },
  { v: 4, label: 'Gio' },
  { v: 5, label: 'Ven' },
  { v: 6, label: 'Sab' },
  { v: 0, label: 'Dom' },
]

interface ParsedState {
  freq: Frequency
  hour: string
  minute: string
  weekdays: number[]
  intervalMin: string
  dayOfMonth: string
  raw: string
}

function parseCron(expr: string): ParsedState {
  const fallback: ParsedState = {
    freq: 'custom', hour: '8', minute: '0', weekdays: [], intervalMin: '30', dayOfMonth: '1', raw: expr || '',
  }
  if (!expr) return fallback
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return fallback
  const [m, h, dom, mon, dow] = parts
  const numeric = (x: string) => /^\d+$/.test(x)
  // "0 8 * * *" → daily at 8:00
  if (numeric(m) && numeric(h) && dom === '*' && mon === '*' && dow === '*') {
    return { ...fallback, freq: 'daily', minute: m, hour: h, raw: expr }
  }
  // "0 8 * * 1-5" or "0 8 * * 1,2,3" → weekdays at time
  if (numeric(m) && numeric(h) && dom === '*' && mon === '*' && dow !== '*') {
    const days: number[] = []
    for (const part of dow.split(',')) {
      if (part.includes('-')) {
        const [a, b] = part.split('-').map(Number)
        for (let i = a; i <= b; i++) days.push(i % 7)
      } else if (numeric(part)) {
        days.push(parseInt(part, 10) % 7)
      }
    }
    return { ...fallback, freq: 'weekdays', minute: m, hour: h, weekdays: days, raw: expr }
  }
  // "*/30 * * * *" → every N minutes
  if (m.startsWith('*/') && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { ...fallback, freq: 'interval', intervalMin: m.slice(2), raw: expr }
  }
  // "0 9 2 * *" → monthly on day X
  if (numeric(m) && numeric(h) && numeric(dom) && mon === '*' && dow === '*') {
    return { ...fallback, freq: 'monthly', minute: m, hour: h, dayOfMonth: dom, raw: expr }
  }
  return fallback
}

function buildCron(s: ParsedState): string {
  const mm = String(parseInt(s.minute || '0', 10))
  const hh = String(parseInt(s.hour || '0', 10))
  switch (s.freq) {
    case 'daily':
      return `${mm} ${hh} * * *`
    case 'weekdays': {
      const dow = s.weekdays.length > 0 ? [...new Set(s.weekdays)].sort().join(',') : '*'
      return `${mm} ${hh} * * ${dow}`
    }
    case 'interval': {
      const n = Math.max(1, Math.min(59, parseInt(s.intervalMin || '30', 10) || 30))
      return `*/${n} * * * *`
    }
    case 'monthly': {
      const d = Math.max(1, Math.min(28, parseInt(s.dayOfMonth || '1', 10) || 1))
      return `${mm} ${hh} ${d} * *`
    }
    default:
      return s.raw
  }
}

/** Public helper: translate a cron expression to a friendly Italian phrase. */
export function humanizeCron(expr: string): string {
  const parsed = parseCron(expr)
  return humanize(parsed)
}

function humanize(s: ParsedState): string {
  const pad = (x: string) => x.padStart(2, '0')
  const time = `${pad(s.hour)}:${pad(s.minute)}`
  switch (s.freq) {
    case 'daily':
      return `Ogni giorno alle ${time}`
    case 'weekdays': {
      if (s.weekdays.length === 0) return `Seleziona almeno un giorno`
      const labels = [...new Set(s.weekdays)].sort().map(d => DAYS.find(x => x.v === d)?.label).filter(Boolean)
      return `Ogni ${labels.join(', ')} alle ${time}`
    }
    case 'interval': {
      const n = parseInt(s.intervalMin || '30', 10) || 30
      return `Ogni ${n} ${n === 1 ? 'minuto' : 'minuti'}`
    }
    case 'monthly': {
      const d = parseInt(s.dayOfMonth || '1', 10) || 1
      return `Ogni mese il giorno ${d} alle ${time}`
    }
    default:
      return s.raw ? `Espressione: ${s.raw}` : ''
  }
}

export function CronBuilder({
  value,
  onChange,
}: {
  value: string
  onChange: (expr: string) => void
}) {
  const [state, setState] = useState<ParsedState>(() => parseCron(value))

  // Resync when the parent value changes externally (e.g., opening a different job).
  useEffect(() => {
    const parsed = parseCron(value)
    setState(prev => (prev.raw === value ? prev : parsed))
  }, [value])

  const cronExpr = useMemo(() => buildCron(state), [state])

  // Bubble up to the parent whenever our derived expr changes.
  useEffect(() => {
    if (cronExpr !== value) onChange(cronExpr)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cronExpr])

  const toggleDay = (v: number) => {
    setState(prev => ({
      ...prev,
      weekdays: prev.weekdays.includes(v)
        ? prev.weekdays.filter(x => x !== v)
        : [...prev.weekdays, v],
    }))
  }

  const radio = (f: Frequency, label: string) => (
    <button
      key={f}
      onClick={() => setState(prev => ({ ...prev, freq: f }))}
      style={{
        padding: '6px 10px',
        fontSize: 12,
        background: state.freq === f ? 'var(--accent)' : 'transparent',
        color: state.freq === f ? '#fff' : 'var(--text-2)',
        border: '1px solid ' + (state.freq === f ? 'var(--accent)' : 'var(--border)'),
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {radio('daily', 'Ogni giorno')}
        {radio('weekdays', 'Giorni specifici')}
        {radio('interval', 'Ogni N minuti')}
        {radio('monthly', 'Ogni mese')}
        {radio('custom', 'Custom')}
      </div>

      {state.freq === 'daily' && (
        <TimeRow hour={state.hour} minute={state.minute} onHour={h => setState(p => ({ ...p, hour: h }))} onMinute={m => setState(p => ({ ...p, minute: m }))} />
      )}

      {state.freq === 'weekdays' && (
        <>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {DAYS.map(d => {
              const on = state.weekdays.includes(d.v)
              return (
                <button
                  key={d.v}
                  onClick={() => toggleDay(d.v)}
                  style={{
                    padding: '4px 10px',
                    fontSize: 11,
                    background: on ? 'var(--accent)' : 'transparent',
                    color: on ? '#fff' : 'var(--text-2)',
                    border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border)'),
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                  }}
                >
                  {d.label}
                </button>
              )
            })}
          </div>
          <TimeRow hour={state.hour} minute={state.minute} onHour={h => setState(p => ({ ...p, hour: h }))} onMinute={m => setState(p => ({ ...p, minute: m }))} />
        </>
      )}

      {state.freq === 'interval' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <span style={{ color: 'var(--text-3)' }}>Ogni</span>
          <input
            type="number"
            min={1}
            max={59}
            value={state.intervalMin}
            onChange={e => setState(p => ({ ...p, intervalMin: e.target.value }))}
            style={numBox}
          />
          <span style={{ color: 'var(--text-3)' }}>minuti</span>
        </div>
      )}

      {state.freq === 'monthly' && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={{ color: 'var(--text-3)' }}>Giorno</span>
            <input
              type="number"
              min={1}
              max={28}
              value={state.dayOfMonth}
              onChange={e => setState(p => ({ ...p, dayOfMonth: e.target.value }))}
              style={numBox}
            />
          </div>
          <TimeRow hour={state.hour} minute={state.minute} onHour={h => setState(p => ({ ...p, hour: h }))} onMinute={m => setState(p => ({ ...p, minute: m }))} />
        </div>
      )}

      {state.freq === 'custom' && (
        <input
          type="text"
          value={state.raw}
          onChange={e => setState(p => ({ ...p, raw: e.target.value }))}
          placeholder="minute hour day month weekday"
          style={{
            padding: '6px 10px',
            fontSize: 12,
            fontFamily: 'var(--mono)',
            background: 'var(--bg-0)',
            color: 'var(--text-1)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
          }}
        />
      )}

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 10px',
        background: 'var(--bg-0)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 11,
        color: 'var(--text-3)',
      }}>
        <span>{humanize(state)}</span>
        <code style={{ marginLeft: 'auto', color: 'var(--text-4)', fontFamily: 'var(--mono)' }}>{cronExpr}</code>
      </div>
    </div>
  )
}

function TimeRow({
  hour, minute, onHour, onMinute,
}: {
  hour: string
  minute: string
  onHour: (h: string) => void
  onMinute: (m: string) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <span style={{ color: 'var(--text-3)' }}>alle</span>
      <input type="number" min={0} max={23} value={hour} onChange={e => onHour(e.target.value)} style={numBox} />
      <span style={{ color: 'var(--text-3)' }}>:</span>
      <input type="number" min={0} max={59} value={minute} onChange={e => onMinute(e.target.value)} style={numBox} />
    </div>
  )
}

const numBox: React.CSSProperties = {
  width: 56,
  padding: '4px 8px',
  fontSize: 12,
  background: 'var(--bg-0)',
  color: 'var(--text-1)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  textAlign: 'center',
}
