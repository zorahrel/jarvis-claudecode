import type { ContextDisk } from '../../api/client'

interface Props {
  disk: ContextDisk
}

export function DiskHygieneFooter({ disk }: Props) {
  const olderPct =
    disk.totalJsonl > 0 ? (disk.filesOlderThan30d / disk.totalJsonl) * 100 : 0
  return (
    <div
      style={{
        marginTop: 12,
        padding: '8px 12px',
        background: 'var(--bg-0)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: 'var(--text-3)',
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
      }}
    >
      <span>
        <strong>{disk.totalMb.toFixed(0)} MB</strong> totali
      </span>
      <span>
        <strong>{disk.totalJsonl}</strong> file JSONL
      </span>
      <span style={{ color: disk.filesOlderThan30d > 0 ? '#f97316' : 'var(--text-3)' }}>
        <strong>{disk.filesOlderThan30d}</strong> file &gt;30g ({olderPct.toFixed(0)}%)
      </span>
      <span style={{ color: 'var(--text-4)', marginLeft: 'auto' }}>
        Cleanup wizard: fase successiva (M6 deferred)
      </span>
    </div>
  )
}
