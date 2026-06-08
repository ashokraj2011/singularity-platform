// Connection Keys — GitHub-PAT-style device tokens for connecting a laptop
// mcp-server to context-fabric. Generate from your logged-in session, copy the
// key ONCE, paste it into the runner. List + revoke your keys.
//
// Backend (IAM, already exists): POST /auth/device-token (mint, returns the key
// once), GET /me/devices (list, metadata only), DELETE /devices/:id (revoke).
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Copy, Check, Trash2, Plus, AlertTriangle, Loader2 } from 'lucide-react'
import { iamApi } from '@/lib/api'

interface Device {
  id: string
  device_id: string
  device_name: string
  scopes: string[]
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
}
interface MintResponse {
  access_token: string
  device_id: string
  user_id: string
  email: string
  device_name: string
  scopes: string[]
  expires_in_days: number | null
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 18 }
const input: React.CSSProperties = { boxSizing: 'border-box', background: '#fff', border: '1px solid #dbe4ec', borderRadius: 8, padding: '8px 11px', fontSize: 13, color: '#0f172a', outline: 'none' }
const btn = (bg: string): React.CSSProperties => ({ background: bg, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 })
const mono: React.CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }

export function AccessKeysPanel() {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [ttl, setTtl] = useState(90)
  const [minted, setMinted] = useState<MintResponse | null>(null)
  const [copied, setCopied] = useState(false)

  const devices = useQuery<Device[]>({
    queryKey: ['my-devices'],
    queryFn: () => iamApi.get('/me/devices').then((r) => (r.data?.devices ?? r.data ?? []) as Device[]),
  })

  const mint = useMutation<MintResponse>({
    mutationFn: () =>
      iamApi.post('/auth/device-token', { device_name: name.trim() || 'laptop', ttl_days: ttl }).then((r) => r.data as MintResponse),
    onSuccess: (d) => {
      setMinted(d)
      setName('')
      setCopied(false)
      qc.invalidateQueries({ queryKey: ['my-devices'] })
    },
  })

  const revoke = useMutation({
    mutationFn: (id: string) => iamApi.delete(`/devices/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-devices'] }),
  })

  const copyKey = async () => {
    if (!minted) return
    try { await navigator.clipboard.writeText(minted.access_token); setCopied(true); setTimeout(() => setCopied(false), 1600) } catch { /* clipboard blocked */ }
  }

  const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : '—')
  const list = devices.data ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 880 }}>
      {/* Generate */}
      <div style={card}>
        <h3 style={{ margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8, fontSize: 16 }}>
          <KeyRound size={18} color="#7c3aed" /> Connection keys
        </h3>
        <p style={{ margin: '0 0 14px', fontSize: 12.5, color: '#64748b' }}>
          A connection key is a device token (like a GitHub PAT) that lets your laptop's <code>mcp-server</code> connect to
          Context Fabric as <strong>you</strong>. Generate one, copy it now (you won't see it again), and paste it into the runner.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ flex: '1 1 240px', fontSize: 12, color: '#42526a', fontWeight: 600 }}>
            Key name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. my-macbook" style={{ ...input, width: '100%', marginTop: 4 }} />
          </label>
          <label style={{ fontSize: 12, color: '#42526a', fontWeight: 600 }}>
            Expires (days)
            <input type="number" min={1} max={365} value={ttl} onChange={(e) => setTtl(Math.min(365, Math.max(1, Number(e.target.value) || 90)))} style={{ ...input, width: 90, marginTop: 4, display: 'block' }} />
          </label>
          <button style={{ ...btn('#7c3aed'), opacity: mint.isPending ? 0.6 : 1 }} disabled={mint.isPending} onClick={() => mint.mutate()}>
            {mint.isPending ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Generate key
          </button>
        </div>
        {mint.isError && <div style={{ marginTop: 10, color: '#b91c1c', fontSize: 13 }}>Failed to generate — are you logged in?</div>}

        {/* the key, shown once */}
        {minted && (
          <div style={{ marginTop: 14, border: '1px solid #fde68a', background: '#fffbeb', borderRadius: 10, padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#b45309', fontWeight: 700, fontSize: 12.5 }}>
              <AlertTriangle size={15} /> Copy this key now — it will not be shown again.
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <code style={{ ...mono, flex: 1, background: '#fff', border: '1px solid #e6ebf1', borderRadius: 8, padding: '8px 10px', overflowX: 'auto', whiteSpace: 'nowrap' }}>{minted.access_token}</code>
              <button style={btn(copied ? '#16a34a' : '#334155')} onClick={copyKey}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy'}</button>
            </div>
            <p style={{ margin: '10px 0 4px', fontSize: 12, color: '#475569' }}>Connect your laptop with it:</p>
            <code style={{ ...mono, display: 'block', background: '#0f172a', color: '#e2e8f0', borderRadius: 8, padding: '8px 10px', overflowX: 'auto' }}>
              singularity-mcp start --token {minted.access_token.slice(0, 14)}…
            </code>
            <p style={{ margin: '8px 0 0', fontSize: 11, color: '#94a3b8' }}>
              user_id {minted.user_id} · device {minted.device_name} · expires {minted.expires_in_days ?? 90}d
            </p>
          </div>
        )}
      </div>

      {/* List + revoke */}
      <div style={card}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Your keys ({list.length})</h3>
        {devices.isLoading ? (
          <div style={{ color: '#94a3b8', fontSize: 13 }}>Loading…</div>
        ) : list.length === 0 ? (
          <div style={{ color: '#94a3b8', fontSize: 13 }}>No connection keys yet — generate one above.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#64748b', borderBottom: '1px solid #eef2f6' }}>
                <th style={{ padding: '6px 8px' }}>Name</th>
                <th style={{ padding: '6px 8px' }}>Created</th>
                <th style={{ padding: '6px 8px' }}>Last seen</th>
                <th style={{ padding: '6px 8px' }}>Status</th>
                <th style={{ padding: '6px 8px' }}></th>
              </tr>
            </thead>
            <tbody>
              {list.map((d) => {
                const revoked = !!d.revoked_at
                return (
                  <tr key={d.id} style={{ borderBottom: '1px solid #f3f6f9', opacity: revoked ? 0.55 : 1 }}>
                    <td style={{ padding: '8px', fontWeight: 600, color: '#0f172a' }}>{d.device_name}</td>
                    <td style={{ padding: '8px', color: '#64748b' }}>{fmt(d.created_at)}</td>
                    <td style={{ padding: '8px', color: '#64748b' }}>{fmt(d.last_seen_at)}</td>
                    <td style={{ padding: '8px' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: revoked ? '#fef2f2' : '#ecfdf5', color: revoked ? '#b91c1c' : '#047857' }}>
                        {revoked ? 'Revoked' : 'Active'}
                      </span>
                    </td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>
                      {!revoked && (
                        <button title="Revoke" onClick={() => { if (confirm(`Revoke key "${d.device_name}"?`)) revoke.mutate(d.id) }}
                          style={{ background: 'none', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: 7, padding: '4px 9px', fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <Trash2 size={13} /> Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
