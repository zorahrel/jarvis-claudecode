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

export function AlwaysReplyGroups({ onToast }: Props) {
  const [groups, setGroups] = useState<string[]>([])
  const [newGroup, setNewGroup] = useState('')
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    apiFetch<Record<string, unknown>>('/api/dashboard-state')
      .then((d) => setGroups((d.alwaysReplyGroups as string[]) || []))
      .catch(() => {})
  }, [])

  const add = async () => {
    const group = newGroup.trim()
    if (!group) return
    setAdding(true)
    try {
      const r = await apiFetch<{ groups: string[] }>('/api/config/always-reply', {
        method: 'POST',
        body: JSON.stringify({ group }),
      })
      setGroups(r.groups)
      setNewGroup('')
      onToast?.('Always-reply group added', 'success')
    } catch (e: unknown) {
      onToast?.(e instanceof Error ? e.message : String(e), 'error')
    }
    setAdding(false)
  }

  const remove = async (group: string) => {
    try {
      const r = await apiFetch<{ groups: string[] }>('/api/config/always-reply/' + encodeURIComponent(group), {
        method: 'DELETE',
      })
      setGroups(r.groups)
      onToast?.('Group removed', 'success')
    } catch (e: unknown) {
      onToast?.(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  return (
    <Card padding={16}>
      <SectionHeader title="Always-reply groups" count={groups.length} />
      <div style={{ fontSize: 11, color: 'var(--text-4)', marginBottom: 8, lineHeight: 1.5 }}>
        WhatsApp groups where Jarvis replies to every message (no <code style={{ fontFamily: 'var(--mono)' }}>@jarvis</code> mention required).
      </div>
      {groups.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
          {groups.map((g) => (
            <div
              key={g}
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
              <span
                style={{ fontFamily: 'var(--mono)', color: 'var(--text-2)', fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}
                title={g}
              >
                {g}
              </span>
              <Button size="xs" variant="danger-ghost" onClick={() => remove(g)}><X size={12} /></Button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <Input
          type="text"
          value={newGroup}
          onChange={(e) => setNewGroup(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="120363xxx@g.us"
          style={{ flex: 1, padding: '5px 10px', fontSize: 11 }}
        />
        <Button size="xs" variant="primary" onClick={add} loading={adding}>Add</Button>
      </div>
    </Card>
  )
}
