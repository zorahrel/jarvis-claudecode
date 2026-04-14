import type { Toast as ToastType } from '../hooks/useToast'

interface ToastStackProps {
  toasts: ToastType[]
  onRemove: (id: number) => void
}

const colorMap = {
  success: 'var(--ok)',
  error: 'var(--err)',
  info: 'var(--accent)',
}

const bgMap = {
  success: 'rgba(39, 166, 68, 0.12)',
  error: 'rgba(229, 83, 75, 0.12)',
  info: 'rgba(94, 106, 210, 0.12)',
}

export function ToastStack({ toasts, onRemove }: ToastStackProps) {
  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="toast rounded-lg px-4 py-3 text-sm shadow-lg cursor-pointer min-w-[250px] max-w-[400px]"
          style={{
            background: `${bgMap[t.type]}`,
            border: `1px solid var(--border-strong)`,
            borderLeft: `3px solid ${colorMap[t.type]}`,
            color: 'var(--text-2)',
          }}
          onClick={() => onRemove(t.id)}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}
