import { useState, useEffect, useCallback } from 'react'
import { Layout } from './components/Layout'
import { ToastStack } from './components/Toast'
import { useToast } from './hooks/useToast'
import { Overview } from './pages/Overview'
import { Channels } from './pages/Channels'
import { Routes } from './pages/Routes'
import { Agents } from './pages/Agents'
import { Tools } from './pages/Tools'
import { Skills } from './pages/Skills'
import { Memory } from './pages/Memory'
import { Sessions } from './pages/Sessions'
import { Context } from './pages/Context'
import { Logs } from './pages/Logs'
import { Settings } from './pages/Settings'
import { Cron } from './pages/Cron'
import { Analytics } from './pages/Analytics'

function getHash() {
  // Strip leading `#`, optional `/`, and query string: `#/routes?filter=agent:foo` → `routes`.
  const raw = window.location.hash.replace(/^#\/?/, '')
  const qIdx = raw.indexOf('?')
  const page = (qIdx < 0 ? raw : raw.slice(0, qIdx)) || 'overview'
  return page
}

function App() {
  const [page, setPage] = useState(getHash)
  const { toasts, addToast, removeToast } = useToast()

  useEffect(() => {
    const onHash = () => setPage(getHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const navigate = useCallback((id: string) => {
    window.location.hash = id
  }, [])

  const renderPage = () => {
    switch (page) {
      case 'overview':
        return <Overview onToast={addToast} />
      case 'channels':
        return <Channels onToast={addToast} />
      case 'routes':
        return <Routes onToast={addToast} />
      case 'agents':
        return <Agents onToast={addToast} />
      case 'tools':
        return <Tools onToast={addToast} />
      case 'skills':
        return <Skills onToast={addToast} />
      case 'memory':
        return <Memory onToast={addToast} />
      case 'cron':
        return <Cron onToast={addToast} />
      case 'sessions':
        return <Sessions onToast={addToast} />
      case 'context':
        return <Context onToast={addToast} />
      case 'logs':
        return <Logs />
      case 'analytics':
        return <Analytics onToast={addToast} />
      case 'settings':
        return <Settings onToast={addToast} />
      default:
        return <Overview onToast={addToast} />
    }
  }

  return (
    <>
      <Layout activePage={page} onPageChange={navigate}>
        {renderPage()}
      </Layout>
      <ToastStack toasts={toasts} onRemove={removeToast} />
    </>
  )
}

export default App
