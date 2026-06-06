/**
 * Workbench stage-graph editor — P1 (editable canvas).
 *
 * Replaces the read-only WorkbenchMiniCanvas / the monolithic accordion: each
 * workbench stage is a draggable React Flow node; FORWARD (solid) and SEND_BACK
 * (dashed amber) edges connect them. All edits go through the first-class
 * workbench-definitions API (/api/workflow-nodes/:nodeId/workbench), which
 * write-throughs to the runtime loopDefinition + reconciles governance — so the
 * blueprint runtime is untouched.
 *
 * P1 scope: add / delete stage, connect / delete edge (FORWARD|SEND_BACK),
 * drag-to-reposition (persisted). Per-stage field editing (agentRole, policies,
 * artifacts, questions) lands in P2 (the stage inspector); for now a stage is
 * created with sensible defaults and the legacy accordion stays available below.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactFlow, {
  Background, Controls, Handle, Position, MarkerType,
  ReactFlowProvider, useNodesState, useEdgesState,
  type Connection, type Node, type Edge as RFEdge, type NodeProps,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { api } from '../../lib/api'

type StageView = {
  id: string
  stageKey: string
  label: string
  agentRole: string
  ordinal: number
  positionX: number | null
  positionY: number | null
  terminal: boolean
  approvalRequired: boolean
  toolPolicy: string
  contextPolicy: string
  expectedArtifacts: Array<{ id: string; kind: string; title: string }>
}
type EdgeView = { id: string; fromStageId: string; toStageId: string; kind: 'FORWARD' | 'SEND_BACK'; label: string | null }
type DefinitionView = { id: string; name: string; stages: StageView[]; edges: EdgeView[] }

const NODE_W = 230

function stageAccent(s: StageView): string {
  if (s.contextPolicy === 'CODE_EDIT' || s.toolPolicy === 'MUTATION') return '#2563eb'
  if (s.contextPolicy === 'STORY_ONLY' || s.toolPolicy === 'NONE') return '#64748b'
  if (s.contextPolicy === 'VERIFY_ONLY' || s.toolPolicy === 'VERIFICATION') return '#16a34a'
  if (s.contextPolicy === 'EVIDENCE_REVIEW') return '#7c3aed'
  return '#0ea5e9'
}
function policyText(s: StageView): string {
  const tool = s.toolPolicy === 'NONE' ? 'no tools' : s.toolPolicy === 'READ_ONLY' ? 'read-only' : s.toolPolicy === 'MUTATION' ? 'mutation' : 'verification'
  return `${tool} · ${s.contextPolicy.replaceAll('_', ' ').toLowerCase()}`
}

// ─── Custom stage node ───────────────────────────────────────────────────────
type StageNodeData = { stage: StageView; onClick?: (stageKey: string) => void }
function StageNode({ data }: NodeProps<StageNodeData>) {
  const s = data.stage
  const accent = stageAccent(s)
  return (
    <div
      onClick={() => data.onClick?.(s.stageKey)}
      style={{
        width: NODE_W, borderRadius: 10, background: '#fff',
        border: `1.5px solid ${s.terminal ? '#16a34a' : accent}`,
        boxShadow: '0 1px 3px rgba(15,23,42,0.10)', overflow: 'hidden', cursor: 'pointer',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: '#94a3b8' }} />
      <div style={{ height: 4, background: accent }} />
      <div style={{ padding: '8px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 800, color: '#0f172a' }}>{s.label}</span>
          {s.terminal && <span style={{ fontSize: 9, fontWeight: 800, color: '#16a34a' }}>TERMINAL</span>}
        </div>
        <div style={{ fontSize: 10, color: '#64748b', fontFamily: 'ui-monospace, monospace', marginTop: 2 }}>{s.agentRole} · {s.stageKey}</div>
        <div style={{ fontSize: 10, color: '#64748b', marginTop: 3 }}>{policyText(s)}</div>
        <div style={{ fontSize: 10, color: '#64748b', marginTop: 3 }}>
          {s.expectedArtifacts.length} artifact{s.expectedArtifacts.length === 1 ? '' : 's'}{s.approvalRequired ? ' · approval ●' : ''}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: accent }} />
    </div>
  )
}
const nodeTypes = { stage: StageNode }

// ─── Canvas ──────────────────────────────────────────────────────────────────
function Canvas({ nodeId, onSelectStage }: { nodeId: string; onSelectStage?: (k: string) => void }) {
  const qc = useQueryClient()
  const base = `/workflow-nodes/${encodeURIComponent(nodeId)}/workbench`
  const { data, isLoading, error } = useQuery<DefinitionView | null>({
    queryKey: ['workbench-definition', nodeId],
    queryFn: async () => {
      try { return (await api.get(base)).data?.data ?? null }
      catch (e) { if ((e as { response?: { status?: number } })?.response?.status === 404) return null; throw e }
    },
    staleTime: 3_000,
  })

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: ['workbench-definition', nodeId] }), [qc, nodeId])
  const onErr = (e: unknown) => window.alert(`Edit failed: ${(e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? (e as Error).message}`)
  const mCreateStage = useMutation({ mutationFn: (b: Record<string, unknown>) => api.post(`${base}/stages`, b), onSuccess: refresh, onError: onErr })
  const mDeleteStage = useMutation({ mutationFn: (id: string) => api.delete(`${base}/stages/${id}`), onSuccess: refresh, onError: onErr })
  const mPatchStage = useMutation({ mutationFn: (v: { id: string; body: Record<string, unknown> }) => api.patch(`${base}/stages/${v.id}`, v.body), onSuccess: refresh, onError: onErr })
  const mCreateEdge = useMutation({ mutationFn: (b: Record<string, unknown>) => api.post(`${base}/edges`, b), onSuccess: refresh, onError: onErr })
  const mDeleteEdge = useMutation({ mutationFn: (id: string) => api.delete(`${base}/edges/${id}`), onSuccess: refresh, onError: onErr })

  const [edgeKind, setEdgeKind] = useState<'FORWARD' | 'SEND_BACK'>('FORWARD')
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])

  // Sync RF state from the server view whenever it changes.
  useEffect(() => {
    if (!data) { setNodes([]); setEdges([]); return }
    const sorted = [...data.stages].sort((a, b) => a.ordinal - b.ordinal)
    setNodes(sorted.map((s, i): Node<StageNodeData> => ({
      id: s.id,
      type: 'stage',
      position: { x: s.positionX ?? 60, y: s.positionY ?? 40 + i * 150 },
      data: { stage: s, onClick: onSelectStage },
    })))
    setEdges(data.edges.map((e): RFEdge => ({
      id: e.id,
      source: e.fromStageId,
      target: e.toStageId,
      label: e.kind === 'SEND_BACK' ? 'send-back' : (e.label ?? undefined),
      animated: e.kind === 'SEND_BACK',
      style: e.kind === 'SEND_BACK' ? { stroke: '#f59e0b', strokeDasharray: '5 4' } : { stroke: '#94a3b8', strokeWidth: 2 },
      labelStyle: { fontSize: 10, fill: e.kind === 'SEND_BACK' ? '#92400e' : '#475569' },
      markerEnd: { type: MarkerType.ArrowClosed, color: e.kind === 'SEND_BACK' ? '#f59e0b' : '#64748b' },
    })))
  }, [data, onSelectStage, setNodes, setEdges])

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return
    if (c.source === c.target) { window.alert('A stage cannot connect to itself.'); return }
    mCreateEdge.mutate({ fromStageId: c.source, toStageId: c.target, kind: edgeKind })
  }, [edgeKind, mCreateEdge])

  const onNodeDragStop = useCallback((_e: unknown, node: Node) => {
    mPatchStage.mutate({ id: node.id, body: { positionX: Math.round(node.position.x), positionY: Math.round(node.position.y) } })
  }, [mPatchStage])

  const onNodesDelete = useCallback((deleted: Node[]) => { deleted.forEach(n => mDeleteStage.mutate(n.id)) }, [mDeleteStage])
  const onEdgesDelete = useCallback((deleted: RFEdge[]) => { deleted.forEach(e => mDeleteEdge.mutate(e.id)) }, [mDeleteEdge])

  const onAddStage = useCallback(() => {
    const label = window.prompt('New stage label', 'New Stage')
    if (!label || !label.trim()) return
    let key = label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 70)
    if (!/^[A-Z]/.test(key)) key = `S_${key}` || `STAGE_${(data?.stages.length ?? 0) + 1}`
    mCreateStage.mutate({
      stageKey: key, label: label.trim(), agentRole: 'DEVELOPER',
      contextPolicy: 'REPO_READ_ONLY', toolPolicy: 'READ_ONLY',
      positionX: 60, positionY: 40 + (data?.stages.length ?? 0) * 150,
    })
  }, [data?.stages.length, mCreateStage])

  const busy = mCreateStage.isPending || mDeleteStage.isPending || mCreateEdge.isPending || mDeleteEdge.isPending || mPatchStage.isPending
  const counts = useMemo(() => ({
    stages: data?.stages.length ?? 0,
    fwd: data?.edges.filter(e => e.kind === 'FORWARD').length ?? 0,
    sb: data?.edges.filter(e => e.kind === 'SEND_BACK').length ?? 0,
  }), [data])

  return (
    <div style={{ border: '1px solid #dbe4f0', borderRadius: 10, background: '#fff', marginBottom: 14, overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13, color: '#0f172a' }}>Stage graph</strong>
        <span style={{ fontSize: 11, color: '#64748b' }}>{counts.stages} stages · {counts.fwd} forward · {counts.sb} send-back{busy ? ' · saving…' : ''}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: '#64748b' }}>Connect as:</span>
        <div style={{ display: 'inline-flex', border: '1px solid #cbd5e1', borderRadius: 8, overflow: 'hidden' }}>
          {(['FORWARD', 'SEND_BACK'] as const).map(k => (
            <button key={k} type="button" onClick={() => setEdgeKind(k)}
              style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', border: 'none', cursor: 'pointer',
                background: edgeKind === k ? (k === 'SEND_BACK' ? '#f59e0b' : '#0ea5e9') : '#fff',
                color: edgeKind === k ? '#fff' : '#334155' }}>
              {k === 'FORWARD' ? 'Forward' : 'Send-back'}
            </button>
          ))}
        </div>
        <button type="button" onClick={onAddStage}
          style={{ fontSize: 12, fontWeight: 800, padding: '5px 12px', border: '1px solid #0ea5e9', borderRadius: 8, background: '#0ea5e9', color: '#fff', cursor: 'pointer' }}>
          ＋ Stage
        </button>
      </div>

      <div style={{ height: 420, background: '#f8fafc' }}>
        {isLoading ? (
          <div style={{ padding: 20, fontSize: 12, color: '#888', fontStyle: 'italic' }}>Loading stage graph…</div>
        ) : error ? (
          <div style={{ padding: 20, fontSize: 12, color: '#c33' }}>Failed to load: {(error as Error).message}</div>
        ) : counts.stages === 0 ? (
          <div style={{ padding: 28, textAlign: 'center', color: '#555' }}>
            <strong style={{ fontSize: 14 }}>No stages yet.</strong>
            <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>Click <b>＋ Stage</b> to add the first agentic stage, then drag from a stage's bottom handle to another's top to connect them.</div>
          </div>
        ) : (
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect} onNodeDragStop={onNodeDragStop}
            onNodesDelete={onNodesDelete} onEdgesDelete={onEdgesDelete}
            fitView proOptions={{ hideAttribution: true }} deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background color="#e2e8f0" gap={18} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
      <div style={{ fontSize: 10, color: '#64748b', padding: '6px 12px', borderTop: '1px solid #eef2f7' }}>
        Drag bottom→top handles to connect (toggle Forward/Send-back above). Select a node/edge + Delete to remove. Drag to reposition (saved). Per-stage config editing arrives next.
      </div>
    </div>
  )
}

export function WorkbenchStageCanvas(props: { nodeId: string; onSelectStage?: (k: string) => void }): React.ReactElement {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}
