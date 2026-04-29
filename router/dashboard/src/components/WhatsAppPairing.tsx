import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { SectionHeader } from './ui/PageHeader'
import { Button } from './ui/Button'
import { Input } from './ui/Field'
import { InfoBox } from './ui/InfoBox'

type WAStatus = 'idle' | 'connecting' | 'qr' | 'pairing-code' | 'connected' | 'logged-out' | 'error'

interface WASnapshot {
  status: WAStatus
  qr?: string
  pairingCode?: string
  pairingPhone?: string
  jid?: string
  error?: string
  updatedAt: number
}

const STATUS_LABEL: Record<WAStatus, string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  qr: 'Waiting for QR scan',
  'pairing-code': 'Waiting for pairing code entry',
  connected: 'Connected',
  'logged-out': 'Logged out — re-pair required',
  error: 'Error',
}

const STATUS_TONE: Record<WAStatus, string> = {
  idle: 'var(--text-4)',
  connecting: 'var(--accent-bright)',
  qr: 'var(--accent-bright)',
  'pairing-code': 'var(--accent-bright)',
  connected: 'var(--ok)',
  'logged-out': 'var(--err)',
  error: 'var(--err)',
}

export function WhatsAppPairing({ onToast }: { onToast?: (msg: string, type: 'success' | 'error' | 'info') => void }) {
  const [snap, setSnap] = useState<WASnapshot | null>(null)
  const [mode, setMode] = useState<'qr' | 'code'>('qr')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const evtRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const es = new EventSource('/api/whatsapp/events')
    evtRef.current = es
    es.onmessage = (e) => {
      try { setSnap(JSON.parse(e.data)) } catch {}
    }
    es.onerror = () => { /* EventSource auto-reconnects */ }
    return () => { es.close(); evtRef.current = null }
  }, [])

  // Re-render QR string into a PNG data URL whenever it changes.
  useEffect(() => {
    const qr = snap?.qr
    if (!qr) { setQrDataUrl(null); return }
    QRCode.toDataURL(qr, { errorCorrectionLevel: 'L', margin: 1, scale: 6 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null))
  }, [snap?.qr])

  const relink = async () => {
    setBusy(true)
    try {
      const body: { phoneNumber?: string } = {}
      if (mode === 'code') {
        const cleaned = phone.replace(/[^0-9+]/g, '')
        if (!/^\+?[0-9]{8,15}$/.test(cleaned)) {
          onToast?.('Insert a valid phone number with country code', 'error')
          setBusy(false)
          return
        }
        body.phoneNumber = cleaned
      }
      const r = await fetch('/api/whatsapp/relink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      onToast?.('Re-pairing started — follow on-screen instructions', 'info')
    } catch (e: unknown) {
      onToast?.(e instanceof Error ? e.message : String(e), 'error')
    }
    setBusy(false)
  }

  const status = snap?.status ?? 'idle'
  const isPairing = status === 'qr' || status === 'pairing-code'

  return (
    <div>
      <SectionHeader title="Pairing" />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          marginBottom: 10,
          color: 'var(--text-2)',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: STATUS_TONE[status],
            boxShadow: status === 'connected' ? '0 0 6px rgba(39,166,68,0.4)' : undefined,
          }}
        />
        <span>{STATUS_LABEL[status]}</span>
        {snap?.jid && (
          <span style={{ color: 'var(--text-4)', fontFamily: 'var(--mono)', fontSize: 11 }}>
            {snap.jid.split(':')[0].split('@')[0]}
          </span>
        )}
        {snap?.error && status !== 'connected' && (
          <span style={{ color: 'var(--err)', fontSize: 11 }}>· {snap.error}</span>
        )}
      </div>

      {/* Mode picker — only relevant before/while pairing */}
      {status !== 'connected' && (
        <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button
              size="xs"
              variant={mode === 'qr' ? 'primary' : 'ghost'}
              onClick={(e) => { e.stopPropagation(); setMode('qr') }}
            >
              QR code
            </Button>
            <Button
              size="xs"
              variant={mode === 'code' ? 'primary' : 'ghost'}
              onClick={(e) => { e.stopPropagation(); setMode('code') }}
            >
              Pairing code
            </Button>
          </div>
          {mode === 'code' && (
            <Input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+393331234567"
              style={{ padding: '5px 10px', fontSize: 11 }}
            />
          )}
          <Button
            size="xs"
            variant="primary"
            onClick={(e) => { e.stopPropagation(); relink() }}
            loading={busy}
          >
            {status === 'logged-out' || status === 'idle' || status === 'error'
              ? 'Re-link WhatsApp'
              : 'Restart pairing'}
          </Button>
        </div>
      )}

      {/* QR mode — show rendered QR */}
      {isPairing && mode === 'qr' && qrDataUrl && (
        <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 12, background: 'var(--surface-subtle)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
          <img src={qrDataUrl} alt="WhatsApp QR" style={{ width: 220, height: 220, imageRendering: 'pixelated' }} />
          <div style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'center', lineHeight: 1.5 }}>
            Open WhatsApp on your phone → <b>Settings</b> → <b>Linked Devices</b> → <b>Link a Device</b>, then scan.
          </div>
        </div>
      )}

      {/* Pairing-code mode */}
      {status === 'pairing-code' && snap?.pairingCode && (
        <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: 12, background: 'var(--surface-subtle)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 28, letterSpacing: 4, color: 'var(--text-1)' }}>
            {snap.pairingCode}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'center', lineHeight: 1.5 }}>
            On your phone: WhatsApp → <b>Settings</b> → <b>Linked Devices</b> → <b>Link a Device</b> → <b>Link with phone number</b>.
            Type this code.
          </div>
        </div>
      )}

      {status === 'connected' && (
        <InfoBox tone="ok" style={{ marginTop: 6, padding: '6px 10px', fontSize: 11 }}>
          WhatsApp linked. Re-link only if the session breaks (logged-out / Bad MAC).
        </InfoBox>
      )}
    </div>
  )
}
