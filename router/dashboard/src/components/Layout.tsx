import type { ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { NotchMirror } from './NotchMirror'

interface LayoutProps {
  activePage: string
  onPageChange: (id: string) => void
  children: ReactNode
}

export function Layout({ activePage, onPageChange, children }: LayoutProps) {
  const isMemory = activePage === 'memory'
  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar active={activePage} onChange={onPageChange} />
      <main
        style={{
          flex: 1,
          overflow: isMemory ? 'hidden' : 'auto',
          padding: isMemory ? 0 : '24px 32px',
          background: 'var(--bg-1)',
          display: 'flex',
          flexDirection: 'column' as const,
          position: 'relative' as const,
        }}
      >
        {children}
      </main>
      <NotchMirror />
    </div>
  )
}
