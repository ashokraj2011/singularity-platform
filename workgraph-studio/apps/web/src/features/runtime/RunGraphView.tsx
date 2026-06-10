/**
 * RunGraphView — designer-style graph view of a server-driven workflow run.
 *
 * Renders the run's nodes as a horizontal React Flow graph (like the workflow
 * designer) instead of the vertical timeline. Each node card shows its status +
 * a compact live-log line + actions (Restart / Artifacts / Chat, and
 * Approve / Reject on a stage that's awaiting review). Selecting a node opens a
 * right-side panel with Log / Artifacts / Chat tabs for that stage.
 *
 * Server-only — reuses the same endpoints RunViewerPage uses:
 *   GET  /workflow-instances/:id/nodes | /edges        (passed in as props)
 *   GET  /consumables?instanceId&nodeId                (per-node artifacts/log)
 *   POST /workflow-instances/:id/nodes/:nodeId/restart
 *   POST /workflow-instances/:id/nodes/:nodeId/force-complete   (approve/advance)
 */
import { useMemo, useState, useCallback, type CSSProperties } from 'react'
import ReactFlow, {
  Background, BackgroundVariant, Controls, Handle, Position,
  type Node, type Edge, type NodeProps,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, List, CheckCircle2, Circle, Clock, AlertCircle, Pause,
  RotateCw, FileText, MessageSquare, X, Check, Ban, Send, ExternalLink,
  ShieldCheck, CornerUpLeft, Library, Download,
} from 'lucide-react'
import { api } from '../../lib/api'

// Non-agentic node types that need their own real handler (form-fill, approval
// decision, workbench, etc.). The graph shows status/log/artifacts/restart for
// them like any node, but for the actual interaction it routes to the Timeline
// view, which already has the purpose-built panels.
const INTERACTIVE_TYPES = new Set([
  'HUMAN_TASK', 'APPROVAL', 'WORKBENCH_TASK', 'CONSUMABLE_CREATION', 'DECISION_GATE', 'WORK_ITEM',
])

export interface RunGraphNodeData {
  id: string
  nodeType: string
  label: string
  status: string
  config: Record<string, unknown>
  createdAt?: string
}
export interface RunGraphEdgeData {
  id: string
  sourceNodeId: string
  targetNodeId: string
  edgeType: string
}

const STATUS: Record<string, { ring: string; bg: string; color: string; Icon: typeof Circle; label: string }> = {
  PENDING:   { ring: '#cbd5e1', bg: '#f8fafc', color: '#64748b', Icon: Circle,       label: 'Pending' },
  ACTIVE:    { ring: '#0ea5e9', bg: '#f0f9ff', color: '#0284c7', Icon: Clock,        label: 'Active' },
  RUNNING:   { ring: '#0ea5e9', bg: '#f0f9ff', color: '#0284c7', Icon: Clock,        label: 'Running' },
  COMPLETED: { ring: '#22c55e', bg: '#f0fdf4', color: '#16a34a', Icon: CheckCircle2, label: 'Done' },
  FAILED:    { ring: '#ef4444', bg: '#fef2f2', color: '#dc2626', Icon: AlertCircle,  label: 'Failed' },
  BLOCKED:   { ring: '#f59e0b', bg: '#fffbeb', color: '#d97706', Icon: AlertCircle,  label: 'Blocked' },
  PAUSED:    { ring: '#f59e0b', bg: '#fffbeb', color: '#d97706', Icon: Pause,        label: 'Paused' },
  SKIPPED:   { ring: '#94a3b8', bg: '#f8fafc', color: '#94a3b8', Icon: Circle,       label: 'Skipped' },
}
const st = (s: string) => STATUS[(s ?? '').toUpperCase()] ?? STATUS.PENDING

// ─── Layout: layered columns by topological depth (horizontal flow) ──────────
function layout(nodes: RunGraphNodeData[], edges: RunGraphEdgeData[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>()
  const haveSaved = nodes.length > 0 && nodes.every(n => typeof n.config?.positionX === 'number' && typeof n.config?.positionY === 'number')
  if (haveSaved) {
    for (const n of nodes) pos.set(n.id, { x: n.config.positionX as number, y: n.config.positionY as number })
    return pos
  }
  const incoming = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const n of nodes) { incoming.set(n.id, 0); adj.set(n.id, []) }
  for (const e of edges) {
    if (!adj.has(e.sourceNodeId) || !incoming.has(e.targetNodeId)) continue
    adj.get(e.sourceNodeId)!.push(e.targetNodeId)
    incoming.set(e.targetNodeId, (incoming.get(e.targetNodeId) ?? 0) + 1)
  }
  const depth = new Map<string, number>()
  const q = nodes.filter(n => (incoming.get(n.id) ?? 0) === 0).map(n => n.id)
  q.forEach(idn => depth.set(idn, 0))
  const indeg = new Map(incoming)
  while (q.length) {
    const cur = q.shift()!
    const d = depth.get(cur) ?? 0
    for (const nxt of adj.get(cur) ?? []) {
      depth.set(nxt, Math.max(depth.get(nxt) ?? 0, d + 1))
      indeg.set(nxt, (indeg.get(nxt) ?? 1) - 1)
      if ((indeg.get(nxt) ?? 0) === 0) q.push(nxt)
    }
  }
  const COL_W = 300, ROW_H = 168
  const perCol = new Map<number, number>()
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0
    const row = perCol.get(d) ?? 0
    perCol.set(d, row + 1)
    pos.set(n.id, { x: d * COL_W, y: row * ROW_H })
  }
  return pos
}

// ─── Custom node card ────────────────────────────────────────────────────────
type CardData = RunGraphNodeData & {
  selected: boolean
  onSelect: (id: string, tab?: PanelTab) => void
  onRestart: (id: string) => void
  onApprove: (id: string) => void
  busy: boolean
}
function RunGraphNode({ data }: NodeProps<CardData>) {
  const s = st(data.status)
  const active = ['ACTIVE', 'RUNNING'].includes((data.status ?? '').toUpperCase())
  const isAgent = data.nodeType === 'AGENT_TASK'
  const isInteractive = INTERACTIVE_TYPES.has(data.nodeType)
  const btn = (label: string, Icon: typeof RotateCw, onClick: () => void, tone?: 'approve' | 'reject') => (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      disabled={data.busy}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        width: '100%', padding: '6px 8px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer',
        border: '1px solid', borderColor: tone === 'approve' ? '#16a34a' : tone === 'reject' ? '#dc2626' : '#e2e8f0',
        background: tone === 'approve' ? '#22c55e' : tone === 'reject' ? '#ef4444' : '#fff',
        color: tone ? '#fff' : '#334155', opacity: data.busy ? 0.6 : 1,
      }}
    >
      <Icon size={12} /> {label}
    </button>
  )
  return (
    <div
      onClick={() => data.onSelect(data.id)}
      style={{
        width: 248, borderRadius: 12, background: s.bg, cursor: 'pointer',
        border: `1.5px solid ${data.selected ? '#0ea5e9' : s.ring}`,
        boxShadow: data.selected ? '0 0 0 3px rgba(14,165,233,0.18)' : '0 1px 3px rgba(15,23,42,0.08)',
        overflow: 'hidden',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: s.ring, border: 'none', width: 7, height: 7 }} />
      <Handle type="source" position={Position.Right} style={{ background: s.ring, border: 'none', width: 7, height: 7 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px' }}>
        <span style={{ color: s.color, display: 'flex' }}><s.Icon size={16} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.label}</div>
          <div style={{ fontSize: 9.5, fontWeight: 600, color: s.color, letterSpacing: 0.3 }}>{data.nodeType} · {s.label}</div>
        </div>
      </div>
      <div style={{ margin: '0 11px 9px', padding: '6px 8px', borderRadius: 7, background: 'rgba(15,23,42,0.04)', minHeight: 30 }}>
        <div style={{ fontSize: 8.5, fontWeight: 700, color: '#94a3b8', letterSpacing: 0.4, marginBottom: 2 }}>LIVE LOG</div>
        <LiveLogPeek instanceId={data.config._instanceId as string} nodeId={data.id} active={active} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '0 11px 11px' }}>
        {isAgent && active && (
          <>
            {btn('Approve', Check, () => data.onApprove(data.id), 'approve')}
            {btn('Reject', Ban, () => data.onSelect(data.id, 'chat'), 'reject')}
          </>
        )}
        {isInteractive && active && btn('Open', ExternalLink, () => data.onSelect(data.id))}
        {btn(active ? 'Restart' : 'Restart stage', RotateCw, () => data.onRestart(data.id))}
        <div style={{ display: 'flex', gap: 5 }}>
          {/* Chat = copilot refine — agent stages only. */}
          {isAgent && <span style={{ flex: 1 }}>{btn('Chat', MessageSquare, () => data.onSelect(data.id, 'chat'))}</span>}
          <span style={{ flex: 1 }}>{btn('Artifacts', FileText, () => data.onSelect(data.id, 'artifacts'))}</span>
        </div>
      </div>
    </div>
  )
}

function LiveLogPeek({ instanceId, nodeId, active }: { instanceId: string; nodeId: string; active: boolean }) {
  const { data } = useConsumables(instanceId, nodeId, active)
  const latest = data?.[data.length - 1]
  const text = (latest?.formData?.content ?? '').toString().replace(/\s+/g, ' ').trim()
  if (!text) return <div style={{ fontSize: 10.5, color: '#94a3b8' }}>{active ? 'Working…' : '—'}</div>
  return <div style={{ fontSize: 10.5, color: '#475569', lineHeight: 1.35, maxHeight: 42, overflow: 'hidden' }}>{text.slice(0, 140)}{text.length > 140 ? '…' : ''}</div>
}

type Consumable = { id: string; name?: string; status?: string; nodeId?: string; formData?: { content?: string } }
const unwrapList = (d: unknown): Consumable[] => Array.isArray(d) ? d as Consumable[] : ((d as { items?: Consumable[] })?.items ?? [])
function useConsumables(instanceId: string, nodeId: string, live: boolean) {
  return useQuery<Consumable[]>({
    queryKey: ['run-graph-consumables', instanceId, nodeId],
    // /consumables may return a bare array OR a paginated { items: [...] } — handle both.
    queryFn: () => api.get('/consumables', { params: { instanceId, nodeId } }).then(r => unwrapList(r.data)),
    enabled: !!instanceId && !!nodeId,
    refetchInterval: live ? 5_000 : false,
    staleTime: 4_500,
  })
}
// All artifacts across the run — for the phase-by-phase catalog.
function useAllConsumables(instanceId: string, live: boolean) {
  return useQuery<Consumable[]>({
    queryKey: ['run-graph-all-consumables', instanceId],
    queryFn: () => api.get('/consumables', { params: { instanceId } }).then(r => unwrapList(r.data)),
    enabled: !!instanceId,
    refetchInterval: live ? 6_000 : false,
    staleTime: 5_000,
  })
}

type PanelTab = 'log' | 'artifacts' | 'chat'

export function RunGraphView({ instanceId, instanceStatus, runName, nodes, edges, onTimeline, onBack }: {
  instanceId: string
  instanceStatus: string
  runName: string
  nodes: RunGraphNodeData[]
  edges: RunGraphEdgeData[]
  onTimeline: () => void
  onBack: () => void
}) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<PanelTab>('log')
  const [showCatalog, setShowCatalog] = useState(false)
  const live = !['COMPLETED', 'CANCELLED', 'FAILED'].includes((instanceStatus ?? '').toUpperCase())

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['run-instance', instanceId] })
  }, [qc, instanceId])

  const restartMut = useMutation({
    mutationFn: (nodeId: string) => api.post(`/workflow-instances/${instanceId}/nodes/${nodeId}/restart`).then(r => r.data),
    onSuccess: invalidate,
  })
  const approveMut = useMutation({
    mutationFn: (nodeId: string) =>
      api.post(`/workflow-instances/${instanceId}/nodes/${nodeId}/force-complete`, { comment: 'Approved from run graph' }).then(r => r.data),
    onSuccess: invalidate,
  })

  // Export the run as a portable Copilot SDLC YAML (run it on the Copilot client).
  const downloadYaml = useCallback(async () => {
    const res = await api.get(`/workflow-instances/${instanceId}/export/copilot-yaml`, { responseType: 'blob' })
    const url = URL.createObjectURL(res.data as Blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `copilot-sdlc-${instanceId.slice(0, 8)}.yaml`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }, [instanceId])

  const onSelect = useCallback((id: string, t?: PanelTab) => { setShowCatalog(false); setSelected(id); if (t) setTab(t) }, [])

  const positions = useMemo(() => layout(nodes, edges), [nodes, edges])
  // phases in left→right (execution) order, for the catalog + send-back list
  const orderedPhases = useMemo(() => nodes.slice().sort((a, b) => {
    const pa = positions.get(a.id) ?? { x: 0, y: 0 }, pb = positions.get(b.id) ?? { x: 0, y: 0 }
    return pa.x - pb.x || pa.y - pb.y
  }).map(n => ({ id: n.id, label: n.label })), [nodes, positions])
  const completedNodes = useMemo(
    () => orderedPhases.filter(p => (nodes.find(x => x.id === p.id)?.status ?? '').toUpperCase() === 'COMPLETED'),
    [orderedPhases, nodes])
  const busyId = restartMut.isPending ? restartMut.variables : approveMut.isPending ? approveMut.variables : null

  const rfNodes: Node<CardData>[] = useMemo(() => nodes.map(n => ({
    id: n.id,
    type: 'runCard',
    position: positions.get(n.id) ?? { x: 0, y: 0 },
    data: {
      ...n,
      config: { ...n.config, _instanceId: instanceId },
      selected: selected === n.id,
      onSelect, onRestart: restartMut.mutate, onApprove: approveMut.mutate,
      busy: busyId === n.id,
    },
  })), [nodes, positions, selected, instanceId, onSelect, restartMut.mutate, approveMut.mutate, busyId])

  const rfEdges: Edge[] = useMemo(() => edges.map(e => ({
    id: e.id,
    source: e.sourceNodeId,
    target: e.targetNodeId,
    animated: live,
    style: { stroke: '#94a3b8', strokeWidth: 1.5 },
  })), [edges, live])

  const nodeTypes = useMemo(() => ({ runCard: RunGraphNode }), [])
  const selectedNode = nodes.find(n => n.id === selected) ?? null

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: '#f8fafc', zIndex: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', background: '#fff', borderBottom: '1px solid #e2e8f0', flexShrink: 0 }}>
        <button onClick={onBack} style={topBtn}><ArrowLeft size={13} /> Back</button>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{runName}</div>
        <span style={{ fontSize: 11, fontWeight: 700, color: st(instanceStatus).color, padding: '3px 9px', borderRadius: 20, background: st(instanceStatus).bg, border: `1px solid ${st(instanceStatus).ring}` }}>{instanceStatus}</span>
        <button onClick={downloadYaml} style={topBtn} title="Download this SDLC as a Copilot workflow YAML to run on the Copilot client"><Download size={13} /> YAML</button>
        <button onClick={() => { setShowCatalog(c => !c); setSelected(null) }} style={{ ...topBtn, ...(showCatalog ? { background: '#f0f9ff', borderColor: '#0ea5e9', color: '#0284c7' } : {}) }}><Library size={13} /> Catalog</button>
        <button onClick={onTimeline} style={topBtn}><List size={13} /> Timeline</button>
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <ReactFlow
            nodes={rfNodes} edges={rfEdges} nodeTypes={nodeTypes}
            fitView fitViewOptions={{ padding: 0.2 }}
            nodesDraggable={false} nodesConnectable={false} elementsSelectable
            proOptions={{ hideAttribution: true }}
            onPaneClick={() => setSelected(null)}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#e2e8f0" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        {showCatalog
          ? <ArtifactCatalog instanceId={instanceId} live={live} phases={orderedPhases} onClose={() => setShowCatalog(false)} />
          : selectedNode && (
            <NodePanel
              key={selectedNode.id}
              instanceId={instanceId}
              node={selectedNode}
              live={live}
              tab={tab} setTab={setTab}
              completedNodes={completedNodes}
              onClose={() => setSelected(null)}
              onRestart={() => restartMut.mutate(selectedNode.id)}
              onApprove={() => approveMut.mutate(selectedNode.id)}
              onRestartNode={(nid) => restartMut.mutate(nid)}
              onOpenTimeline={onTimeline}
              busy={busyId === selectedNode.id}
            />
          )}
      </div>
    </div>
  )
}

const topBtn: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5, padding: '6px 11px', borderRadius: 8,
  border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', color: '#475569', fontSize: 12, fontWeight: 600,
}

function NodePanel({ instanceId, node, live, tab, setTab, completedNodes, onClose, onRestart, onApprove, onRestartNode, onOpenTimeline, busy }: {
  instanceId: string
  node: RunGraphNodeData
  live: boolean
  tab: PanelTab
  setTab: (t: PanelTab) => void
  completedNodes: { id: string; label: string }[]
  onClose: () => void
  onRestart: () => void
  onApprove: () => void
  onRestartNode: (id: string) => void
  onOpenTimeline: () => void
  busy: boolean
}) {
  const s = st(node.status)
  const [sendBackOpen, setSendBackOpen] = useState(false)
  const { data: consumables = [] } = useConsumables(instanceId, node.id, live)
  const active = ['ACTIVE', 'RUNNING'].includes((node.status ?? '').toUpperCase())
  const latest = consumables[consumables.length - 1]
  const isAgent = node.nodeType === 'AGENT_TASK'
  const sendBackTargets = completedNodes.filter(c => c.id !== node.id)
  const isInteractive = INTERACTIVE_TYPES.has(node.nodeType)
  // Chat (refine) is copilot-only; non-agent nodes get Log + Artifacts.
  const tabs: PanelTab[] = isAgent ? ['log', 'artifacts', 'chat'] : ['log', 'artifacts']
  const activeTab = tab === 'chat' && !isAgent ? 'log' : tab

  return (
    <div style={{ width: 380, flexShrink: 0, background: '#fff', borderLeft: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid #e2e8f0' }}>
        <span style={{ color: s.color, display: 'flex' }}><s.Icon size={16} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0f172a' }}>{node.label}</div>
          <div style={{ fontSize: 10, fontWeight: 600, color: s.color }}>{node.nodeType} · {s.label}</div>
        </div>
        <button onClick={onClose} style={{ ...topBtn, padding: 6 }}><X size={14} /></button>
      </div>
      <div style={{ display: 'flex', gap: 4, padding: '8px 10px', borderBottom: '1px solid #f1f5f9' }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            flex: 1, padding: '6px 8px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
            border: '1px solid', borderColor: activeTab === t ? '#0ea5e9' : 'transparent',
            background: activeTab === t ? '#f0f9ff' : 'transparent', color: activeTab === t ? '#0284c7' : '#64748b',
          }}>{t}</button>
        ))}
      </div>
      {active && isInteractive && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 14px 0', padding: '9px 11px', borderRadius: 9, background: '#fffbeb', border: '1px solid #fde68a' }}>
          <AlertCircle size={14} color="#d97706" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, fontSize: 11.5, color: '#92400e', lineHeight: 1.4 }}>This stage needs input ({node.nodeType.replace(/_/g, ' ').toLowerCase()}). Complete it in the Timeline view.</div>
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: 14, minHeight: 0 }}>
        {activeTab === 'log' && (
          <pre style={{ fontSize: 11.5, lineHeight: 1.5, color: '#334155', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'ui-monospace, monospace' }}>
            {latest?.formData?.content?.toString() ?? (active ? 'Working… (live output appears here as the stage produces it)' : 'No output yet.')}
          </pre>
        )}
        {activeTab === 'artifacts' && (
          consumables.length === 0
            ? <div style={{ fontSize: 12, color: '#94a3b8' }}>No artifacts produced yet.</div>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {consumables.map(c => (
                  <div key={c.id} style={{ border: '1px solid #e2e8f0', borderRadius: 9, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', background: '#f8fafc', fontSize: 11.5, fontWeight: 700, color: '#334155' }}>
                      <FileText size={12} /> {c.name ?? 'Artifact'} {c.status ? <span style={{ fontWeight: 600, color: '#94a3b8' }}>· {c.status}</span> : null}
                    </div>
                    {c.formData?.content && (
                      <pre style={{ margin: 0, padding: 10, fontSize: 11, lineHeight: 1.5, color: '#475569', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflow: 'auto', fontFamily: 'ui-monospace, monospace' }}>{c.formData.content.toString()}</pre>
                    )}
                  </div>
                ))}
              </div>
        )}
        {activeTab === 'chat' && <ChatRefine instanceId={instanceId} node={node} busy={busy} onRestart={onRestart} />}
      </div>
      {sendBackOpen && sendBackTargets.length > 0 && (
        <div style={{ borderTop: '1px solid #e2e8f0', padding: '8px 8px', maxHeight: 170, overflow: 'auto', background: '#f8fafc' }}>
          <div style={{ fontSize: 9.5, fontWeight: 800, color: '#64748b', letterSpacing: 0.4, padding: '2px 6px 6px' }}>SEND BACK TO A PREVIOUS STAGE</div>
          {sendBackTargets.map(t => (
            <button key={t.id} onClick={() => { onRestartNode(t.id); onClose() }}
              style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: '7px 9px', borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#334155', textAlign: 'left' }}>
              <CornerUpLeft size={12} color="#0ea5e9" /> {t.label}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, padding: '10px 14px', borderTop: '1px solid #e2e8f0', flexWrap: 'wrap' }}>
        {active && isAgent && (
          <button onClick={onApprove} disabled={busy} style={{ ...footBtn, background: '#22c55e', borderColor: '#16a34a', color: '#fff', opacity: busy ? 0.6 : 1 }}>
            <Check size={13} /> Approve &amp; advance
          </button>
        )}
        {active && isInteractive && (
          <button onClick={onOpenTimeline} style={{ ...footBtn, background: '#0ea5e9', borderColor: '#0284c7', color: '#fff' }}>
            <ExternalLink size={13} /> Open in Timeline
          </button>
        )}
        <button onClick={onRestart} disabled={busy} style={{ ...footBtn, opacity: busy ? 0.6 : 1 }}>
          <RotateCw size={13} /> {busy ? 'Working…' : active ? 'Cancel & restart' : 'Restart stage'}
        </button>
        {sendBackTargets.length > 0 && (
          <button onClick={() => setSendBackOpen(o => !o)}
            style={{ ...footBtn, flex: 'none', padding: '8px 11px', ...(sendBackOpen ? { background: '#f0f9ff', borderColor: '#0ea5e9', color: '#0284c7' } : {}) }}>
            <CornerUpLeft size={13} /> Send back
          </button>
        )}
      </div>
    </div>
  )
}

const footBtn: CSSProperties = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  padding: '8px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
  border: '1px solid #e2e8f0', background: '#fff', color: '#334155',
}

function ChatRefine({ instanceId, node, busy, onRestart }: {
  instanceId: string; node: RunGraphNodeData; busy: boolean; onRestart: () => void
}) {
  const qc = useQueryClient()
  const [msg, setMsg] = useState('')
  const [sent, setSent] = useState<string[]>([])
  const refineMut = useMutation({
    mutationFn: (feedback: string) =>
      api.post(`/workflow-instances/${instanceId}/nodes/${node.id}/refine`, { feedback })
        .then(r => r.data)
        .catch(() => { onRestart(); return { fallback: true } }),
    onSuccess: (_d, feedback) => { setSent(s => [...s, feedback]); setMsg(''); qc.invalidateQueries({ queryKey: ['run-instance', instanceId] }) },
  })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sent.length === 0
          ? <div style={{ fontSize: 12, color: '#94a3b8', lineHeight: 1.5 }}>
              Send feedback to refine this stage. The stage re-runs with your note as guidance (e.g. “tighten the acceptance criteria”, “add an edge case for empty lists”).
            </div>
          : sent.map((m, i) => (
              <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '85%', padding: '7px 10px', borderRadius: 10, background: '#f0f9ff', border: '1px solid #bae6fd', fontSize: 12, color: '#0c4a6e' }}>{m}</div>
            ))}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
        <textarea
          value={msg} onChange={e => setMsg(e.target.value)} placeholder="Refine this stage…" rows={2}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && msg.trim()) refineMut.mutate(msg.trim()) }}
          style={{ flex: 1, resize: 'none', padding: '8px 10px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12, fontFamily: 'inherit' }}
        />
        <button
          onClick={() => msg.trim() && refineMut.mutate(msg.trim())}
          disabled={busy || refineMut.isPending || !msg.trim()}
          style={{ ...footBtn, flex: 'none', width: 40, padding: 8, opacity: (busy || refineMut.isPending || !msg.trim()) ? 0.5 : 1 }}
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}

// ─── Artifact catalog: every doc across the run, grouped by phase, by name ───
const catBtn: CSSProperties = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
  padding: '5px 8px', borderRadius: 6, fontSize: 10.5, fontWeight: 700, cursor: 'pointer',
  border: '1px solid', background: '#fff',
}
function ArtifactCatalog({ instanceId, live, phases, onClose }: {
  instanceId: string
  live: boolean
  phases: { id: string; label: string }[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { data: all = [] } = useAllConsumables(instanceId, live)
  const [verdicts, setVerdicts] = useState<Record<string, { passed: boolean; findings: string[] }>>({})
  const approveMut = useMutation({
    mutationFn: (cid: string) => api.post(`/consumables/${cid}/approve`).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['run-graph-all-consumables', instanceId] }),
  })
  // Verify → runs the verify endpoint (structural checks v1) + shows the verdict.
  const verifyMut = useMutation({
    mutationFn: (cid: string) => api.post(`/consumables/${cid}/verify`).then(r => r.data),
    onSuccess: (d: { passed?: boolean; findings?: string[] }, cid) =>
      setVerdicts(v => ({ ...v, [cid]: { passed: !!d?.passed, findings: d?.findings ?? [] } })),
  })
  const groups = phases
    .map(p => ({ phase: p, docs: all.filter(c => c.nodeId === p.id).slice().sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')) }))
    .filter(g => g.docs.length > 0)

  return (
    <div style={{ width: 400, flexShrink: 0, background: '#fff', borderLeft: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid #e2e8f0' }}>
        <Library size={16} color="#0ea5e9" />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0f172a' }}>Artifact Catalog</div>
          <div style={{ fontSize: 10.5, color: '#94a3b8' }}>{all.length} document{all.length === 1 ? '' : 's'} · by phase</div>
        </div>
        <button onClick={onClose} style={{ ...topBtn, padding: 6 }}><X size={14} /></button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {groups.length === 0 && <div style={{ fontSize: 12, color: '#94a3b8' }}>No artifacts produced yet.</div>}
        {groups.map(g => (
          <section key={g.phase.id}>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#64748b', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 7 }}>{g.phase.label}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {g.docs.map(d => {
                const approved = ['APPROVED', 'PUBLISHED'].some(k => (d.status ?? '').toUpperCase().includes(k))
                return (
                  <div key={d.id} style={{ border: '1px solid #e2e8f0', borderRadius: 9, padding: '8px 10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
                      <FileText size={13} color="#475569" />
                      <div style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name ?? 'Artifact'}</div>
                      {d.status && <span style={{ fontSize: 9.5, fontWeight: 700, color: approved ? '#16a34a' : '#94a3b8' }}>{d.status}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => approveMut.mutate(d.id)} disabled={approved || approveMut.isPending}
                        style={{ ...catBtn, color: '#16a34a', borderColor: '#bbf7d0', opacity: approved ? 0.5 : 1 }}>
                        <Check size={11} /> {approved ? 'Approved' : 'Approve'}
                      </button>
                      {(() => {
                        const v = verdicts[d.id]
                        const color = v ? (v.passed ? '#16a34a' : '#d97706') : '#7c3aed'
                        const border = v ? (v.passed ? '#bbf7d0' : '#fde68a') : '#ddd6fe'
                        const label = verifyMut.isPending && verifyMut.variables === d.id ? 'Verifying…'
                          : v ? (v.passed ? 'Verified ✓' : `${v.findings.length} issue${v.findings.length === 1 ? '' : 's'}`)
                          : 'Verify'
                        return (
                          <button onClick={() => verifyMut.mutate(d.id)} disabled={verifyMut.isPending}
                            title={v && !v.passed ? v.findings.join('\n') : undefined}
                            style={{ ...catBtn, color, borderColor: border }}>
                            <ShieldCheck size={11} /> {label}
                          </button>
                        )
                      })()}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
