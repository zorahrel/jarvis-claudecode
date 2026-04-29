import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { SectionHeader } from './ui/PageHeader'
import { Button } from './ui/Button'
import { Input } from './ui/Field'
import { Card } from './ui/Card'

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

interface Props {
  onToast?: (msg: string, type: 'success' | 'error' | 'info') => void
}

export function AllowedCallers({ onToast }: Props) {
  const [callers, setCallers] = useState<string[]>([])
  const [newCaller, setNewCaller] = useState('')
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    apiFetch<Record<string, unknown>>('/api/dashboard-state')
      .then((d) => setCallers((d.callers as string[]) || []))
      .catch(() => {})
  }, [])

  const add = async () => {
    const phone = newCaller.trim()
    if (!phone) return
    setAdding(true)
    try {
      const r = await apiFetch<{ callers: string[] }>('/api/config/callers', {
        method: 'POST',
        body: JSON.stringify({ phone }),
      })
      setCallers(r.callers)
      setNewCaller('')
      onToast?.('Caller added: ' + phone, 'success')
    } catch (e: unknown) {
      onToast?.(e instanceof Error ? e.message : String(e), 'error')
    }
    setAdding(false)
  }

  const remove = async (phone: string) => {
    try {
      const r = await apiFetch<{ callers: string[] }>('/api/config/callers/' + encodeURIComponent(phone), {
        method: 'DELETE',
      })
      setCallers(r.callers)
      onToast?.('Caller removed', 'success')
    } catch (e: unknown) {
      onToast?.(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  return (
    <Card padding={16}>
      <SectionHeader title="Allowed callers" count={callers.length} />
      <div style={{ fontSize: 11, color: 'var(--text-4)', marginBottom: 8, lineHeight: 1.5 }}>
        Phone numbers authorized to invoke <code style={{ fontFamily: 'var(--mono)' }}>@jarvis</code> from any chat
        (and to receive voice calls). Channel-agnostic — applies to WhatsApp today, Telegram tomorrow.
      </div>
      {callers.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
          {callers.map((c) => (
            <div
              key={c}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 10px',
                fontSize: 12,
                background: 'var(--bg-0)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-2)', flex: 1 }}>{c}</span>
              <Button size="xs" variant="danger-ghost" onClick={() => remove(c)}><X size={12} /></Button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <Input
          type="text"
          value={newCaller}
          onChange={(e) => setNewCaller(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="+1234567890"
          style={{ flex: 1, padding: '5px 10px', fontSize: 11 }}
        />
        <Button size="xs" variant="primary" onClick={add} loading={adding}>Add</Button>
      </div>
    </Card>
  )
}
