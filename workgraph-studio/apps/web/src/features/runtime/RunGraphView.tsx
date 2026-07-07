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
import { useMemo, useState, useCallback, useEffect, type CSSProperties } from 'react'
import { RuntimeWidgetForm } from '../forms/widgets/RuntimeWidgetForm'
import type { FormWidget } from '../forms/widgets/types'
import ReactFlow, {
  Background, BackgroundVariant, Controls, Handle, Position,
  type Node, type Edge, type NodeProps,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast, errText } from '../../components/Toast'
import { runStatusVisual } from './runStatus'
import { unwrapList } from '../../lib/unwrap'
import {
  ArrowLeft, List, AlertCircle,
  RotateCw, FileText, MessageSquare, X, Check, Ban, Send, ExternalLink,
  ShieldCheck, CornerUpLeft, Library, Download, Maximize2, Activity, Copy,
} from 'lucide-react'
import { api } from '../../lib/api'
import { MarkdownView } from './MarkdownView'
import { ArtifactFullscreen } from './ArtifactFullscreen'
import { buildWorkbenchLaunchUrl } from './workbenchLaunch'
import { CopilotActivityPanel } from './CopilotActivityPanel'

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

// Status visuals come from the shared runtime palette (one source of truth for
// graph / timeline / dashboard).
const st = runStatusVisual

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

type Verdict = { passed: boolean; findings: string[]; rationale?: string; method?: string }
type Consumable = { id: string; name?: string; status?: string; nodeId?: string; createdAt?: string; updatedAt?: string; formData?: { content?: string; _verification?: Verdict } }
// Render markdown for everything except source-code files (which stay as code).
const isCodeArtifact = (name?: string) => /\.(java|ts|tsx|js|jsx|py|json|xml|ya?ml|sql|sh|go|rs|c|cpp|h|html|css|toml|gradle)$/i.test(name ?? '')
// /consumables paginates as { content: [...] } (toPageResponse); tolerate content
// (real key), items (legacy), or a bare array.
// List unwrapping lives in lib/unwrap (one shared helper for every API shape).
function useConsumables(instanceId: string, nodeId: string, live: boolean) {
  return useQuery<Consumable[]>({
    queryKey: ['run-graph-consumables', instanceId, nodeId],
    // /consumables may return a bare array OR a paginated { items: [...] } — handle both.
    queryFn: () => api.get('/consumables', { params: { instanceId, nodeId } }).then(r => unwrapList<Consumable>(r.data)),
    enabled: !!instanceId && !!nodeId,
    refetchInterval: live ? 5_000 : false,
    staleTime: 4_500,
  })
}
// All artifacts across the run — for the phase-by-phase catalog.
function useAllConsumables(instanceId: string, live: boolean) {
  return useQuery<Consumable[]>({
    queryKey: ['run-graph-all-consumables', instanceId],
    queryFn: () => api.get('/consumables', { params: { instanceId } }).then(r => unwrapList<Consumable>(r.data)),
    enabled: !!instanceId,
    refetchInterval: live ? 6_000 : false,
    staleTime: 5_000,
  })
}

type PanelTab = 'form' | 'log' | 'questions' | 'prompt' | 'artifacts' | 'chat'
// Consumable name AgentTaskExecutor stores parsed Copilot clarifying questions under.
const COPILOT_QUESTIONS_NAME = '_copilot_questions'
type CopilotQuestion = { id: string; question: string; options?: string[] }
// Interactive node types that collect a widget form from the user at runtime.
type FillKind = 'task' | 'approval' | 'consumable'
const fillKindFor = (nodeType: string): FillKind | null =>
  nodeType === 'HUMAN_TASK' ? 'task'
  : nodeType === 'APPROVAL' ? 'approval'
  : nodeType === 'CONSUMABLE_CREATION' ? 'consumable'
  : null

export function RunGraphView({ instanceId, instanceStatus, runName, nodes, edges, runContext, usesCopilot, onTimeline, onBack }: {
  instanceId: string
  instanceStatus: string
  runName: string
  nodes: RunGraphNodeData[]
  edges: RunGraphEdgeData[]
  runContext?: Record<string, unknown>
  usesCopilot?: boolean
  onTimeline: () => void
  onBack: () => void
}) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<PanelTab>('log')
  const [showCatalog, setShowCatalog] = useState(false)
  const [showActivity, setShowActivity] = useState(false)
  const live = !['COMPLETED', 'CANCELLED', 'FAILED'].includes((instanceStatus ?? '').toUpperCase())

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['run-instance', instanceId] })
  }, [qc, instanceId])

  const restartMut = useMutation({
    mutationFn: (nodeId: string) => api.post(`/workflow-instances/${instanceId}/nodes/${nodeId}/restart`).then(r => r.data),
    onSuccess: () => { toast.success('Stage restarted'); invalidate() },
    onError: (e) => toast.error(errText(e, 'Restart failed')),
  })
  const approveMut = useMutation({
    mutationFn: (nodeId: string) =>
      api.post(`/workflow-instances/${instanceId}/nodes/${nodeId}/force-complete`, { comment: 'Approved from run graph' }).then(r => r.data),
    onSuccess: () => { toast.success('Stage completed — workflow advancing'); invalidate() },
    onError: (e) => toast.error(errText(e, 'Complete & advance failed')),
  })

  // Export the run as a portable Copilot workflow + executable local runner.
  const downloadCopilotExport = useCallback(async (kind: 'yaml' | 'runner', fromPhase?: string) => {
    const path = kind === 'yaml' ? 'copilot-yaml' : 'copilot-runner.sh'
    const ext = kind === 'yaml' ? 'yaml' : 'sh'
    const qs = fromPhase ? `?fromPhase=${encodeURIComponent(fromPhase)}` : ''
    const res = await api.get(`/workflow-instances/${instanceId}/export/${path}${qs}`, { responseType: 'blob' })
    const url = URL.createObjectURL(res.data as Blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `copilot-sdlc-${instanceId.slice(0, 8)}.${ext}`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }, [instanceId])

  const onSelect = useCallback((id: string, t?: PanelTab) => {
    setShowCatalog(false); setShowActivity(false); setSelected(id)
    if (t) { setTab(t); return }
    // Open straight to the form for an active human-task / approval / data-collection node.
    const n = nodes.find(x => x.id === id)
    const w = n?.config?.formWidgets
    const kind = n ? fillKindFor(n.nodeType) : null
    const isFormNode = !!n && kind !== null
      && ['ACTIVE', 'RUNNING'].includes((n.status ?? '').toUpperCase())
      && ((Array.isArray(w) && w.length > 0) || kind === 'approval')
    setTab(isFormNode ? 'form' : 'log')
  }, [nodes])

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
        <button onClick={() => downloadCopilotExport('yaml')} style={topBtn} title="Download this run as a Copilot workflow YAML with artifact/metric pushback instructions"><Download size={13} /> Copilot YAML</button>
        <button onClick={() => downloadCopilotExport('runner')} style={topBtn} title="Download an executable script that runs Copilot CLI and posts artifacts/metrics back to the platform"><Download size={13} /> Runner</button>
        <button disabled={!selected} onClick={() => selected && downloadCopilotExport('yaml', selected)} style={{ ...topBtn, opacity: selected ? 1 : 0.45, cursor: selected ? 'pointer' : 'not-allowed' }} title="Select a phase, then download a Copilot handoff YAML starting there: earlier phases inlined as context (full artifacts + diffs), this phase onward as runnable composed prompts to continue on your own Copilot CLI"><Download size={13} /> Handoff from phase</button>
        <button onClick={() => { setShowCatalog(c => !c); setShowActivity(false); setSelected(null) }} style={{ ...topBtn, ...(showCatalog ? { background: '#f0f9ff', borderColor: '#0ea5e9', color: '#0284c7' } : {}) }}><Library size={13} /> Catalog</button>
        {usesCopilot && (
          <button onClick={() => { setShowActivity(a => !a); setShowCatalog(false); setSelected(null) }} style={{ ...topBtn, ...(showActivity ? { background: '#f0f9ff', borderColor: '#0ea5e9', color: '#0284c7' } : {}) }} title="Live governed activity for this copilot run (LLM calls, tools, phases, commits)"><Activity size={13} /> Live activity</button>
        )}
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
        {showActivity
          ? <CopilotActivityPanel instanceId={instanceId} />
          : showCatalog
          ? <ArtifactCatalog instanceId={instanceId} live={live} phases={orderedPhases} onClose={() => setShowCatalog(false)} />
          : selectedNode && (
            <NodePanel
              key={selectedNode.id}
              instanceId={instanceId}
              runName={runName}
              node={selectedNode}
              runContext={runContext}
              usesCopilot={usesCopilot}
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

function NodePanel({ instanceId, runName, node, runContext, usesCopilot, live, tab, setTab, completedNodes, onClose, onRestart, onApprove, onRestartNode, onOpenTimeline, busy }: {
  instanceId: string
  runName: string
  node: RunGraphNodeData
  runContext?: Record<string, unknown>
  usesCopilot?: boolean
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
  // The parsed Copilot questions ride in a hidden `_copilot_questions` consumable;
  // keep it out of the Log + Artifacts views and surface it in its own tab.
  const questions = useMemo<CopilotQuestion[]>(() => {
    const raw = consumables.find(c => c.name === COPILOT_QUESTIONS_NAME)?.formData?.content
    if (!raw) return []
    try { const q = JSON.parse(raw.toString()); return Array.isArray(q) ? q as CopilotQuestion[] : [] } catch { return [] }
  }, [consumables])
  const visibleConsumables = consumables.filter(c => c.name !== COPILOT_QUESTIONS_NAME)
  const latest = visibleConsumables[visibleConsumables.length - 1]
  const isAgent = node.nodeType === 'AGENT_TASK'
  const sendBackTargets = completedNodes.filter(c => c.id !== node.id)
  const isInteractive = INTERACTIVE_TYPES.has(node.nodeType)
  const callWorkflowChildId = typeof node.config?._childInstanceId === 'string' ? node.config._childInstanceId : ''
  const { data: callWorkflowChildNodes = [] } = useQuery<RunGraphNodeData[]>({
    queryKey: ['run-instance', callWorkflowChildId, 'nodes'],
    queryFn: () => api.get(`/workflow-instances/${callWorkflowChildId}/nodes`).then(r => r.data),
    enabled: Boolean(callWorkflowChildId),
    refetchInterval: live ? 5_000 : false,
  })
  const callWorkflowWorkbenchNode = callWorkflowChildNodes.find(n => n.nodeType === 'WORKBENCH_TASK')
  const callWorkflowWorkbenchUrl = callWorkflowChildId
    ? buildWorkbenchLaunchUrl(callWorkflowChildId, callWorkflowWorkbenchNode?.id, asRecord(callWorkflowWorkbenchNode?.config?.workbench), 'neo', runContext ?? {})
    : ''
  // Human-task / approval / data-collection: render the widget form inline when
  // the node is active and has a form, instead of pointing at the Timeline view.
  const fillKind = fillKindFor(node.nodeType)
  const formWidgets = (node.config?.formWidgets as FormWidget[] | undefined) ?? []
  // Approvals render their decision controls even with no widget form, so an
  // operator approves/rejects HERE instead of being bounced to the Timeline.
  const showForm = active && !!fillKind && (formWidgets.length > 0 || fillKind === 'approval')
  // Gate executors record WHY they paused the run in the instance context —
  // surface that on the blocked node instead of leaving it buried in JSON.
  const blockInfo = runContext
    ? (runContext._blockedByVerifier ?? runContext._blockedByEvalGate ?? runContext._blockedByGitPush ?? null)
    : null
  // Chat (refine) is copilot-only; non-agent nodes get Log + Artifacts. Questions
  // appears only when Copilot asked some; Form leads when input is needed.
  const baseTabs: PanelTab[] = isAgent
    ? (questions.length ? ['log', 'questions', 'prompt', 'artifacts', 'chat'] : ['log', 'prompt', 'artifacts', 'chat'])
    : ['log', 'artifacts']
  const tabs: PanelTab[] = showForm ? ['form', ...baseTabs] : baseTabs
  const activeTab: PanelTab =
    (tab === 'form' && !showForm) ? 'log'
    : (tab === 'chat' && !isAgent) ? 'log'
    : (tab === 'prompt' && !isAgent) ? 'log'
    : (tab === 'questions' && questions.length === 0) ? 'log'
    : tab

  // Artifact expand/download (parity with the workbench cockpit + the other run panels).
  const [expandedConsumableId, setExpandedConsumableId] = useState<string | null>(null)
  const expandedConsumable = visibleConsumables.find(c => c.id === expandedConsumableId)

  // Resizable review drawer. Width is persisted in localStorage so it survives
  // re-selecting a node (this panel remounts per selectedNode) and page reloads.
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 380
    const saved = Number(window.localStorage.getItem('runDrawerWidth'))
    return Number.isFinite(saved) && saved >= 320 && saved <= 2400 ? saved : 380
  })
  const startPanelResize = (startX: number) => {
    const startWidth = panelWidth
    const onMove = (ev: MouseEvent) => {
      // Drawer is anchored to the right, so dragging LEFT widens it.
      const next = Math.min(Math.max(startWidth + (startX - ev.clientX), 320), Math.round(window.innerWidth * 0.9))
      setPanelWidth(next)
      try { window.localStorage.setItem('runDrawerWidth', String(next)) } catch { /* ignore */ }
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  const downloadConsumable = (c: typeof visibleConsumables[number]) => {
    const text = c.formData?.content?.toString() ?? ''
    if (!text) return
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const safe = (c.name ?? 'artifact').toString().replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'artifact'
    link.href = url
    link.download = isCodeArtifact(c.name) ? safe : `${safe}.md`
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url)
  }

  // Single-intent "what's next" for copilot nodes — mirrors the cockpit's FocusPane idea.
  const isCopilotNode = !!usesCopilot || node.config?.executor === 'copilot'
  const nextStep: { label: string; onClick?: () => void; tone: 'amber' | 'green' | 'muted' } | null =
    !isCopilotNode ? null
    : questions.length > 0 ? { label: `Answer ${questions.length} question${questions.length === 1 ? '' : 's'} to continue`, onClick: () => setTab('questions'), tone: 'amber' }
    : (active && isAgent) ? (busy ? { label: 'Working…', tone: 'muted' } : { label: 'Review the output, then approve to advance', onClick: onApprove, tone: 'green' })
    : active ? { label: 'Working…', tone: 'muted' }
    : null

  return (
    <div style={{ width: panelWidth, flexShrink: 0, background: '#fff', borderLeft: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
      {/* Drag handle on the left edge — resize the review drawer; double-click resets. */}
      <div
        onMouseDown={(e) => { e.preventDefault(); startPanelResize(e.clientX) }}
        onDoubleClick={() => { setPanelWidth(380); try { window.localStorage.setItem('runDrawerWidth', '380') } catch { /* ignore */ } }}
        title="Drag to resize · double-click to reset"
        style={{ position: 'absolute', left: -3, top: 0, bottom: 0, width: 7, cursor: 'col-resize', zIndex: 20 }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid #e2e8f0' }}>
        <span style={{ color: s.color, display: 'flex' }}><s.Icon size={16} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0f172a' }}>{node.label}</div>
          <div style={{ fontSize: 10, fontWeight: 600, color: s.color }}>{node.nodeType} · {s.label}</div>
        </div>
        <button onClick={onClose} style={{ ...topBtn, padding: 6 }}><X size={14} /></button>
      </div>
      <div style={{ display: 'flex', gap: 4, padding: '8px 10px', borderBottom: '1px solid #f1f5f9' }}>
        {tabs.map(t => {
          const isQ = t === 'questions'
          return (
            <button key={t} onClick={() => setTab(t)} style={{
              flex: 1, padding: '6px 8px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
              border: '1px solid',
              borderColor: activeTab === t ? (isQ ? '#f59e0b' : '#0ea5e9') : 'transparent',
              background: activeTab === t ? (isQ ? '#fffbeb' : '#f0f9ff') : 'transparent',
              color: activeTab === t ? (isQ ? '#b45309' : '#0284c7') : (isQ ? '#b45309' : '#64748b'),
            }}>{isQ ? `Questions (${questions.length})` : t}</button>
          )
        })}
      </div>
      {nextStep && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 14px 0', padding: '9px 11px', borderRadius: 9, ...nextStepTone(nextStep.tone) }}>
          <div style={{ flex: 1, fontSize: 11.5, fontWeight: 600, lineHeight: 1.4 }}>{nextStep.label}</div>
          {nextStep.onClick && (
            <button onClick={nextStep.onClick} disabled={busy} style={{ ...footBtn, flex: 'none', padding: '5px 11px', fontSize: 11, opacity: busy ? 0.6 : 1 }}>Go</button>
          )}
        </div>
      )}
      {active && isInteractive && !showForm && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '10px 14px 0', padding: '9px 11px', borderRadius: 9, background: '#fffbeb', border: '1px solid #fde68a' }}>
          <AlertCircle size={14} color="#d97706" style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, fontSize: 11.5, color: '#92400e', lineHeight: 1.4 }}>This stage needs input ({node.nodeType.replace(/_/g, ' ').toLowerCase()}). Complete it in the Timeline view.</div>
        </div>
      )}
      {(node.status ?? '').toUpperCase() === 'BLOCKED' && blockInfo != null && (
        <div style={{ margin: '10px 14px 0', padding: '9px 11px', borderRadius: 9, background: '#fef2f2', border: '1px solid #fecaca', fontSize: 11.5, color: '#991b1b', lineHeight: 1.45, maxHeight: 190, overflow: 'auto' }}>
          <div style={{ fontWeight: 800, marginBottom: 4 }}>Why this stage is blocked</div>
          <BlockReasonBody info={blockInfo} />
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: 14, minHeight: 0 }}>
        {activeTab === 'form' && fillKind && (
          <NodeFormFill instanceId={instanceId} nodeId={node.id} runName={runName} kind={fillKind} widgets={formWidgets} />
        )}
        {activeTab === 'log' && (
          <pre style={{ fontSize: 11.5, lineHeight: 1.5, color: '#334155', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'ui-monospace, monospace' }}>
            {latest?.formData?.content?.toString() ?? (active ? 'Working… (live output appears here as the stage produces it)' : 'No output yet.')}
          </pre>
        )}
        {activeTab === 'questions' && <CopilotQuestions instanceId={instanceId} node={node} questions={questions} busy={busy} onRestart={onRestart} />}
        {activeTab === 'artifacts' && (
          visibleConsumables.length === 0
            ? <div style={{ fontSize: 12, color: '#94a3b8' }}>No artifacts produced yet.</div>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {visibleConsumables.map(c => (
                  <div key={c.id} style={{ border: '1px solid #e2e8f0', borderRadius: 9, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', background: '#f8fafc', fontSize: 11.5, fontWeight: 700, color: '#334155' }}>
                      <FileText size={12} />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name ?? 'Artifact'} {c.status ? <span style={{ fontWeight: 600, color: '#94a3b8' }}>· {c.status}</span> : null}</span>
                      {c.formData?.content ? (
                        <>
                          <button onClick={() => downloadConsumable(c)} title="Download" style={artifactIconBtn}><Download size={12} /></button>
                          <button onClick={() => setExpandedConsumableId(c.id)} title="Expand to full screen" style={artifactIconBtn}><Maximize2 size={12} /></button>
                        </>
                      ) : null}
                    </div>
                    {c.formData?.content && (
                      <div style={{ margin: 0, padding: 10, fontSize: 11.5, lineHeight: 1.5, color: '#334155', maxHeight: 320, overflow: 'auto' }}>
                        {isCodeArtifact(c.name)
                          ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, monospace' }}>{c.formData.content.toString()}</pre>
                          : <MarkdownView source={c.formData.content.toString()} />}
                      </div>
                    )}
                  </div>
                ))}
              </div>
        )}
        {activeTab === 'chat' && <ChatRefine instanceId={instanceId} node={node} busy={busy} onRestart={onRestart} />}
        {activeTab === 'prompt' && <PromptView instanceId={instanceId} node={node} />}
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
        {isCopilotNode && isAgent && (
          // Open this copilot stage in the full Workbench cockpit (review artifacts, evidence,
          // and chat). Advancing the run stays here (Approve & advance); the cockpit is the
          // review surface. Requires WORKBENCH_ALLOW_MAIN_PROFILE for non-workbench runs.
          <a
            href={buildWorkbenchLaunchUrl(instanceId, node.id, (node.config?.workbench ?? {}) as Record<string, unknown>, 'neo', runContext ?? {})}
            target="_blank"
            rel="noreferrer"
            title="Open this copilot stage in the Workbench cockpit"
            style={{ ...footBtn, flex: 'none', padding: '8px 11px', textDecoration: 'none', background: '#7c3aed', borderColor: '#6d28d9', color: '#fff' }}
          >
            <ExternalLink size={13} /> Open in Workbench
          </a>
        )}
        {node.nodeType === 'CALL_WORKFLOW' && callWorkflowChildId && (
          <>
            <a
              href={callWorkflowWorkbenchUrl}
              target="_blank"
              rel="noreferrer"
              title="Open the spawned child workflow in Workbench Neo"
              style={{ ...footBtn, flex: 'none', padding: '8px 11px', textDecoration: 'none', background: '#7c3aed', borderColor: '#6d28d9', color: '#fff' }}
            >
              <ExternalLink size={13} /> Open Workbench Neo
            </a>
            <a
              href={`/runs/${callWorkflowChildId}`}
              title="Open the raw child workflow timeline"
              style={{ ...footBtn, flex: 'none', padding: '8px 11px', textDecoration: 'none' }}
            >
              <ExternalLink size={13} /> View sub-run
            </a>
          </>
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
      {expandedConsumable && (
        <ArtifactFullscreen
          title={(expandedConsumable.name ?? 'Artifact').toString()}
          content={isCodeArtifact(expandedConsumable.name) ? undefined : expandedConsumable.formData?.content?.toString()}
          body={expandedConsumable.formData?.content?.toString() ?? ''}
          canDownload={!!expandedConsumable.formData?.content}
          onDownload={() => downloadConsumable(expandedConsumable)}
          onClose={() => setExpandedConsumableId(null)}
        />
      )}
    </div>
  )
}

const footBtn: CSSProperties = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  padding: '8px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
  border: '1px solid #e2e8f0', background: '#fff', color: '#334155',
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

const artifactIconBtn: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
  padding: 4, borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', color: '#64748b',
}

function nextStepTone(tone: 'amber' | 'green' | 'muted'): CSSProperties {
  if (tone === 'amber') return { background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e' }
  if (tone === 'green') return { background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534' }
  return { background: '#f8fafc', border: '1px solid #e2e8f0', color: '#64748b' }
}

// "The prompt used" — the FULL composed prompt (role contract + repo world model +
// work item + task) this phase's agent runs, fetched on demand (the same composition
// the Copilot handoff export builds). Works for pending AND completed phases; a
// degraded flag warns when it fell back toward the raw task.
function PromptView({ instanceId, node }: { instanceId: string; node: RunGraphNodeData }) {
  const [copied, setCopied] = useState(false)
  const q = useQuery({
    queryKey: ['run-node-prompt', instanceId, node.id],
    queryFn: () => api.get(`/workflow-instances/${instanceId}/nodes/${node.id}/composed-prompt`).then(r => r.data as {
      composable: boolean; prompt?: string; degraded?: boolean; warning?: string; role?: string; stageKey?: string; reason?: string
    }),
    staleTime: 30_000,
  })
  const copy = (text: string) => {
    navigator.clipboard?.writeText(text)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
      .catch(() => { /* clipboard blocked — ignore */ })
  }
  if (q.isLoading) return <div style={{ fontSize: 12, color: '#94a3b8' }}>Composing the prompt…</div>
  if (q.isError) return <div style={{ fontSize: 12, color: '#b91c1c' }}>Couldn&apos;t load the prompt. {errText(q.error, 'request failed')}</div>
  const d = q.data
  if (!d || d.composable === false) {
    return <div style={{ fontSize: 12, color: '#94a3b8' }}>{d?.reason ?? 'No composed prompt for this phase.'}</div>
  }
  const prompt = d.prompt ?? ''
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, fontSize: 11, color: '#64748b', lineHeight: 1.45 }}>
          The full prompt this phase&apos;s agent runs{d.role ? ` · role ${d.role}` : ''} — role contract + repo world model + work item + task.
        </div>
        <button onClick={() => copy(prompt)} disabled={!prompt}
          style={{ ...footBtn, flex: 'none', padding: '5px 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 5, opacity: prompt ? 1 : 0.5 }}>
          <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {d.degraded && (
        <div style={{ display: 'flex', gap: 7, padding: '8px 10px', borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a', fontSize: 11, color: '#92400e', lineHeight: 1.4 }}>
          <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} color="#d97706" />
          <span>Composed with a fallback{d.warning ? ` — ${d.warning}` : ' — the repo world model or composer was unavailable, so this is closer to the raw task than the fully grounded prompt.'}</span>
        </div>
      )}
      <pre style={{ margin: 0, fontSize: 11.5, lineHeight: 1.55, color: '#334155', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'ui-monospace, monospace', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 9, padding: 12 }}>
        {prompt || 'The composer returned an empty prompt.'}
      </pre>
    </div>
  )
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
    onSuccess: (_d, feedback) => { toast.success('Feedback sent — stage re-running'); setSent(s => [...s, feedback]); setMsg(''); qc.invalidateQueries({ queryKey: ['run-instance', instanceId] }) },
    onError: (e) => toast.error(errText(e, 'Failed to send feedback')),
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

// Copilot clarifying questions — rendered like the workbench's question cards
// (option chips + free-text), answered, then the stage re-runs with the answers
// injected as decisions (POST /answer-questions → restartNode).
function CopilotQuestions({ instanceId, node, questions, busy, onRestart }: {
  instanceId: string; node: RunGraphNodeData; questions: CopilotQuestion[]; busy: boolean; onRestart: () => void
}) {
  const qc = useQueryClient()
  const [answers, setAnswers] = useState<Record<string, { option?: string; text?: string }>>({})
  const answerText = (q: CopilotQuestion): string => {
    const a = answers[q.id]; if (!a) return ''
    const opt = a.option ?? ''; const txt = (a.text ?? '').trim()
    return opt && txt ? `${opt} — ${txt}` : (txt || opt)
  }
  const payload = questions
    .map(q => ({ questionId: q.id, question: q.question, answer: answerText(q) }))
    .filter(a => a.answer)
  const mut = useMutation({
    mutationFn: () =>
      api.post(`/workflow-instances/${instanceId}/nodes/${node.id}/answer-questions`, { answers: payload })
        .then(r => r.data)
        .catch(() => { onRestart(); return { fallback: true } }),
    onSuccess: () => { toast.success('Answers saved — stage re-running with your decisions'); setAnswers({}); qc.invalidateQueries({ queryKey: ['run-instance', instanceId] }) },
    onError: (e) => toast.error(errText(e, 'Failed to save answers')),
  })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ fontSize: 11.5, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 10px', lineHeight: 1.45 }}>
        Copilot asked {questions.length} question{questions.length > 1 ? 's' : ''} for this stage. Answer and re-run — your answers are injected as confirmed decisions so it won't guess.
      </div>
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {questions.map(q => (
          <div key={q.id} style={{ border: '1px solid #e2e8f0', borderRadius: 9, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#0f172a', lineHeight: 1.4 }}>{q.question}</div>
            {q.options && q.options.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {q.options.map(opt => {
                  const sel = answers[q.id]?.option === opt
                  return (
                    <button key={opt} type="button"
                      onClick={() => setAnswers(s => ({ ...s, [q.id]: { ...s[q.id], option: sel ? undefined : opt } }))}
                      style={{
                        padding: '5px 10px', borderRadius: 7, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', border: '1px solid',
                        borderColor: sel ? '#0ea5e9' : '#e2e8f0', background: sel ? '#f0f9ff' : '#fff', color: sel ? '#0284c7' : '#475569',
                      }}>{opt}</button>
                  )
                })}
              </div>
            )}
            <textarea rows={2} value={answers[q.id]?.text ?? ''}
              onChange={e => setAnswers(s => ({ ...s, [q.id]: { ...s[q.id], text: e.target.value } }))}
              placeholder={q.options?.length ? 'Add detail (optional)…' : 'Your answer…'}
              style={{ resize: 'none', padding: '7px 9px', borderRadius: 7, border: '1px solid #e2e8f0', fontSize: 11.5, fontFamily: 'inherit' }} />
          </div>
        ))}
      </div>
      <button onClick={() => payload.length && mut.mutate()} disabled={busy || mut.isPending || payload.length === 0}
        style={{ ...footBtn, opacity: (busy || mut.isPending || payload.length === 0) ? 0.5 : 1 }}>
        <Send size={14} /> Save answers &amp; re-run ({payload.length}/{questions.length})
      </button>
    </div>
  )
}

// Renders a gate executor's block payload (verifier docs+findings, eval-gate
// missing evidence, git-push error) as readable text; JSON fallback for shapes
// we don't recognize.
function BlockReasonBody({ info }: { info: unknown }) {
  const o = info as Record<string, unknown>
  if (Array.isArray(o?.documents)) { // VERIFIER: per-document findings
    const docs = o.documents as Array<{ name?: string; passed?: boolean; findings?: string[]; rationale?: string }>
    const failed = docs.filter(d => !d.passed)
    if (failed.length === 0) return <div>{String(o.note ?? 'Verification blocked this stage.')}</div>
    return (
      <div>
        {failed.map((d, i) => (
          <div key={i} style={{ marginBottom: 5 }}>
            <strong>{d.name ?? 'document'}</strong>{d.rationale ? ` — ${d.rationale}` : null}
            {(d.findings?.length ?? 0) > 0 && (
              <ul style={{ margin: '2px 0 0', paddingLeft: 16 }}>{d.findings!.slice(0, 5).map((f, j) => <li key={j}>{f}</li>)}</ul>
            )}
          </div>
        ))}
      </div>
    )
  }
  if (typeof o?.pushError === 'string') return <div>{o.pushError}</div> // GIT_PUSH
  if (Array.isArray(o?.missingEvidence) && o.missingEvidence.length > 0) { // EVAL_GATE
    return <ul style={{ margin: 0, paddingLeft: 16 }}>{(o.missingEvidence as string[]).map((m, i) => <li key={i}>{m}</li>)}</ul>
  }
  if (Array.isArray(o?.blocked) && typeof o?.effectiveMode === 'string') { // GOVERNANCE_GATE
    const blocked = o.blocked as Array<{ controlKey?: string; reason?: string; mode?: string }>
    const satisfied = Array.isArray(o.satisfied) ? (o.satisfied as string[]) : []
    const waived = Array.isArray(o.waived) ? (o.waived as string[]) : []
    return (
      <div>
        {o.note ? <div style={{ marginBottom: 4 }}>{String(o.note)}</div> : null}
        {blocked.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {blocked.map((b, i) => (
              <li key={i}><strong>{b.controlKey}</strong>{b.mode ? ` (${b.mode})` : ''}{b.reason ? ` — ${b.reason}` : ''}</li>
            ))}
          </ul>
        )}
        {(satisfied.length > 0 || waived.length > 0) && (
          <div style={{ marginTop: 4, opacity: 0.7, fontSize: '0.85em' }}>
            satisfied: {satisfied.join(', ') || '—'} · waived: {waived.join(', ') || '—'}
          </div>
        )}
      </div>
    )
  }
  return <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit' }}>{JSON.stringify(info, null, 1).slice(0, 600)}</pre>
}

// Inline runtime form for an active human-task / approval / data-collection node.
// Fetches the task/approval/consumable record for this node and renders the SAME
// RuntimeWidgetForm the Timeline uses, so clicking the node shows the form here.
function unwrapEntity(d: unknown): { id: string; formData?: Record<string, unknown>; attachments?: any[] } | null {
  return unwrapList<{ id: string; formData?: Record<string, unknown>; attachments?: any[] }>(d)[0] ?? null
}
function NodeFormFill({ instanceId, nodeId, runName, kind, widgets }: {
  instanceId: string; nodeId: string; runName: string; kind: FillKind; widgets: FormWidget[]
}) {
  const qc = useQueryClient()
  const path = kind === 'task' ? '/tasks' : kind === 'approval' ? '/approvals' : '/consumables'
  const entityQuery = useQuery({
    queryKey: ['rg-fill-entity', kind, nodeId, instanceId],
    queryFn: () => api.get(path, { params: { nodeId, instanceId } }).then(r => r.data),
    enabled: !!nodeId && !!instanceId,
  })
  const entity = unwrapEntity(entityQuery.data)
  const [snapshot, setSnapshot] = useState<{ data: Record<string, unknown>; attachmentIds: string[] }>({ data: {}, attachmentIds: [] })

  // Approval nodes may not have a pending record yet — create one on demand.
  const ensureMut = useMutation({
    mutationFn: () => api.post(`/approvals/workflow-node/${nodeId}/ensure`).then(r => r.data),
    onSuccess: () => entityQuery.refetch(),
  })
  useEffect(() => {
    if (kind === 'approval' && entityQuery.isFetched && !entity
        && !ensureMut.isPending && !ensureMut.isSuccess && !ensureMut.isError) {
      ensureMut.mutate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, entityQuery.isFetched, !!entity])

  const decisionMut = useMutation({
    mutationFn: async (decision: 'APPROVED' | 'REJECTED') => {
      if (!entity) return
      await api.post(`/approvals/${entity.id}/form-submission`, { data: snapshot.data, attachmentIds: snapshot.attachmentIds })
      return api.post(`/approvals/${entity.id}/decision`, {
        decision, notes: `${decision === 'APPROVED' ? 'Approved' : 'Rejected'} from run graph`,
      }).then(r => r.data)
    },
    onSuccess: (_d, decision) => {
      toast.success(decision === 'APPROVED' ? 'Approved — workflow advancing' : 'Rejected — recorded')
      qc.invalidateQueries({ queryKey: ['run-instance', instanceId] }); entityQuery.refetch()
    },
    onError: (e) => toast.error(errText(e, 'Decision failed')),
  })

  if (entityQuery.isLoading) return <div style={{ fontSize: 12, color: '#94a3b8' }}>Loading form…</div>
  if (!entity) return <div style={{ fontSize: 12, color: '#94a3b8' }}>Waiting for the {kind} record to be created…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 11, color: '#0c4a6e', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '7px 10px', lineHeight: 1.45 }}>
        Fill this form to complete the step — Run <strong>{runName}</strong>.
      </div>
      <RuntimeWidgetForm
        widgets={widgets}
        submitTo={{ kind, id: entity.id }}
        link={{ taskId: kind === 'task' ? entity.id : undefined, nodeId, instanceId }}
        initialData={entity.formData ?? {}}
        initialAttachments={Array.isArray(entity.attachments) ? entity.attachments : []}
        canComplete
        onSubmitted={() => { qc.invalidateQueries({ queryKey: ['run-instance', instanceId] }); entityQuery.refetch() }}
        onValuesChange={kind === 'approval' ? setSnapshot : undefined}
        hideActions={kind === 'approval'}
        primaryLabel={kind === 'approval' ? 'Save sign-off form' : undefined}
      />
      {kind === 'approval' && (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid #e2e8f0', paddingTop: 10 }}>
          <button onClick={() => decisionMut.mutate('REJECTED')} disabled={decisionMut.isPending}
            style={{ ...footBtn, flex: 'none', width: 'auto', padding: '7px 12px', color: '#991b1b' }}>Reject</button>
          <button onClick={() => decisionMut.mutate('APPROVED')} disabled={decisionMut.isPending}
            style={{ ...footBtn, flex: 'none', width: 'auto', padding: '7px 12px', background: '#16a34a', color: '#fff', borderColor: '#16a34a' }}>
            {decisionMut.isPending ? 'Saving…' : 'Approve & advance'}
          </button>
        </div>
      )}
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
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({})
  const [forceConfirm, setForceConfirm] = useState<string | null>(null)
  const [openDoc, setOpenDoc] = useState<Consumable | null>(null)
  const approveMut = useMutation({
    mutationFn: ({ cid, force }: { cid: string; force?: boolean }) =>
      api.post(`/consumables/${cid}/approve${force ? '?force=true' : ''}`).then(r => r.data),
    onSuccess: () => { toast.success('Document approved'); setForceConfirm(null); qc.invalidateQueries({ queryKey: ['run-graph-all-consumables', instanceId] }) },
    onError: (err: unknown, vars) => {
      // Verify-before-approve gate fired (409) — surface the findings + offer override.
      const data = (err as { response?: { data?: { error?: string; verification?: Verdict } } })?.response?.data
      if (data?.error === 'verification_failed') {
        if (data.verification) setVerdicts(s => ({ ...s, [vars.cid]: { passed: false, findings: data.verification!.findings ?? [], rationale: data.verification!.rationale } }))
        setForceConfirm(vars.cid)
        toast.error('Verification failed — review the findings, or click "Approve anyway"')
      } else {
        toast.error(errText(err, 'Approve failed'))
      }
    },
  })
  // Verify → runs the verifier agent (reads the run's standards/policies + LLM-judges).
  const verifyMut = useMutation({
    mutationFn: (cid: string) => api.post(`/consumables/${cid}/verify`).then(r => r.data),
    onSuccess: (d: { passed?: boolean; findings?: string[]; rationale?: string }, cid) => {
      setVerdicts(v => ({ ...v, [cid]: { passed: !!d?.passed, findings: d?.findings ?? [], rationale: d?.rationale } }))
      if (d?.passed) toast.success('Verified — meets the standards')
      else toast.info(`${d?.findings?.length ?? 0} issue${(d?.findings?.length ?? 0) === 1 ? '' : 's'} found against the standards`)
    },
    onError: (e) => toast.error(errText(e, 'Verification failed to run')),
  })
  // Verify all → run the agent across every document, sequentially (each is an LLM
  // call), updating verdicts as they land.
  const [verifyAll, setVerifyAll] = useState<{ done: number; total: number } | null>(null)
  const runVerifyAll = async () => {
    if (verifyAll || all.length === 0) return
    setVerifyAll({ done: 0, total: all.length })
    for (let i = 0; i < all.length; i++) {
      try {
        const d = await api.post(`/consumables/${all[i].id}/verify`).then(r => r.data)
        setVerdicts(v => ({ ...v, [all[i].id]: { passed: !!d?.passed, findings: d?.findings ?? [], rationale: d?.rationale } }))
      } catch { /* skip this doc, keep going */ }
      setVerifyAll({ done: i + 1, total: all.length })
    }
    setVerifyAll(null)
    qc.invalidateQueries({ queryKey: ['run-graph-all-consumables', instanceId] })
  }
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
        <button onClick={runVerifyAll} disabled={!!verifyAll || all.length === 0}
          title="Run the verifier agent on every document"
          style={{ ...topBtn, padding: '5px 9px', fontSize: 11, color: '#7c3aed', borderColor: '#ddd6fe', opacity: (!!verifyAll || all.length === 0) ? 0.6 : 1 }}>
          <ShieldCheck size={12} /> {verifyAll ? `Verifying ${verifyAll.done}/${verifyAll.total}…` : 'Verify all'}
        </button>
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
                // Effective verdict: the one just clicked, else the persisted one.
                const v: Verdict | undefined = verdicts[d.id] ?? d.formData?._verification
                const needsForce = forceConfirm === d.id
                return (
                  <div key={d.id} style={{ border: '1px solid #e2e8f0', borderRadius: 9, padding: '8px 10px' }}>
                    <div onClick={() => setOpenDoc(d)} title="Open" style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7, cursor: 'pointer' }}>
                      <FileText size={13} color="#0ea5e9" />
                      <div style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: '#0284c7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name ?? 'Artifact'}</div>
                      {(d.updatedAt || d.createdAt) && <span style={{ fontSize: 9, color: '#94a3b8', whiteSpace: 'nowrap' }}>{new Date(d.updatedAt ?? d.createdAt!).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
                      {d.status && <span style={{ fontSize: 9.5, fontWeight: 700, color: approved ? '#16a34a' : '#94a3b8' }}>{d.status}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => approveMut.mutate({ cid: d.id, force: needsForce })} disabled={approved || approveMut.isPending}
                        title={needsForce ? 'This document failed verification — approve anyway?' : undefined}
                        style={{ ...catBtn, color: needsForce ? '#b45309' : '#16a34a', borderColor: needsForce ? '#fde68a' : '#bbf7d0', opacity: approved ? 0.5 : 1 }}>
                        <Check size={11} /> {approved ? 'Approved' : needsForce ? 'Approve anyway' : 'Approve'}
                      </button>
                      {(() => {
                        const color = v ? (v.passed ? '#16a34a' : '#d97706') : '#7c3aed'
                        const border = v ? (v.passed ? '#bbf7d0' : '#fde68a') : '#ddd6fe'
                        const label = verifyMut.isPending && verifyMut.variables === d.id ? 'Verifying…'
                          : v ? (v.passed ? 'Verified ✓' : `${v.findings.length} issue${v.findings.length === 1 ? '' : 's'}`)
                          : 'Verify'
                        return (
                          <button onClick={() => verifyMut.mutate(d.id)} disabled={verifyMut.isPending}
                            title={v && !v.passed ? v.findings.join('\n') : v?.rationale}
                            style={{ ...catBtn, color, borderColor: border }}>
                            <ShieldCheck size={11} /> {label}
                          </button>
                        )
                      })()}
                    </div>
                    {v && (!v.passed || v.rationale) && (
                      <div style={{ marginTop: 7, padding: '6px 8px', borderRadius: 7, fontSize: 10.5, lineHeight: 1.4,
                        background: v.passed ? '#f0fdf4' : '#fffbeb', border: `1px solid ${v.passed ? '#bbf7d0' : '#fde68a'}`, color: v.passed ? '#15803d' : '#92400e' }}>
                        {v.rationale && <div style={{ marginBottom: !v.passed && v.findings.length ? 4 : 0 }}>{v.rationale}</div>}
                        {!v.passed && v.findings.length > 0 && (
                          <ul style={{ margin: 0, paddingLeft: 16 }}>{v.findings.slice(0, 6).map((f, i) => <li key={i}>{f}</li>)}</ul>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>
      {openDoc && (
        <div onClick={() => setOpenDoc(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: 24 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(840px, 92vw)', maxHeight: '88vh', background: '#fff', borderRadius: 14, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 12px 48px rgba(0,0,0,0.3)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '13px 16px', borderBottom: '1px solid #e2e8f0' }}>
              <FileText size={15} color="#0ea5e9" />
              <div style={{ flex: 1, fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{openDoc.name ?? 'Artifact'}</div>
              {(openDoc.updatedAt || openDoc.createdAt) && <span style={{ fontSize: 10.5, color: '#94a3b8' }}>{new Date(openDoc.updatedAt ?? openDoc.createdAt!).toLocaleString()}</span>}
              <button onClick={() => setOpenDoc(null)} style={{ ...topBtn, padding: 6 }}><X size={15} /></button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '18px 22px', minHeight: 0 }}>
              {(() => {
                const dv: Verdict | undefined = verdicts[openDoc.id] ?? openDoc.formData?._verification
                if (!dv) return null
                return (
                  <div style={{ marginBottom: 14, padding: '10px 12px', borderRadius: 9, fontSize: 12, lineHeight: 1.45,
                    background: dv.passed ? '#f0fdf4' : '#fffbeb', border: `1px solid ${dv.passed ? '#bbf7d0' : '#fde68a'}`, color: dv.passed ? '#15803d' : '#92400e' }}>
                    <div style={{ fontWeight: 700, marginBottom: dv.rationale || (!dv.passed && dv.findings.length) ? 5 : 0 }}>
                      {dv.passed ? '✓ Verified — meets the standards' : `⚠ ${dv.findings.length} issue${dv.findings.length === 1 ? '' : 's'} against the standards`}
                    </div>
                    {dv.rationale && <div style={{ marginBottom: !dv.passed && dv.findings.length ? 5 : 0 }}>{dv.rationale}</div>}
                    {!dv.passed && dv.findings.length > 0 && <ul style={{ margin: 0, paddingLeft: 18 }}>{dv.findings.map((f, i) => <li key={i}>{f}</li>)}</ul>}
                  </div>
                )
              })()}
              {isCodeArtifact(openDoc.name)
                ? <pre style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#334155', fontFamily: 'ui-monospace, monospace' }}>{openDoc.formData?.content ?? '(empty)'}</pre>
                : <MarkdownView source={openDoc.formData?.content ?? '(empty)'} />}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
