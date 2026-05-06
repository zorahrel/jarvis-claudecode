import { useEffect } from 'react'
import { X } from 'lucide-react'
import { WhatsAppPairing } from './WhatsAppPairing'

interface Props {
  open: boolean
  onClose: () => void
  onToast?: (msg: string, type: 'success' | 'error' | 'info') => void
}

export function WhatsAppSettingsModal({ open, onClose, onToast }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="panel-overlay fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-2)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-lg)',
          width: '100%',
          maxWidth: 480,
          maxHeight: '85vh',
          overflow: 'auto',
          boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
            position: 'sticky',
            top: 0,
            background: 'var(--bg-2)',
            zIndex: 1,
          }}
        >
          <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-1)', margin: 0 }}>
            WhatsApp settings
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-3)',
              cursor: 'pointer',
              padding: 4,
              display: 'inline-flex',
            }}
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: 20 }}>
          <WhatsAppPairing onToast={onToast} />

          <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-4)', lineHeight: 1.6 }}>
            Looking for <a href="/routes" style={{ color: 'var(--accent-bright)' }}>always-reply groups</a>?
            They're routing rules — find them in <b>Routes</b>.{' '}
            <a href="/settings" style={{ color: 'var(--accent-bright)' }}>Allowed callers</a> are channel-agnostic and live in <b>Settings</b>.
          </div>
        </div>
      </div>
    </div>
  )
}
