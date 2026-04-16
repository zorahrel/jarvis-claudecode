import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'
import { Tooltip } from './Tooltip'

type Variant = 'ghost' | 'primary' | 'danger-ghost'
type Size = 'xs' | 'sm' | 'md'

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: ReactNode
  variant?: Variant
  size?: Size
  active?: boolean
  label: string
  /** Placement for the tooltip bubble. */
  tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right'
}

const box: Record<Size, CSSProperties> = {
  xs: { width: 22, height: 22, borderRadius: 'var(--radius-sm)' },
  sm: { width: 28, height: 28, borderRadius: 'var(--radius)' },
  md: { width: 32, height: 32, borderRadius: 'var(--radius)' },
}

const tone: Record<Variant, CSSProperties> = {
  ghost: {
    background: 'transparent',
    color: 'var(--text-3)',
    border: '1px solid var(--border)',
  },
  primary: {
    background: 'var(--accent-tint-strong)',
    color: 'var(--accent-bright)',
    border: '1px solid var(--accent-border)',
  },
  'danger-ghost': {
    background: 'var(--err-tint)',
    color: 'var(--err)',
    border: '1px solid var(--err-border)',
  },
}

export function IconButton({
  icon,
  variant = 'ghost',
  size = 'sm',
  active,
  label,
  disabled,
  style,
  tooltipPlacement = 'bottom',
  ...rest
}: IconButtonProps) {
  const combined: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    transition: 'background 0.15s, border-color 0.15s, color 0.15s',
    ...box[size],
    ...tone[active ? 'primary' : variant],
    ...style,
  }
  return (
    <Tooltip content={label} placement={tooltipPlacement}>
      <button
        type="button"
        aria-label={label}
        style={combined}
        disabled={disabled}
        {...rest}
      >
        {icon}
      </button>
    </Tooltip>
  )
}
