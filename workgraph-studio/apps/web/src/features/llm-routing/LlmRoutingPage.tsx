/**
 * LlmRoutingPage — drag-drop canvas to wire LLM connections to touch points.
 *
 * Left column = connections (the gateway catalog's model aliases). Right column =
 * touch points (Copilot SDLC, Workbench, Chat, Governed agents, Audit judge).
 * Drag from a connection's handle to a touch point to wire it (writes a routing
 * rule); delete the edge to unwire. A scope switcher routes per Default / User /
 * Capability — the edges you see + draw apply to the selected scope.
 *
 * Connections carry NO credentials — keys stay on the gateway. This canvas only
 * maps touch points → aliases. Surfaces call /api/llm-routing/resolve at runtime.
 */
import { useMemo, useState, useCallback } from 'react'
import ReactFlow, {
  Background, BackgroundVariant, Controls, Handle, Position,
  type Node, type Edge, type NodeProps, type Connection as RFConnection,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Cpu, Boxes, Sparkles } from 'lucide-react'
import { api } from '../../lib/api'

type Connection = { alias: string; label: string; provider: string; model: string; costTier?: string; default?: boolean }
type TouchPoint = { key: string; label: string; description: string }
type Rule = { id: string; touchPoint: string; scopeType: string; scopeId: string; modelAlias: string; enabled: boolean }
type Scope = 'DEFAULT' | 'USER' | 'CAPABILITY'

const PROVIDER_COLOR: Record<string, string> = {
  anthropic: '#d97757', openai: '#10a37f', copilot: '#6e40c9', openrouter: '#0ea5e9', mock: '#94a3b8',
}

function ConnectionNode({ data }: NodeProps<Connection>) {
  const color = PROVIDER_COLOR[data.provider] ?? '#475569'
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
    </div>
  )
}

function TouchPointNode({ data }: NodeProps<TouchPoint & { wired?: Connection; inherited?: boolean }>) {
  const wired = data.wired
  const color = wired ? (PROVIDER_COLOR[wired.provider] ?? '#0ea5e9') : '#94a3b8'
  return (
    <div style={{ width: 240, borderRadius: 12, background: wired ? '#fff' : '#f8fafc', border: `1.5px solid ${color}`, boxShadow: '0 1px 3px rgba(15,23,42,0.08)', overflow: 'hidden' }}>
      <Handle type="target" position={Position.Left} style={{ background: color, border: 'none', width: 9, height: 9 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px' }}>
        <span style={{ width: 24, height: 24, borderRadius: 7, background: 'rgba(14,165,233,0.10)', color: '#0ea5e9', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Boxes size={14} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0f172a' }}>{data.label}</div>
          <div style={{ fontSize: 9.5, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.description}</div>
        </div>
      </div>
      <div style={{ padding: '6px 11px 9px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: wired ? color : '#94a3b8', display: 'flex', alignItems: 'center', gap: 5 }}>
          <Sparkles size={11} /> {wired ? wired.label : 'Inherits default'}
        </div>
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

  // rules for the current scope only
  const scopeRules = useMemo(
    () => rules.filter(r => r.scopeType === scope && r.scopeId === effectiveScopeId),
    [rules, scope, effectiveScopeId])

  const nodes: Node[] = useMemo(() => {
    const conn = connections.map((c, i) => ({ id: `c:${c.alias}`, type: 'conn', position: { x: 0, y: i * 78 }, data: c }))
    const tps = touchPoints.map((t, i) => {
      const rule = scopeRules.find(r => r.touchPoint === t.key)
      const wired = rule ? connections.find(c => c.alias === rule.modelAlias) : undefined
      return { id: `t:${t.key}`, type: 'tp', position: { x: 420, y: i * 108 }, data: { ...t, wired } }
    })
    return [...conn, ...tps]
  }, [connections, touchPoints, scopeRules])

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
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: '#f8fafc', zIndex: 5 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 18px', background: '#fff', borderBottom: '1px solid #e2e8f0', flexShrink: 0 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a' }}>LLM Gateway Routing</div>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>Drag a connection's handle onto a touch point to wire it. Delete the edge to unwire.</div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#f1f5f9', borderRadius: 9, padding: 3 }}>
          {(['DEFAULT', 'CAPABILITY', 'USER'] as Scope[]).map(s => (
            <button key={s} onClick={() => setScope(s)} style={{
              padding: '6px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, textTransform: 'capitalize',
              background: scope === s ? '#fff' : 'transparent', color: scope === s ? '#0284c7' : '#64748b',
              boxShadow: scope === s ? '0 1px 2px rgba(15,23,42,0.10)' : 'none',
            }}>{s.toLowerCase()}</button>
          ))}
        </div>
        {scope !== 'DEFAULT' && (
          <input
            value={scopeId} onChange={e => setScopeId(e.target.value)}
            placeholder={scope === 'USER' ? 'User id…' : 'Capability id…'}
            style={{ width: 280, padding: '7px 11px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }}
          />
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
    </div>
  )
}
