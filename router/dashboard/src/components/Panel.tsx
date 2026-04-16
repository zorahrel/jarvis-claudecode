import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'

interface PanelProps {
  open: boolean
  title: string
  children: ReactNode
  onClose: () => void
  width?: number
}

export function Panel({ open, title, children, onClose, width = 480 }: PanelProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <aside
        className="panel-slide fixed top-0 right-0 h-full z-40 overflow-y-auto"
        style={{
          width,
          background: 'var(--bg-2)',
          borderLeft: '1px solid var(--border-strong)',
          boxShadow: '-16px 0 40px rgba(0,0,0,0.35)',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-2)',
            position: 'sticky',
            top: 0,
            zIndex: 1,
          }}
        >
          <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-1)', margin: 0, letterSpacing: -0.1 }}>
            {title}
          </h3>
          <button
            onClick={onClose}
            aria-label="Close panel"
            style={{
              background: 'transparent',
              border: '1px solid transparent',
              color: 'var(--text-4)',
              cursor: 'pointer',
              padding: 4,
              borderRadius: 'var(--radius-sm)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'color 0.15s, background 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--text-1)'
              e.currentTarget.style.background = 'var(--surface-hover)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--text-4)'
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <X size={16} />
          </button>
        </header>
        <div style={{ padding: 20 }}>{children}</div>
      </aside>
    </>
  )
}
