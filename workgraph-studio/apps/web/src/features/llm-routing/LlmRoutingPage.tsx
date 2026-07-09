/**
 * LlmRoutingPage — drag-drop canvas to wire WorkGraph LLM connections to touch points.
 *
 * Left column = connections (the gateway catalog's model aliases). Right column =
 * touch points (Copilot SDLC, Workbench, Chat, Governed agents, Audit judge).
 * Drag from a connection's handle to a touch point to wire it (writes a routing
 * rule); delete the edge to unwire. A scope switcher routes per Default / User /
 * Capability — the edges you see + draw apply to the selected scope.
 *
 * Connections carry NO credential values — only the server env var name. WorkGraph
 * resolves the alias at runtime and reads the key from its process environment.
 */
import { useMemo, useState, useCallback } from 'react'
import ReactFlow, {
  Background, BackgroundVariant, Controls, Handle, Position,
  type Node, type Edge, type NodeProps, type Connection as RFConnection,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cpu, Boxes, Sparkles, Plus, X } from 'lucide-react'
import { api } from '../../lib/api'
import { CapabilityPicker, UserPicker } from '../../components/lookup/EntityPickers'

type Connection = {
  alias: string
  label: string
  provider: string
  model: string
  baseUrl?: string | null
  credentialEnv?: string | null
  credentialPresent?: boolean
  credentialStatus?: 'not-required' | 'configured' | 'missing-env-name' | 'missing-env-value'
  costTier?: string
  default?: boolean
}
type TouchPoint = { key: string; label: string; description: string }
type Rule = { id: string; touchPoint: string; scopeType: string; scopeId: string; modelAlias: string; enabled: boolean }
type Scope = 'DEFAULT' | 'USER' | 'CAPABILITY'

const PROVIDER_COLOR: Record<string, string> = {
  anthropic: '#d97757', openai: '#10a37f', copilot: '#6e40c9', openrouter: '#0ea5e9', mock: '#94a3b8',
}

function ConnectionNode({ data }: NodeProps<Connection>) {
  const color = PROVIDER_COLOR[data.provider] ?? '#475569'
  const credentialOk = data.credentialStatus === 'configured' || data.credentialStatus === 'not-required'
  return (
    <div style={{ width: 210, borderRadius: 11, background: '#fff', border: `1.5px solid ${color}`, boxShadow: '0 1px 3px rgba(15,23,42,0.08)', padding: '9px 11px' }}>
      <Handle type="source" position={Position.Right} style={{ background: color, border: 'none', width: 9, height: 9 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ width: 22, height: 22, borderRadius: 6, background: `${color}1a`, color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Cpu size={13} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.label}</div>
          <div style={{ fontSize: 9.5, fontWeight: 600, color }}>{data.provider}{data.costTier ? ` · ${data.costTier}` : ''}</div>
        </div>
      </div>
      <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        <span style={{
          maxWidth: 126, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontSize: 9.5, fontWeight: 750, color: credentialOk ? '#047857' : '#b45309',
          background: credentialOk ? '#dcfce7' : '#fef3c7',
          border: `1px solid ${credentialOk ? '#86efac' : '#fde68a'}`,
          borderRadius: 999, padding: '2px 6px',
        }}>
          {data.credentialEnv || 'env var needed'}
        </span>
        <span style={{ fontSize: 9, color: credentialOk ? '#059669' : '#d97706', fontWeight: 800 }}>
          {credentialOk ? 'ready' : 'missing'}
        </span>
      </div>
    </div>
  )
}

type TouchPointData = TouchPoint & {
  connections: Connection[]
  currentAlias?: string
  onWire: (touchPoint: string, alias: string) => void
  onClear: (touchPoint: string) => void
}
function TouchPointNode({ data }: NodeProps<TouchPointData>) {
  const wired = data.connections.find(c => c.alias === data.currentAlias)
  const color = wired ? (PROVIDER_COLOR[wired.provider] ?? '#0ea5e9') : '#94a3b8'
  return (
    <div style={{ width: 260, borderRadius: 12, background: wired ? '#fff' : '#f8fafc', border: `1.5px solid ${color}`, boxShadow: '0 1px 3px rgba(15,23,42,0.08)', overflow: 'hidden' }}>
      <Handle type="target" position={Position.Left} style={{ background: color, border: 'none', width: 9, height: 9 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px' }}>
        <span style={{ width: 24, height: 24, borderRadius: 7, background: 'rgba(14,165,233,0.10)', color: '#0ea5e9', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Boxes size={14} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0f172a' }}>{data.label}</div>
          <div style={{ fontSize: 9.5, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.description}</div>
        </div>
      </div>
      <div style={{ padding: '4px 11px 11px' }}>
        <div style={{ fontSize: 8.5, fontWeight: 700, color: '#94a3b8', letterSpacing: 0.4, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}><Sparkles size={9} /> CONNECTION</div>
        <select
          className="nodrag"
          value={data.currentAlias ?? ''}
          onChange={e => e.target.value ? data.onWire(data.key, e.target.value) : data.onClear(data.key)}
          style={{ width: '100%', padding: '7px 8px', borderRadius: 8, border: `1.5px solid ${color}`, fontSize: 12, fontWeight: 700, color: wired ? color : '#64748b', background: '#fff', cursor: 'pointer' }}
        >
          <option value="">Inherits default</option>
          {data.connections.map(c => <option key={c.alias} value={c.alias}>{c.label} ({c.provider})</option>)}
        </select>
      </div>
    </div>
  )
}

export function LlmRoutingPage() {
  const qc = useQueryClient()
  const [scope, setScope] = useState<Scope>('DEFAULT')
  const [scopeId, setScopeId] = useState('')
  const effectiveScopeId = scope === 'DEFAULT' ? '' : scopeId.trim()

  const { data: connections = [] } = useQuery<Connection[]>({
    queryKey: ['llm-connections'], queryFn: () => api.get('/llm-routing/connections').then(r => r.data.items ?? []),
  })
  const { data: touchPoints = [] } = useQuery<TouchPoint[]>({
    queryKey: ['llm-touchpoints'], queryFn: () => api.get('/llm-routing/touch-points').then(r => r.data.items ?? []),
  })
  const { data: rules = [] } = useQuery<Rule[]>({
    queryKey: ['llm-rules'], queryFn: () => api.get('/llm-routing/rules').then(r => r.data.items ?? []),
  })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['llm-rules'] })

  const upsert = useMutation({
    mutationFn: (body: Partial<Rule>) => api.post('/llm-routing/rules', body).then(r => r.data),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/llm-routing/rules/${id}`).then(r => r.data),
    onSuccess: invalidate,
  })

  // Add a connection (gateway + model) — persisted in the llm_connection table.
  const blankForm = { name: '', provider: 'openai', model: '', alias: '', baseUrl: '', credentialEnv: '' }
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState(blankForm)
  const addConn = useMutation({
    mutationFn: (body: typeof form) => api.post('/llm-routing/connections', body).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['llm-connections'] }); setShowAdd(false); setForm(blankForm) },
  })

  // rules for the current scope only
  const scopeRules = useMemo(
    () => rules.filter(r => r.scopeType === scope && r.scopeId === effectiveScopeId),
    [rules, scope, effectiveScopeId])

  // Dropdown-driven wiring (the easy path; the drag-to-connect still works too).
  const onWire = useCallback((touchPoint: string, alias: string) => {
    if (scope !== 'DEFAULT' && !effectiveScopeId) { alert(`Enter a ${scope === 'USER' ? 'user' : 'capability'} id first.`); return }
    upsert.mutate({ touchPoint, scopeType: scope, scopeId: effectiveScopeId, modelAlias: alias, enabled: true })
  }, [scope, effectiveScopeId, upsert])
  const onClear = useCallback((touchPoint: string) => {
    const rule = scopeRules.find(r => r.touchPoint === touchPoint)
    if (rule) remove.mutate(rule.id)
  }, [scopeRules, remove])

  const nodes: Node[] = useMemo(() => {
    const conn = connections.map((c, i) => ({ id: `c:${c.alias}`, type: 'conn', position: { x: 0, y: i * 78 }, data: c }))
    const tps = touchPoints.map((t, i) => {
      const rule = scopeRules.find(r => r.touchPoint === t.key)
      return { id: `t:${t.key}`, type: 'tp', position: { x: 420, y: i * 124 }, data: { ...t, connections, currentAlias: rule?.modelAlias, onWire, onClear } }
    })
    return [...conn, ...tps]
  }, [connections, touchPoints, scopeRules, onWire, onClear])

  const edges: Edge[] = useMemo(() => scopeRules.map(r => ({
    id: r.id, source: `c:${r.modelAlias}`, target: `t:${r.touchPoint}`,
    animated: true, style: { stroke: '#0ea5e9', strokeWidth: 2 },
  })), [scopeRules])

  const nodeTypes = useMemo(() => ({ conn: ConnectionNode, tp: TouchPointNode }), [])

  const onConnect = useCallback((c: RFConnection) => {
    if (!c.source || !c.target) return
    if (scope !== 'DEFAULT' && !effectiveScopeId) { alert(`Enter a ${scope === 'USER' ? 'user' : 'capability'} id first.`); return }
    const modelAlias = c.source.replace(/^c:/, '')
    const touchPoint = c.target.replace(/^t:/, '')
    if (!c.source.startsWith('c:') || !c.target.startsWith('t:')) return // only connection→touchpoint
    upsert.mutate({ touchPoint, scopeType: scope, scopeId: effectiveScopeId, modelAlias, enabled: true })
  }, [scope, effectiveScopeId, upsert])

  const onEdgesDelete = useCallback((eds: Edge[]) => { eds.forEach(e => remove.mutate(e.id)) }, [remove])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#f8fafc' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 18px', background: '#fff', borderBottom: '1px solid #e2e8f0', flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a' }}>WorkGraph LLM Routing</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>Define multiple provider APIs once, store only env var names, then route touch points to aliases.</div>
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={() => setShowAdd(true)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '8px 13px', borderRadius: 8, border: '1px solid #0284c7', background: '#0ea5e9', color: '#fff', cursor: 'pointer', fontSize: 12.5, fontWeight: 700 }}>
          <Plus size={14} /> Add connection
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#f1f5f9', borderRadius: 9, padding: 3 }}>
          {(['DEFAULT', 'CAPABILITY', 'USER'] as Scope[]).map(s => (
            <button key={s} onClick={() => setScope(s)} style={{
              padding: '6px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, textTransform: 'capitalize',
              background: scope === s ? '#fff' : 'transparent', color: scope === s ? '#0284c7' : '#64748b',
              boxShadow: scope === s ? '0 1px 2px rgba(15,23,42,0.10)' : 'none',
            }}>{s.toLowerCase()}</button>
          ))}
        </div>
        {scope === 'USER' && (
          <div style={{ width: 280 }}>
            <UserPicker value={scopeId} onChange={(v) => setScopeId((v as string) ?? '')} placeholder="Pick a user…" />
          </div>
        )}
        {scope === 'CAPABILITY' && (
          <div style={{ width: 280 }}>
            <CapabilityPicker value={scopeId} onChange={(v) => setScopeId((v as string) ?? '')} placeholder="Pick a capability…" filterToMemberships={false} autoDefault={false} />
          </div>
        )}
      </div>
      {scope !== 'DEFAULT' && !effectiveScopeId && (
        <div style={{ padding: '8px 18px', background: '#fffbeb', borderBottom: '1px solid #fde68a', fontSize: 12, color: '#92400e' }}>
          Enter a {scope === 'USER' ? 'user' : 'capability'} id above to view + edit its routing. Unwired touch points inherit the Default routing.
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          onConnect={onConnect} onEdgesDelete={onEdgesDelete}
          fitView fitViewOptions={{ padding: 0.25 }}
          nodesDraggable={false} nodesConnectable elementsSelectable
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#e2e8f0" />
          <Controls showInteractive={false} />
          <div style={{ position: 'absolute', top: 10, left: 10, fontSize: 9.5, fontWeight: 800, color: '#94a3b8', letterSpacing: 0.5 }}>CONNECTIONS</div>
          <div style={{ position: 'absolute', top: 10, left: '50%', fontSize: 9.5, fontWeight: 800, color: '#94a3b8', letterSpacing: 0.5 }}>TOUCH POINTS</div>
        </ReactFlow>
      </div>
      {showAdd && (
        <div onClick={() => setShowAdd(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 430, maxHeight: '90vh', overflow: 'auto', background: '#fff', borderRadius: 14, padding: 20, boxShadow: '0 10px 40px rgba(0,0,0,0.25)' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
              <div style={{ flex: 1, fontSize: 15, fontWeight: 800, color: '#0f172a' }}>Add connection</div>
              <button onClick={() => setShowAdd(false)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#94a3b8' }}><X size={18} /></button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>Provider / gateway</span>
                <select value={form.provider} onChange={e => setForm(f => ({ ...f, provider: e.target.value }))} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12.5 }}>
                  {['openai', 'anthropic', 'copilot', 'openrouter', 'custom'].map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              {([
                ['name', 'Display name', 'e.g. GPT-4o (prod)'],
                ['model', 'Model id', 'e.g. gpt-4o'],
                ['alias', 'Alias (used at runtime + in routing)', 'e.g. gpt-4o-prod'],
                ['baseUrl', 'Base URL (optional — provider default if blank)', 'https://api.openai.com/v1'],
                ['credentialEnv', 'API key env var (on WorkGraph API server)', 'OPENAI_API_KEY'],
              ] as const).map(([key, label, ph]) => (
                <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>{label}</span>
                  <input value={(form as Record<string, string>)[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} placeholder={ph}
                    style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12.5 }} />
                </label>
              ))}
              <div style={{ fontSize: 10.5, color: '#94a3b8', lineHeight: 1.45 }}>
                Store only the env var name, for example <code>ANTHROPIC_API_KEY</code>. The actual key must exist in the WorkGraph API server environment and is never stored in the database or sent to the browser.
              </div>
              <button onClick={() => (form.name && form.model && form.alias) && addConn.mutate(form)} disabled={!form.name || !form.model || !form.alias || addConn.isPending}
                style={{ marginTop: 4, padding: '9px 12px', borderRadius: 8, border: 'none', background: '#0ea5e9', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', opacity: (!form.name || !form.model || !form.alias || addConn.isPending) ? 0.5 : 1 }}>
                {addConn.isPending ? 'Saving…' : 'Save connection'}
              </button>
              {addConn.isError && <div style={{ fontSize: 11, color: '#dc2626' }}>{(addConn.error as Error).message}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
