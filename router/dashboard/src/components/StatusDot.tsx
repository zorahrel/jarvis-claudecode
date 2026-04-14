interface StatusDotProps {
  ok: boolean
  size?: number
}

export function StatusDot({ ok, size = 8 }: StatusDotProps) {
  return (
    <span
      className="inline-block rounded-full"
      style={{
        width: size,
        height: size,
        backgroundColor: ok ? 'var(--ok)' : 'var(--err)',
        boxShadow: ok ? '0 0 6px var(--ok)' : '0 0 6px var(--err)',
      }}
    />
  )
}
