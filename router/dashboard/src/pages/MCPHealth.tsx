import { useEffect, useState } from 'react'
import { api, type McpServerStatus } from '../api/client'

interface MCPHealthProps {
  onToast: (msg: string, kind?: 'success' | 'error' | 'info') => void
}

/**
 * MCP Health tab — live monitor of every MCP server registered in Claude
 * Code's user-scope config, with one-click re-authorization for OAuth servers
 * whose tokens have expired.
 *
 * Two flows:
 *   1. **Refresh** — POST /api/mcp/refresh forces the router to re-shell
 *      `claude mcp list` and update its cache. Returns the fresh list.
 *   2. **Authorize <name>** — POST /api/mcp/authenticate with the server name.
 *      The backend detects the transport (stdio + npx mcp-remote vs type:http)
 *      and spawns the right re-auth flow. Browser opens automatically.
 *
 * Polling cadence: 5s while the tab is mounted; pauses when hidden.
 */
export function MCPHealth({ onToast }: MCPHealthProps) {
  const [servers, setServers] = useState<McpServerStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [authing, setAuthing] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const list = await api.mcpStatus()
      setServers(list)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  async function handleAuth(name: string) {
    setAuthing((s) => new Set(s).add(name))
    onToast(`Opening auth flow for ${name}…`)
    try {
      const result = await api.mcpAuthenticate(name)
      if (result.ok) {
        onToast(`${name}: authorized ✓`, 'success')
        await load()
      } else {
        onToast(`${name}: ${result.reason ?? 'auth failed'}`, 'error')
      }
    } catch (err) {
      onToast(
        `${name}: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      setAuthing((s) => {
        const next = new Set(s)
        next.delete(name)
        return next
      })
    }
  }

  async function handleRefresh() {
    setLoading(true)
    onToast('Refreshing MCP server list…')
    try {
      await api.mcpRefresh()
      await load()
      onToast('MCP list refreshed', 'success')
    } catch (err) {
      onToast(
        `Refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    } finally {
      setLoading(false)
    }
  }

  const connected = servers.filter((s) => s.status === 'connected').length
  const needsAuth = servers.filter((s) => s.status === 'auth').length
  const failed = servers.filter((s) => s.status === 'failed').length

  return (
    <div style={{ padding: 16 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>MCP Health</h1>
        <span style={{ color: '#16a34a', fontSize: 12 }}>✓ {connected} connected</span>
        {needsAuth > 0 && (
          <span style={{ color: '#f59e0b', fontSize: 12 }}>! {needsAuth} need auth</span>
        )}
        {failed > 0 && (
          <span style={{ color: '#dc2626', fontSize: 12 }}>✗ {failed} failed</span>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={handleRefresh}
          disabled={loading}
          style={btnStyle(false)}
        >
          {loading ? 'Refreshing…' : 'Refresh now'}
        </button>
      </header>

      {error && (
        <div style={{ color: '#dc2626', marginBottom: 12 }}>
          Error: {error}
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>
            <th style={th}>Status</th>
            <th style={th}>Name</th>
            <th style={th}>Transport / Target</th>
            <th style={th}>Detail</th>
            <th style={th}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {servers.length === 0 && !loading && (
            <tr>
              <td colSpan={5} style={{ ...td, color: '#6b7280' }}>
                No MCP servers configured. Run{' '}
                <code>claude mcp add -s user &lt;name&gt; &lt;url&gt;</code> to add one.
              </td>
            </tr>
          )}
          {servers.map((s) => (
            <tr key={s.name} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={td}>{statusBadge(s.status)}</td>
              <td style={{ ...td, fontWeight: 600 }}>{s.name}</td>
              <td style={{ ...td, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: '#6b7280', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.target}
              </td>
              <td style={{ ...td, color: '#6b7280', fontSize: 12 }}>
                {s.statusText}
              </td>
              <td style={td}>
                {s.status === 'auth' && (
                  <button
                    onClick={() => handleAuth(s.name)}
                    disabled={authing.has(s.name)}
                    style={btnStyle(true)}
                  >
                    {authing.has(s.name) ? 'Authorizing…' : 'Authorize'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p style={{ marginTop: 24, fontSize: 12, color: '#6b7280', lineHeight: 1.6 }}>
        OAuth-based MCP servers (Gmail, Calendar, Drive, Vercel, Supabase, etc.) expire
        their tokens periodically. When you see <span style={{ color: '#f59e0b' }}>!
          needs auth</span>, click <em>Authorize</em> — the router spawns the right
        flow for the transport (stdio + npx mcp-remote, or type:http), your browser
        opens, you click <em>Allow</em>, and the green check returns within seconds.
      </p>
    </div>
  )
}

const th: React.CSSProperties = { padding: '8px 12px', fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }
const td: React.CSSProperties = { padding: '8px 12px', verticalAlign: 'middle' }

function statusBadge(status: McpServerStatus['status']) {
  const color =
    status === 'connected' ? '#16a34a'
    : status === 'auth'    ? '#f59e0b'
    : status === 'failed'  ? '#dc2626'
    :                        '#6b7280'
  const dot = (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        marginRight: 6,
      }}
    />
  )
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 11, color }}>
      {dot}
      {status}
    </span>
  )
}

function btnStyle(primary: boolean): React.CSSProperties {
  return {
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: 500,
    border: '1px solid ' + (primary ? '#6366f1' : '#d1d5db'),
    background: primary ? '#6366f1' : 'white',
    color: primary ? 'white' : '#111827',
    borderRadius: 6,
    cursor: 'pointer',
  }
}
