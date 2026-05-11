import { useEffect, useState, useCallback } from 'react'
import { Shield, ScrollText, Layers, RefreshCw } from 'lucide-react'
import { api } from '../api/client'
import type { PermissionMatrix, AuditEntry, Tier } from '../api/client'
import { PageHeader, SectionHeader } from '../components/ui/PageHeader'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { IconButton } from '../components/ui/IconButton'
import { EmptyState } from '../components/ui/EmptyState'

type Tab = 'matrix' | 'tiers' | 'audit'

const TIER_COLOR: Record<Tier, string> = {
  owner: '#a78bfa',
  team: '#60a5fa',
  family: '#34d399',
  personal: '#fbbf24',
  client: '#f87171',
}

function tierBadge(tier: Tier) {
  const color = TIER_COLOR[tier] ?? 'var(--text-2)'
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
        borderRadius: 999, background: `${color}22`, color, fontSize: 11, fontWeight: 600,
        border: `1px solid ${color}44`, textTransform: 'uppercase', letterSpacing: 0.4,
      }}
    >
      {tier}
    </span>
  )
}

function Section({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, marginBottom: 16, ...style }}>{children}</div>
}

export function Permissions({ onToast }: { onToast?: (msg: string, type: 'success' | 'error' | 'info') => void } = {}) {
  const [tab, setTab] = useState<Tab>('matrix')
  const [matrix, setMatrix] = useState<PermissionMatrix | null>(null)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [m, a] = await Promise.all([api.permissionMatrix(), api.audit({ limit: 200 })])
      setMatrix(m)
      setAudit(a.entries)
    } catch (e: any) {
      onToast?.(`refresh failed: ${e?.message ?? e}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [onToast])

  useEffect(() => { refresh() }, [refresh])

  return (
    <>
      <PageHeader
        title="Permissions"
        description="Per-agent tier, tools allowlist, channel scope, audit trail. The dashboard rejects tier violations server-side."
        actions={
          <IconButton icon={<RefreshCw size={16} className={loading ? 'spin' : ''} />} onClick={refresh} title="Refresh" label="Refresh" disabled={loading} />
        }
      />

      {/* Tab strip */}
      <div style={{ display: 'flex', gap: 4, padding: '0 0 16px', borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
        {[
          { id: 'matrix' as const, label: 'Matrix', icon: Layers },
          { id: 'tiers' as const, label: 'Tier rules', icon: Shield },
          { id: 'audit' as const, label: 'Audit log', icon: ScrollText },
        ].map(t => (
          <Button
            key={t.id}
            variant={tab === t.id ? 'primary' : 'ghost'}
            onClick={() => setTab(t.id)}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <t.icon size={14} /> {t.label}
          </Button>
        ))}
      </div>

      {tab === 'matrix' && matrix && (
        <Section>
          <SectionHeader title="Agents × Tools" />
          {matrix.agents.length === 0 ? (
            <EmptyState title="No agents configured." />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={{ position: 'sticky', left: 0, background: 'var(--bg-1)', padding: '8px 12px', textAlign: 'left', color: 'var(--text-2)' }}>Agent</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-2)' }}>Tier</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text-2)' }}>Model</th>
                    {matrix.allTools.map(t => (
                      <th key={t.id} style={{ padding: '8px 6px', textAlign: 'center', color: 'var(--text-2)', fontWeight: 500, whiteSpace: 'nowrap', maxWidth: 90 }}>
                        <div style={{ writingMode: 'vertical-rl' as any, transform: 'rotate(180deg)', minHeight: 80 }}>{t.label}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.agents.map(a => (
                    <tr key={a.name} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ position: 'sticky', left: 0, background: 'var(--bg-1)', padding: '8px 12px', fontWeight: 600 }}>
                        {a.name}
                        {a.fullAccess && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-2)' }}>(full)</span>}
                      </td>
                      <td style={{ padding: '8px 12px' }}>{tierBadge(a.tier)}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-2)' }}>{a.model ?? '—'}</td>
                      {matrix.allTools.map(t => {
                        const has = a.fullAccess || a.tools.includes(t.id)
                        const allowedByTier = a.fullAccess || t.allowedFor.includes(a.tier)
                        return (
                          <td key={t.id} style={{ padding: '6px', textAlign: 'center' }}>
                            <span
                              title={
                                has ? `${t.label} enabled` :
                                  allowedByTier ? `${t.label} permitted by tier but not assigned` :
                                    `${t.label} not allowed for tier "${a.tier}"`
                              }
                              style={{
                                display: 'inline-block', width: 14, height: 14, borderRadius: '50%',
                                background: has ? '#34d399' : 'transparent',
                                border: has ? '1px solid #34d399' : (allowedByTier ? '1px dashed var(--border)' : '1px solid #f8717133'),
                              }}
                            />
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-2)' }}>
            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: '#34d399', marginRight: 6 }} />enabled &nbsp;
            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'transparent', border: '1px dashed var(--border)', marginRight: 6 }} />allowed by tier (not assigned) &nbsp;
            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: 'transparent', border: '1px solid #f8717133', marginRight: 6 }} />blocked by tier
          </div>
        </Section>
      )}

      {tab === 'tiers' && matrix && (
        <Section>
          <SectionHeader title="Tier whitelist" />
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 12 }}>
            Each tier is restricted to a tool allowlist (regex). Agents inherit
            their tier from <code style={{ background: 'var(--bg-0)', padding: '1px 4px', borderRadius: 3 }}>agent.yaml</code>{' '}
            <code>tier:</code>. Default is <strong>personal</strong>. Setting{' '}
            <code>fullAccess: true</code> on an agent bypasses these checks
            (owner-equivalent).
          </div>
          <div style={{ display: 'grid', gap: 12 }}>
            {matrix.tiers.map(tier => (
              <div
                key={tier}
                style={{
                  padding: 12, border: '1px solid var(--border)', borderRadius: 8,
                  background: 'var(--bg-0)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  {tierBadge(tier)}
                  <span style={{ fontSize: 11, color: 'var(--text-2)' }}>
                    {matrix.agents.filter(a => a.tier === tier).length} agent(s)
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {matrix.tierWhitelist[tier]?.map((rx, i) => (
                    <code
                      key={i}
                      style={{
                        background: 'var(--bg-1)', padding: '2px 6px', borderRadius: 4,
                        fontSize: 11, color: 'var(--text-1)', border: '1px solid var(--border)',
                      }}
                    >
                      {rx}
                    </code>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {tab === 'audit' && (
        <Section>
          <SectionHeader title="Audit log (last 200)" />
          {audit.length === 0 ? (
            <EmptyState title="No audit entries yet." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {audit.map((e, i) => (
                <div
                  key={i}
                  style={{
                    padding: 10, border: '1px solid var(--border)', borderRadius: 6,
                    background: e.result === 'denied' ? '#f8717111' : 'var(--bg-0)',
                    borderLeft: e.result === 'denied' ? '3px solid #f87171' : (e.result === 'error' ? '3px solid #fbbf24' : '3px solid #34d399'),
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Badge>{e.event}</Badge>
                      {e.agent && <strong style={{ fontSize: 12 }}>{e.agent}</strong>}
                      {e.target && <span style={{ fontSize: 11, color: 'var(--text-2)' }}>→ {e.target}</span>}
                      {e.result === 'denied' && <Badge>denied</Badge>}
                    </div>
                    <span style={{ fontSize: 10, color: 'var(--text-2)' }}>{new Date(e.ts).toLocaleString()}</span>
                  </div>
                  {e.diff && (e.diff.added?.length || e.diff.removed?.length) && (
                    <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
                      {e.diff.added?.length ? <span style={{ color: '#34d399' }}>+{e.diff.added.join(', ')}</span> : null}
                      {e.diff.added?.length && e.diff.removed?.length ? ' · ' : ''}
                      {e.diff.removed?.length ? <span style={{ color: '#f87171' }}>−{e.diff.removed.join(', ')}</span> : null}
                    </div>
                  )}
                  {e.reason && (
                    <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>{e.reason}</div>
                  )}
                  {typeof e.killedSessions === 'number' && e.killedSessions > 0 && (
                    <div style={{ fontSize: 10, color: 'var(--text-2)', marginTop: 2 }}>{e.killedSessions} live session(s) killed</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      <style>{`.spin { animation: spin 1s linear infinite } @keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </>
  )
}
