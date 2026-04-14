import type { CSSProperties, ReactNode } from 'react'

type Tone = 'neutral' | 'ok' | 'warn' | 'err' | 'accent'

interface InfoBoxProps {
  tone?: Tone
  icon?: ReactNode
  title?: ReactNode
  children: ReactNode
  style?: CSSProperties
}

const toneBg: Record<Tone, string> = {
  neutral: 'var(--bg-0)',
  ok: 'var(--ok-tint)',
  warn: 'var(--warn-tint)',
  err: 'var(--err-tint)',
  accent: 'var(--accent-tint)',
}

const toneBorder: Record<Tone, string> = {
  neutral: 'var(--border)',
  ok: 'var(--ok-border)',
  warn: 'var(--warn-border)',
  err: 'var(--err-border)',
  accent: 'var(--accent-border)',
}

const toneColor: Record<Tone, string> = {
  neutral: 'var(--text-3)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  err: 'var(--err)',
  accent: 'var(--accent-bright)',
}

export function InfoBox({ tone = 'neutral', icon, title, children, style }: InfoBoxProps) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '10px 14px',
        background: toneBg[tone],
        border: `1px solid ${toneBorder[tone]}`,
        borderRadius: 'var(--radius)',
        fontSize: 12,
        color: 'var(--text-3)',
        lineHeight: 1.55,
        ...style,
      }}
    >
      {icon && (
        <span
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            color: toneColor[tone],
            marginTop: 1,
          }}
        >
          {icon}
        </span>
      )}
      <div style={{ minWidth: 0 }}>
        {title && (
          <strong style={{ color: toneColor[tone], fontWeight: 600, marginRight: 6 }}>
            {title}
          </strong>
        )}
        {children}
      </div>
    </div>
  )
}
