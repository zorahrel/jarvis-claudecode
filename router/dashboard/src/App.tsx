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
import { Logs } from './pages/Logs'
import { Settings } from './pages/Settings'
import { Cron } from './pages/Cron'
import { Analytics } from './pages/Analytics'
import { currentPage, navigate as urlNavigate, subscribe, migrateLegacyHash } from './lib/url-state'

function App() {
  const [page, setPage] = useState(currentPage)
  const { toasts, addToast, removeToast } = useToast()

  // One-shot rewrite of legacy `#/foo` URLs into clean `/foo`.
  useEffect(() => { migrateLegacyHash() }, [])

  // popstate fires for back/forward AND for our own pushState dispatches.
  useEffect(() => subscribe(() => setPage(currentPage())), [])

  // Backward-compat: existing pages still use `window.location.hash = '#/foo'`
  // for programmatic navigation. Catch the hashchange, normalize to clean URL,
  // sync state. Eventually those callsites should switch to `navigate(...)`.
  useEffect(() => {
    const onHash = () => {
      if (window.location.hash) {
        migrateLegacyHash()
        setPage(currentPage())
      }
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Intercept clicks on `<a>` tags so internal navigation uses pushState
  // instead of full page reloads. We catch:
  //   <a href="/foo">         → SPA nav
  //   <a href="#foo">         → legacy hash, rewritten
  //   <a href="#/foo?bar">    → legacy hash with query, rewritten
  // and let through:
  //   external links, anchors with target=_blank, ctrl/cmd-click, etc.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented) return
      if (e.button !== 0) return // left-click only
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as HTMLElement)?.closest('a')
      if (!a) return
      if (a.target && a.target !== '' && a.target !== '_self') return
      const href = a.getAttribute('href')
      if (!href) return
      // External (http/https/mailto/etc) → let browser handle.
      if (/^[a-z]+:\/\//i.test(href) || href.startsWith('mailto:') || href.startsWith('tel:')) return
      // Anchor jumps within the same page (no path change) → let through.
      if (href.startsWith('#') && !href.startsWith('#/') && !href.match(/^#[a-z]/i)) return
      // Internal navigation: same-origin path or legacy hash.
      e.preventDefault()
      urlNavigate(href)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

  const navigate = useCallback((id: string) => {
    urlNavigate(id)
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
