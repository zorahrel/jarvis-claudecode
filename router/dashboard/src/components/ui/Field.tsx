import type { CSSProperties, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ReactNode } from 'react'

interface FieldProps {
  label?: ReactNode
  error?: string
  hint?: ReactNode
  children: ReactNode
  style?: CSSProperties
}

export function Field({ label, error, hint, children, style }: FieldProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...style }}>
      {label && (
        <label
          style={{
            fontSize: 10,
            color: 'var(--text-4)',
            textTransform: 'uppercase',
            letterSpacing: 0.6,
            fontWeight: 500,
          }}
        >
          {label}
        </label>
      )}
      {children}
      {error && <div style={{ fontSize: 11, color: 'var(--err)' }}>{error}</div>}
      {!error && hint && <div style={{ fontSize: 11, color: 'var(--text-4)' }}>{hint}</div>}
    </div>
  )
}

const inputBase: CSSProperties = {
  width: '100%',
  background: 'var(--bg-3)',
  color: 'var(--text-1)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius)',
  padding: '8px 12px',
  fontSize: 13,
  fontFamily: 'var(--sans)',
  outline: 'none',
  transition: 'border-color 0.15s, box-shadow 0.15s',
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean
}

export function Input({ invalid, style, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      style={{
        ...inputBase,
        borderColor: invalid ? 'var(--err)' : 'var(--border-strong)',
        ...style,
      }}
      onFocus={(e) => {
        if (!invalid) e.currentTarget.style.borderColor = 'var(--border-focus)'
        rest.onFocus?.(e)
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = invalid ? 'var(--err)' : 'var(--border-strong)'
        rest.onBlur?.(e)
      }}
    />
  )
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean
}

export function Select({ invalid, style, children, ...rest }: SelectProps) {
  return (
    <select
      {...rest}
      style={{
        ...inputBase,
        cursor: 'pointer',
        borderColor: invalid ? 'var(--err)' : 'var(--border-strong)',
        ...style,
      }}
    >
      {children}
    </select>
  )
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

export function Textarea({ invalid, style, ...rest }: TextareaProps) {
  return (
    <textarea
      {...rest}
      style={{
        ...inputBase,
        resize: 'vertical',
        fontFamily: 'var(--mono)',
        fontSize: 12,
        lineHeight: 1.5,
        borderColor: invalid ? 'var(--err)' : 'var(--border-strong)',
        ...style,
      }}
    />
  )
}
