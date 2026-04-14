import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost'
type Size = 'xs' | 'sm' | 'md'

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: Variant
  size?: Size
  leading?: ReactNode
  trailing?: ReactNode
  children: ReactNode
  loading?: boolean
}

const sizeStyle: Record<Size, CSSProperties> = {
  xs: { padding: '3px 8px', fontSize: 11, borderRadius: 'var(--radius-sm)', gap: 4 },
  sm: { padding: '5px 12px', fontSize: 12, borderRadius: 'var(--radius)', gap: 6 },
  md: { padding: '8px 16px', fontSize: 13, borderRadius: 'var(--radius)', gap: 6 },
}

const variantStyle: Record<Variant, CSSProperties> = {
  primary: {
    background: 'var(--accent)',
    color: '#fff',
    border: '1px solid var(--accent)',
    fontWeight: 500,
  },
  secondary: {
    background: 'var(--bg-3)',
    color: 'var(--text-2)',
    border: '1px solid var(--border-strong)',
    fontWeight: 500,
  },
  ghost: {
    background: 'transparent',
    color: 'var(--text-3)',
    border: '1px solid var(--border)',
    fontWeight: 500,
  },
  danger: {
    background: 'var(--err)',
    color: '#fff',
    border: '1px solid var(--err)',
    fontWeight: 500,
  },
  'danger-ghost': {
    background: 'var(--err-tint)',
    color: 'var(--err)',
    border: '1px solid var(--err-border)',
    fontWeight: 500,
  },
}

export function Button({
  variant = 'secondary',
  size = 'sm',
  leading,
  trailing,
  children,
  loading,
  disabled,
  style,
  ...rest
}: ButtonProps) {
  const combined: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    whiteSpace: 'nowrap',
    cursor: disabled || loading ? 'not-allowed' : 'pointer',
    opacity: disabled || loading ? 0.55 : 1,
    transition: 'background 0.15s, border-color 0.15s, opacity 0.15s',
    lineHeight: 1,
    ...sizeStyle[size],
    ...variantStyle[variant],
    ...style,
  }
  return (
    <button style={combined} disabled={disabled || loading} {...rest}>
      {leading && <span style={{ display: 'inline-flex' }}>{leading}</span>}
      <span>{loading ? 'Saving…' : children}</span>
      {trailing && <span style={{ display: 'inline-flex' }}>{trailing}</span>}
    </button>
  )
}
