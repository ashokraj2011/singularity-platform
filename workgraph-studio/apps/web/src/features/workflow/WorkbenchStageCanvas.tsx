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
 * P1: add / delete stage, connect / delete edge (FORWARD|SEND_BACK),
 * drag-to-reposition (persisted).
 * P2: click a stage → inline inspector to edit identity (label/key/role/agent
 * template), policies (context/tool), flags (repoAccess/required/terminal/
 * approval), and prompt profile → PATCH /stages.
 * P3: per-stage expected-artifacts editor in the inspector (add/edit/delete →
 * POST/PATCH/DELETE artifacts). Questions + definition-level fields (goal,
 * source, agent bindings) still live in the legacy accordion until a follow-up.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactFlow, {
  Background, Controls, Handle, Position, MarkerType,
  ReactFlowProvider, useNodesState, useEdgesState,
  type Connection, type Node, type Edge as RFEdge, type NodeProps,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { api } from '../../lib/api'
import { fetchAgents, type RegistryAgent } from '../../lib/registry'

type StageView = {
  id: string
  stageKey: string
  label: string
  agentRole: string
  agentTemplateId: string | null
  promptProfileKey: string | null
  ordinal: number
  positionX: number | null
  positionY: number | null
  required: boolean
  terminal: boolean
  approvalRequired: boolean
  repoAccess: boolean
  toolPolicy: string
  contextPolicy: string
  expectedArtifacts: ArtifactView[]
  questions: QuestionView[]
}
type ArtifactView = { id: string; kind: string; title: string; description: string | null; format: string; required: boolean }
type QuestionView = { id: string; questionId: string; text: string; required: boolean; freeform: boolean }
type EdgeView = { id: string; fromStageId: string; toStageId: string; kind: 'FORWARD' | 'SEND_BACK'; label: string | null }
type DefinitionView = {
  id: string; name: string; capabilityId: string | null
  goal: string | null; sourceType: string | null; sourceUri: string | null; sourceRef: string | null
  architectAgentTemplateId: string | null; developerAgentTemplateId: string | null; qaAgentTemplateId: string | null
  maxLoopsPerStage: number; maxTotalSendBacks: number; gateMode: string; finalPackKey: string | null
  stages: StageView[]; edges: EdgeView[]
}

const CONTEXT_POLICIES = ['NONE', 'STORY_ONLY', 'REPO_READ_ONLY', 'CODE_EDIT', 'VERIFY_ONLY', 'EVIDENCE_REVIEW'] as const
const TOOL_POLICIES = ['NONE', 'READ_ONLY', 'MUTATION', 'VERIFICATION'] as const
const ARTIFACT_FORMATS = ['MARKDOWN', 'TEXT', 'JSON', 'CODE'] as const

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
// A stage reads as a human-approval gate when it does no tool work and exists to
// gate on a human (the shape ＋ Human approval creates, plus equivalent loops).
function isApprovalNode(s: StageView): boolean {
  return s.approvalRequired && s.toolPolicy === 'NONE'
    && (s.contextPolicy === 'EVIDENCE_REVIEW' || /REVIEW|APPROV|SIGN.?OFF/i.test(s.agentRole))
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

// Human-approval gate — rendered as a distinct diamond so reviewers stand out
// from the rectangular agent stages.
function ApprovalNode({ data }: NodeProps<StageNodeData>) {
  const s = data.stage
  return (
    <div onClick={() => data.onClick?.(s.stageKey)} style={{ width: 176, height: 108, position: 'relative', cursor: 'pointer' }}>
      <Handle type="target" position={Position.Top} style={{ background: '#7c3aed' }} />
      <div style={{ position: 'absolute', inset: 0, background: s.terminal ? '#ecfdf5' : '#f5f3ff', border: `1.5px solid ${s.terminal ? '#16a34a' : '#7c3aed'}`, clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)', boxShadow: '0 1px 3px rgba(15,23,42,0.10)' }} />
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '0 38px' }}>
        <span style={{ fontSize: 9, fontWeight: 800, color: '#7c3aed', letterSpacing: '0.04em' }}>✓ APPROVAL</span>
        <span style={{ fontSize: 11, fontWeight: 800, color: '#0f172a', lineHeight: 1.12, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const }}>{s.label}</span>
        <span style={{ fontSize: 8.5, color: '#7c3aed', fontFamily: 'ui-monospace, monospace' }}>{s.agentRole}</span>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#7c3aed' }} />
    </div>
  )
}
const nodeTypes = { stage: StageNode, approval: ApprovalNode }

// ─── Canvas ──────────────────────────────────────────────────────────────────
function Canvas({ nodeId, onSelectStage, fullSize }: { nodeId: string; onSelectStage?: (k: string) => void; fullSize?: boolean }) {
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
  const mCreateArtifact = useMutation({ mutationFn: (v: { stageId: string; body: Record<string, unknown> }) => api.post(`${base}/stages/${v.stageId}/artifacts`, v.body), onSuccess: refresh, onError: onErr })
  const mPatchArtifact = useMutation({ mutationFn: (v: { id: string; body: Record<string, unknown> }) => api.patch(`${base}/artifacts/${v.id}`, v.body), onSuccess: refresh, onError: onErr })
  const mDeleteArtifact = useMutation({ mutationFn: (id: string) => api.delete(`${base}/artifacts/${id}`), onSuccess: refresh, onError: onErr })
  const mCreateQuestion = useMutation({ mutationFn: (v: { stageId: string; body: Record<string, unknown> }) => api.post(`${base}/stages/${v.stageId}/questions`, v.body), onSuccess: refresh, onError: onErr })
  const mPatchQuestion = useMutation({ mutationFn: (v: { id: string; body: Record<string, unknown> }) => api.patch(`${base}/questions/${v.id}`, v.body), onSuccess: refresh, onError: onErr })
  const mDeleteQuestion = useMutation({ mutationFn: (id: string) => api.delete(`${base}/questions/${id}`), onSuccess: refresh, onError: onErr })
  const mPatchDef = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(base, body), onSuccess: refresh, onError: onErr })
  const mReorder = useMutation({ mutationFn: (stageIds: string[]) => api.post(`${base}/stages/reorder`, { stageIds }), onSuccess: refresh, onError: onErr })

  const [edgeKind, setEdgeKind] = useState<'FORWARD' | 'SEND_BACK'>('FORWARD')
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null)
  const [headerOpen, setHeaderOpen] = useState(false)
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])

  // P2 — agents for the stage inspector's agent-template picker (capability-scoped).
  const { data: agents } = useQuery<RegistryAgent[]>({
    queryKey: ['workbench-agents', data?.capabilityId ?? null],
    queryFn: () => fetchAgents(data?.capabilityId ?? undefined),
    enabled: !!data,
    staleTime: 60_000,
  })

  // Sync RF state from the server view whenever it changes.
  useEffect(() => {
    if (!data) { setNodes([]); setEdges([]); return }
    const sorted = [...data.stages].sort((a, b) => a.ordinal - b.ordinal)
    setNodes(sorted.map((s, i): Node<StageNodeData> => ({
      id: s.id,
      type: isApprovalNode(s) ? 'approval' : 'stage',
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
  const onNodeClick = useCallback((_e: unknown, node: Node) => setSelectedStageId(node.id), [])

  // Drop the selection if its stage was deleted/renamed out from under us.
  useEffect(() => {
    if (selectedStageId && data && !data.stages.some(s => s.id === selectedStageId)) setSelectedStageId(null)
  }, [data, selectedStageId])
  const selectedStage = useMemo(() => data?.stages.find(s => s.id === selectedStageId) ?? null, [data, selectedStageId])

  // Add a stage with sensible defaults (no native prompt) and immediately open
  // the inspector on it so the operator renames/configures inline.
  const onAddStage = useCallback(async (kind: 'AGENT' | 'APPROVAL') => {
    const existing = new Set((data?.stages ?? []).map(s => s.stageKey))
    let i = (data?.stages.length ?? 0) + 1
    const prefix = kind === 'APPROVAL' ? 'APPROVAL' : 'STAGE'
    let key = `${prefix}_${i}`
    while (existing.has(key)) { i++; key = `${prefix}_${i}` }
    try {
      const res = await mCreateStage.mutateAsync({
        stageKey: key,
        label: kind === 'APPROVAL' ? 'Human Approval' : 'New Stage',
        agentRole: kind === 'APPROVAL' ? 'REVIEWER' : 'DEVELOPER',
        contextPolicy: kind === 'APPROVAL' ? 'EVIDENCE_REVIEW' : 'REPO_READ_ONLY',
        toolPolicy: kind === 'APPROVAL' ? 'NONE' : 'READ_ONLY',
        approvalRequired: kind === 'APPROVAL',
        positionX: 60, positionY: 40 + (data?.stages.length ?? 0) * 150,
      })
      const created = (res as { data?: { data?: DefinitionView } })?.data?.data?.stages.find(s => s.stageKey === key)
      if (created) setSelectedStageId(created.id)
    } catch { /* onErr handles */ }
  }, [data?.stages, mCreateStage])

  // Reorder ordinal (the default forward chain + runtime order) to match the
  // visual top-to-bottom layout. Explicit (button) so horizontal drags don't reorder.
  const onSortByLayout = useCallback(() => {
    if (!data || data.stages.length < 2) return
    const ids = [...data.stages]
      .sort((a, b) => (a.positionY ?? 0) - (b.positionY ?? 0) || (a.positionX ?? 0) - (b.positionX ?? 0))
      .map(s => s.id)
    mReorder.mutate(ids)
  }, [data, mReorder])

  const busy = mCreateStage.isPending || mDeleteStage.isPending || mCreateEdge.isPending || mDeleteEdge.isPending || mPatchStage.isPending || mReorder.isPending
  const counts = useMemo(() => ({
    stages: data?.stages.length ?? 0,
    fwd: data?.edges.filter(e => e.kind === 'FORWARD').length ?? 0,
    sb: data?.edges.filter(e => e.kind === 'SEND_BACK').length ?? 0,
  }), [data])

  // Non-blocking graph health checks surfaced as warnings.
  const warnings = useMemo(() => {
    if (!data || data.stages.length === 0) return [] as string[]
    const w: string[] = []
    const fwd = data.edges.filter(e => e.kind === 'FORWARD')
    const incoming = new Set(fwd.map(e => e.toStageId))
    const outgoing = new Set(fwd.map(e => e.fromStageId))
    const terminals = data.stages.filter(s => s.terminal)
    if (terminals.length === 0) w.push('No terminal stage — mark the final stage as Terminal.')
    if (terminals.length > 1) w.push(`${terminals.length} terminal stages — only one should be terminal.`)
    const firstId = [...data.stages].sort((a, b) => a.ordinal - b.ordinal)[0]?.id
    data.stages.forEach(s => { if (s.id !== firstId && !incoming.has(s.id)) w.push(`"${s.label}" has no incoming connection (unreachable).`) })
    data.stages.forEach(s => { if (!s.terminal && !outgoing.has(s.id)) w.push(`"${s.label}" has no forward connection.`) })
    return w
  }, [data])

  return (
    <div style={{ border: '1px solid #dbe4f0', borderRadius: 10, background: '#fff', marginBottom: fullSize ? 0 : 14, overflow: 'hidden', height: fullSize ? '100%' : undefined, display: fullSize ? 'flex' : undefined, flexDirection: fullSize ? 'column' : undefined }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13, color: '#0f172a' }} title="The loop this Workbench Task node owns">{data?.name || 'Stage graph'}</strong>
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
        <button type="button" onClick={() => onAddStage('AGENT')}
          style={{ fontSize: 12, fontWeight: 800, padding: '5px 12px', border: '1px solid #0ea5e9', borderRadius: 8, background: '#0ea5e9', color: '#fff', cursor: 'pointer' }}>
          ＋ Agent stage
        </button>
        <button type="button" onClick={() => onAddStage('APPROVAL')}
          style={{ fontSize: 12, fontWeight: 800, padding: '5px 12px', border: '1px solid #7c3aed', borderRadius: 8, background: '#fff', color: '#7c3aed', cursor: 'pointer' }}>
          ＋ Human approval
        </button>
        {counts.stages > 1 && (
          <button type="button" onClick={onSortByLayout} disabled={busy} title="Renumber stage order to match top-to-bottom layout"
            style={{ fontSize: 12, fontWeight: 800, padding: '5px 12px', border: '1px solid #cbd5e1', borderRadius: 8, background: '#fff', color: '#475569', cursor: busy ? 'default' : 'pointer' }}>
            ↕ Sort by layout
          </button>
        )}
        <button type="button" onClick={() => setHeaderOpen(o => !o)} title="Workflow settings (goal, source, agents, limits)"
          style={{ fontSize: 12, fontWeight: 800, padding: '5px 12px', border: '1px solid #cbd5e1', borderRadius: 8, background: headerOpen ? '#eef2ff' : '#fff', color: '#475569', cursor: 'pointer' }}>
          ⚙ Settings
        </button>
      </div>
      {headerOpen && data && (
        <DefinitionHeader def={data} agents={agents ?? []} busy={mPatchDef.isPending} onSave={body => mPatchDef.mutate(body)} />
      )}
      {warnings.length > 0 && (
        <div style={{ background: '#fffbeb', borderBottom: '1px solid #fde68a', padding: '7px 12px' }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: '#92400e' }}>⚠ {warnings.length} warning{warnings.length === 1 ? '' : 's'}</span>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {warnings.slice(0, 6).map((w, i) => <li key={i} style={{ fontSize: 11, color: '#92400e', lineHeight: 1.5 }}>{w}</li>)}
          </ul>
        </div>
      )}

      <div style={{ height: fullSize ? undefined : 420, flex: fullSize ? 1 : undefined, minHeight: fullSize ? 420 : undefined, background: '#f8fafc' }}>
        {isLoading ? (
          <div style={{ padding: 20, fontSize: 12, color: '#888', fontStyle: 'italic' }}>Loading stage graph…</div>
        ) : error ? (
          <div style={{ padding: 20, fontSize: 12, color: '#c33' }}>Failed to load: {(error as Error).message}</div>
        ) : counts.stages === 0 ? (
          <div style={{ padding: 28, textAlign: 'center', color: '#555' }}>
            <strong style={{ fontSize: 14 }}>No stages yet.</strong>
            <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>Add an <b>Agent stage</b> or a <b>Human approval</b>, then drag from a stage's bottom handle to another's top to connect them into a flow.</div>
          </div>
        ) : (
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect} onNodeDragStop={onNodeDragStop}
            onNodesDelete={onNodesDelete} onEdgesDelete={onEdgesDelete}
            onNodeClick={onNodeClick} onPaneClick={() => setSelectedStageId(null)}
            fitView proOptions={{ hideAttribution: true }} deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background color="#e2e8f0" gap={18} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
      <div style={{ fontSize: 10, color: '#64748b', padding: '6px 12px', borderTop: '1px solid #eef2f7' }}>
        Click a stage to edit it. Drag bottom→top handles to connect (toggle Forward/Send-back above). Select a node/edge + Delete to remove. Drag to reposition (saved).
      </div>
      {selectedStage && (
        <StageInspector
          key={selectedStage.id}
          stage={selectedStage}
          agents={agents ?? []}
          busy={mPatchStage.isPending}
          artifactBusy={mCreateArtifact.isPending || mPatchArtifact.isPending || mDeleteArtifact.isPending}
          questionBusy={mCreateQuestion.isPending || mPatchQuestion.isPending || mDeleteQuestion.isPending}
          onSave={body => mPatchStage.mutate({ id: selectedStage.id, body })}
          onArtifactAdd={(stageId, body) => mCreateArtifact.mutate({ stageId, body })}
          onArtifactPatch={(id, body) => mPatchArtifact.mutate({ id, body })}
          onArtifactDelete={id => mDeleteArtifact.mutate(id)}
          onQuestionAdd={(stageId, body) => mCreateQuestion.mutate({ stageId, body })}
          onQuestionPatch={(id, body) => mPatchQuestion.mutate({ id, body })}
          onQuestionDelete={id => mDeleteQuestion.mutate(id)}
          onClose={() => setSelectedStageId(null)}
        />
      )}
    </div>
  )
}

// ─── Stage inspector (P2) ────────────────────────────────────────────────────
type StageDraft = {
  label: string; stageKey: string; agentRole: string; agentTemplateId: string
  promptProfileKey: string; contextPolicy: string; toolPolicy: string
  repoAccess: boolean; required: boolean; terminal: boolean; approvalRequired: boolean
}
function draftFromStage(s: StageView): StageDraft {
  return {
    label: s.label, stageKey: s.stageKey, agentRole: s.agentRole,
    agentTemplateId: s.agentTemplateId ?? '', promptProfileKey: s.promptProfileKey ?? '',
    contextPolicy: s.contextPolicy, toolPolicy: s.toolPolicy,
    repoAccess: s.repoAccess, required: s.required, terminal: s.terminal, approvalRequired: s.approvalRequired,
  }
}
const fieldLabel: React.CSSProperties = { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#64748b', display: 'block', marginBottom: 3 }
const fieldInput: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 7, border: '1px solid #cbd5e1', fontSize: 12 }

function StageInspector({ stage, agents, busy, artifactBusy, questionBusy, onSave, onArtifactAdd, onArtifactPatch, onArtifactDelete, onQuestionAdd, onQuestionPatch, onQuestionDelete, onClose }: {
  stage: StageView; agents: RegistryAgent[]; busy: boolean; artifactBusy: boolean; questionBusy: boolean
  onSave: (body: Record<string, unknown>) => void
  onArtifactAdd: (stageId: string, body: Record<string, unknown>) => void
  onArtifactPatch: (id: string, body: Record<string, unknown>) => void
  onArtifactDelete: (id: string) => void
  onQuestionAdd: (stageId: string, body: Record<string, unknown>) => void
  onQuestionPatch: (id: string, body: Record<string, unknown>) => void
  onQuestionDelete: (id: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<StageDraft>(() => draftFromStage(stage))
  useEffect(() => { setDraft(draftFromStage(stage)) }, [stage])
  const set = <K extends keyof StageDraft>(k: K, v: StageDraft[K]) => setDraft(d => ({ ...d, [k]: v }))
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromStage(stage))

  // Draggable + resizable floating panel. Rendered `position: fixed` so it
  // escapes the canvas container's `overflow: hidden` (which was clipping the
  // lower fields with no scrollbar); `overflow: auto` gives it its own scrollbar
  // and `resize: both` a corner grip. Default anchor = bottom-right until the
  // user drags it, after which we honor the explicit left/top.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const startDrag = (e: React.PointerEvent) => {
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    const offX = e.clientX - rect.left
    const offY = e.clientY - rect.top
    const onMove = (ev: PointerEvent) => {
      const maxX = window.innerWidth - 80
      const maxY = window.innerHeight - 40
      setPos({
        x: Math.min(Math.max(0, ev.clientX - offX), maxX),
        y: Math.min(Math.max(0, ev.clientY - offY), maxY),
      })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Keep the current template id selectable even if it's not in the fetched list.
  const agentOptions = useMemo(() => {
    const opts = agents.map(a => ({ id: a.id, name: a.name }))
    if (draft.agentTemplateId && !opts.some(o => o.id === draft.agentTemplateId)) opts.unshift({ id: draft.agentTemplateId, name: `(current) ${draft.agentTemplateId.slice(0, 8)}…` })
    return opts
  }, [agents, draft.agentTemplateId])

  const save = () => onSave({
    label: draft.label.trim(),
    stageKey: draft.stageKey.trim(),
    agentRole: draft.agentRole.trim(),
    agentTemplateId: draft.agentTemplateId || null,
    promptProfileKey: draft.promptProfileKey.trim() || null,
    contextPolicy: draft.contextPolicy,
    toolPolicy: draft.toolPolicy,
    repoAccess: draft.repoAccess, required: draft.required, terminal: draft.terminal, approvalRequired: draft.approvalRequired,
  })

  return (
    <div
      ref={panelRef}
      style={{
        position: 'fixed',
        ...(pos ? { left: pos.x, top: pos.y } : { left: 16, bottom: 16 }),
        width: 'min(760px, 92vw)',
        maxHeight: '82vh',
        overflow: 'auto',
        resize: 'both',
        zIndex: 50,
        border: '1px solid #e5e7eb',
        background: '#f8fafc',
        padding: '12px 14px',
        borderRadius: 12,
        boxShadow: '0 12px 32px rgba(15,23,42,0.22)',
      }}
    >
      <div
        onPointerDown={startDrag}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          cursor: 'move', userSelect: 'none',
          position: 'sticky', top: 0, zIndex: 2, background: '#f8fafc',
          margin: '-12px -14px 10px', padding: '12px 14px 8px',
          borderBottom: '1px solid #eef2f7',
        }}
      >
        <strong style={{ fontSize: 13, color: '#0f172a' }}>⠿ Edit stage · <span style={{ fontFamily: 'ui-monospace, monospace', color: '#475569' }}>{stage.stageKey}</span></strong>
        <button type="button" onClick={onClose} onPointerDown={e => e.stopPropagation()} style={{ fontSize: 11, border: 'none', background: 'none', cursor: 'pointer', color: '#64748b', fontWeight: 700 }}>✕ close</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div><label style={fieldLabel}>Label</label><input style={fieldInput} value={draft.label} onChange={e => set('label', e.target.value)} /></div>
        <div><label style={fieldLabel}>Stage key</label><input style={{ ...fieldInput, fontFamily: 'ui-monospace, monospace' }} value={draft.stageKey} onChange={e => set('stageKey', e.target.value.toUpperCase())} /></div>
        <div><label style={fieldLabel}>Agent role</label><input style={fieldInput} value={draft.agentRole} onChange={e => set('agentRole', e.target.value)} /></div>
        <div>
          <label style={fieldLabel}>Agent template</label>
          <select style={fieldInput} value={draft.agentTemplateId} onChange={e => set('agentTemplateId', e.target.value)}>
            <option value="">— none (use role binding) —</option>
            {agentOptions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label style={fieldLabel}>Context policy</label>
          <select style={fieldInput} value={draft.contextPolicy} onChange={e => set('contextPolicy', e.target.value)}>
            {CONTEXT_POLICIES.map(p => <option key={p} value={p}>{p.replaceAll('_', ' ').toLowerCase()}</option>)}
          </select>
        </div>
        <div>
          <label style={fieldLabel}>Tool policy</label>
          <select style={fieldInput} value={draft.toolPolicy} onChange={e => set('toolPolicy', e.target.value)}>
            {TOOL_POLICIES.map(p => <option key={p} value={p}>{p.replaceAll('_', ' ').toLowerCase()}</option>)}
          </select>
        </div>
        <div style={{ gridColumn: '1 / span 2' }}><label style={fieldLabel}>Prompt profile key</label><input style={fieldInput} value={draft.promptProfileKey} onChange={e => set('promptProfileKey', e.target.value)} placeholder="(optional)" /></div>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10 }}>
        {([['repoAccess', 'Repo access'], ['required', 'Required'], ['terminal', 'Terminal'], ['approvalRequired', 'Approval required']] as const).map(([k, lbl]) => (
          <label key={k} style={{ fontSize: 12, color: '#334155', display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={draft[k]} onChange={e => set(k, e.target.checked)} /> {lbl}
          </label>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        <button type="button" onClick={save} disabled={!dirty || busy}
          style={{ fontSize: 12, fontWeight: 800, padding: '6px 14px', borderRadius: 8, border: '1px solid #0ea5e9', cursor: !dirty || busy ? 'default' : 'pointer', background: !dirty || busy ? '#cbd5e1' : '#0ea5e9', color: '#fff' }}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        {dirty && <span style={{ fontSize: 11, color: '#b45309' }}>unsaved changes</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: '#94a3b8' }}>Changing the stage key rewires its edges by key.</span>
      </div>

      {/* Expected artifacts (P3) */}
      <div style={{ marginTop: 16, borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={fieldLabel}>Expected artifacts ({stage.expectedArtifacts.length})</span>
          <button type="button" disabled={artifactBusy}
            onClick={() => onArtifactAdd(stage.id, { kind: uniqueArtifactKind(stage), title: 'New artifact', format: 'MARKDOWN', required: true })}
            style={{ fontSize: 11, fontWeight: 800, padding: '4px 10px', borderRadius: 7, border: '1px solid #0ea5e9', background: '#fff', color: '#0ea5e9', cursor: artifactBusy ? 'default' : 'pointer' }}>
            ＋ Artifact
          </button>
        </div>
        {stage.expectedArtifacts.length === 0 ? (
          <p style={{ fontSize: 11, color: '#94a3b8', margin: '2px 0 0' }}>No artifacts yet — this stage emits no expected output.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {stage.expectedArtifacts.map(a => (
              <ArtifactRow key={a.id} artifact={a} busy={artifactBusy}
                onPatch={body => onArtifactPatch(a.id, body)} onDelete={() => onArtifactDelete(a.id)} />
            ))}
          </div>
        )}
      </div>

      {/* Clarifying questions (P3.5) */}
      <div style={{ marginTop: 14, borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={fieldLabel}>Clarifying questions ({stage.questions.length})</span>
          <button type="button" disabled={questionBusy}
            onClick={() => onQuestionAdd(stage.id, { questionId: uniqueQuestionId(stage), text: 'New question?', required: false, freeform: true })}
            style={{ fontSize: 11, fontWeight: 800, padding: '4px 10px', borderRadius: 7, border: '1px solid #7c3aed', background: '#fff', color: '#7c3aed', cursor: questionBusy ? 'default' : 'pointer' }}>
            ＋ Question
          </button>
        </div>
        {stage.questions.length === 0 ? (
          <p style={{ fontSize: 11, color: '#94a3b8', margin: '2px 0 0' }}>No questions — the agent won't be prompted for clarifications at this stage.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {stage.questions.map(q => (
              <QuestionRow key={q.id} question={q} busy={questionBusy}
                onPatch={body => onQuestionPatch(q.id, body)} onDelete={() => onQuestionDelete(q.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function uniqueArtifactKind(stage: StageView): string {
  const existing = new Set(stage.expectedArtifacts.map(a => a.kind))
  let i = stage.expectedArtifacts.length + 1
  let k = `artifact_${i}`
  while (existing.has(k)) { i++; k = `artifact_${i}` }
  return k
}

function ArtifactRow({ artifact, busy, onPatch, onDelete }: {
  artifact: ArtifactView; busy: boolean
  onPatch: (body: Record<string, unknown>) => void; onDelete: () => void
}) {
  const [title, setTitle] = useState(artifact.title)
  const [kind, setKind] = useState(artifact.kind)
  useEffect(() => { setTitle(artifact.title); setKind(artifact.kind) }, [artifact.title, artifact.kind])
  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px', background: '#fff' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input value={title} onChange={e => setTitle(e.target.value)} onBlur={() => { if (title.trim() && title !== artifact.title) onPatch({ title: title.trim() }) }}
          placeholder="Title" style={{ ...fieldInput, flex: 2 }} />
        <input value={kind} onChange={e => setKind(e.target.value.toLowerCase().replace(/[^a-z0-9_]+/g, '_'))} onBlur={() => { if (kind && kind !== artifact.kind) onPatch({ kind }) }}
          placeholder="kind_key" style={{ ...fieldInput, flex: 1, fontFamily: 'ui-monospace, monospace' }} />
        <button type="button" onClick={onDelete} disabled={busy} title="Delete artifact"
          style={{ border: 'none', background: 'none', color: '#ef4444', cursor: busy ? 'default' : 'pointer', fontSize: 16, fontWeight: 800, lineHeight: 1, padding: '0 4px' }}>×</button>
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 6 }}>
        <select value={artifact.format} onChange={e => onPatch({ format: e.target.value })} style={{ ...fieldInput, width: 'auto', fontSize: 11, padding: '3px 6px' }}>
          {ARTIFACT_FORMATS.map(f => <option key={f} value={f}>{f.toLowerCase()}</option>)}
        </select>
        <label style={{ fontSize: 11, color: '#334155', display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={artifact.required} onChange={e => onPatch({ required: e.target.checked })} /> required
        </label>
      </div>
    </div>
  )
}

function uniqueQuestionId(stage: StageView): string {
  const existing = new Set(stage.questions.map(q => q.questionId))
  let i = stage.questions.length + 1
  let k = `q_${i}`
  while (existing.has(k)) { i++; k = `q_${i}` }
  return k
}

function QuestionRow({ question, busy, onPatch, onDelete }: {
  question: QuestionView; busy: boolean
  onPatch: (body: Record<string, unknown>) => void; onDelete: () => void
}) {
  const [text, setText] = useState(question.text)
  useEffect(() => { setText(question.text) }, [question.text])
  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px', background: '#fff' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input value={text} onChange={e => setText(e.target.value)} onBlur={() => { if (text.trim() && text !== question.text) onPatch({ text: text.trim() }) }}
          placeholder="Question text" style={{ ...fieldInput, flex: 1 }} />
        <button type="button" onClick={onDelete} disabled={busy} title="Delete question"
          style={{ border: 'none', background: 'none', color: '#ef4444', cursor: busy ? 'default' : 'pointer', fontSize: 16, fontWeight: 800, lineHeight: 1, padding: '0 4px' }}>×</button>
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 6 }}>
        <label style={{ fontSize: 11, color: '#334155', display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={question.required} onChange={e => onPatch({ required: e.target.checked })} /> required
        </label>
        <label style={{ fontSize: 11, color: '#334155', display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={question.freeform} onChange={e => onPatch({ freeform: e.target.checked })} /> freeform
        </label>
        <span style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'ui-monospace, monospace' }}>{question.questionId}</span>
      </div>
    </div>
  )
}

// ─── Definition header (workflow-wide settings) ──────────────────────────────
function DefinitionHeader({ def, agents, busy, onSave }: {
  def: DefinitionView; agents: RegistryAgent[]; busy: boolean
  onSave: (body: Record<string, unknown>) => void
}) {
  type DefDraft = {
    name: string; goal: string; sourceType: string; sourceUri: string; sourceRef: string
    architectAgentTemplateId: string; developerAgentTemplateId: string; qaAgentTemplateId: string
    maxLoopsPerStage: number; maxTotalSendBacks: number; gateMode: string; finalPackKey: string
  }
  const fromDef = (d: DefinitionView): DefDraft => ({
    name: d.name, goal: d.goal ?? '', sourceType: d.sourceType ?? 'localdir', sourceUri: d.sourceUri ?? '', sourceRef: d.sourceRef ?? '',
    architectAgentTemplateId: d.architectAgentTemplateId ?? '', developerAgentTemplateId: d.developerAgentTemplateId ?? '', qaAgentTemplateId: d.qaAgentTemplateId ?? '',
    maxLoopsPerStage: d.maxLoopsPerStage, maxTotalSendBacks: d.maxTotalSendBacks, gateMode: d.gateMode, finalPackKey: d.finalPackKey ?? '',
  })
  const [draft, setDraft] = useState<DefDraft>(() => fromDef(def))
  useEffect(() => { setDraft(fromDef(def)) }, [def])
  const set = <K extends keyof DefDraft>(k: K, v: DefDraft[K]) => setDraft(d => ({ ...d, [k]: v }))
  const dirty = JSON.stringify(draft) !== JSON.stringify(fromDef(def))
  const agentOpts = (cur: string) => {
    const opts = agents.map(a => ({ id: a.id, name: a.name }))
    if (cur && !opts.some(o => o.id === cur)) opts.unshift({ id: cur, name: `(current) ${cur.slice(0, 8)}…` })
    return opts
  }
  const save = () => onSave({
    name: draft.name.trim(), goal: draft.goal.trim() || null,
    sourceType: draft.sourceType, sourceUri: draft.sourceUri.trim() || null, sourceRef: draft.sourceRef.trim() || null,
    architectAgentTemplateId: draft.architectAgentTemplateId || null, developerAgentTemplateId: draft.developerAgentTemplateId || null, qaAgentTemplateId: draft.qaAgentTemplateId || null,
    maxLoopsPerStage: draft.maxLoopsPerStage, maxTotalSendBacks: draft.maxTotalSendBacks, gateMode: draft.gateMode, finalPackKey: draft.finalPackKey.trim() || null,
  })
  return (
    <div style={{ borderBottom: '1px solid #e5e7eb', background: '#f8fafc', padding: '12px 14px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={{ gridColumn: '1 / span 2' }}><label style={fieldLabel}>Workflow name</label><input style={fieldInput} value={draft.name} onChange={e => set('name', e.target.value)} /></div>
        <div style={{ gridColumn: '1 / span 2' }}><label style={fieldLabel}>Goal</label><input style={fieldInput} value={draft.goal} onChange={e => set('goal', e.target.value)} placeholder="What this workbench loop should achieve" /></div>
        <div>
          <label style={fieldLabel}>Source type</label>
          <select style={fieldInput} value={draft.sourceType} onChange={e => set('sourceType', e.target.value)}>
            <option value="localdir">localdir</option><option value="github">github</option>
          </select>
        </div>
        <div><label style={fieldLabel}>Source ref</label><input style={fieldInput} value={draft.sourceRef} onChange={e => set('sourceRef', e.target.value)} placeholder="branch / ref" /></div>
        <div style={{ gridColumn: '1 / span 2' }}><label style={fieldLabel}>Source URI</label><input style={fieldInput} value={draft.sourceUri} onChange={e => set('sourceUri', e.target.value)} placeholder="repo URL or path" /></div>
        {([['architectAgentTemplateId', 'Architect agent'], ['developerAgentTemplateId', 'Developer agent'], ['qaAgentTemplateId', 'QA agent']] as const).map(([k, lbl]) => (
          <div key={k}>
            <label style={fieldLabel}>{lbl}</label>
            <select style={fieldInput} value={draft[k]} onChange={e => set(k, e.target.value)}>
              <option value="">— none —</option>
              {agentOpts(draft[k]).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        ))}
        <div>
          <label style={fieldLabel}>Gate mode</label>
          <select style={fieldInput} value={draft.gateMode} onChange={e => set('gateMode', e.target.value)}>
            <option value="manual">manual</option><option value="auto">auto</option>
          </select>
        </div>
        <div><label style={fieldLabel}>Max loops / stage</label><input type="number" min={1} max={20} style={fieldInput} value={draft.maxLoopsPerStage} onChange={e => set('maxLoopsPerStage', Number(e.target.value))} /></div>
        <div><label style={fieldLabel}>Max total send-backs</label><input type="number" min={0} max={50} style={fieldInput} value={draft.maxTotalSendBacks} onChange={e => set('maxTotalSendBacks', Number(e.target.value))} /></div>
        <div><label style={fieldLabel}>Final pack key</label><input style={fieldInput} value={draft.finalPackKey} onChange={e => set('finalPackKey', e.target.value)} placeholder="(optional)" /></div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <button type="button" onClick={save} disabled={!dirty || busy}
          style={{ fontSize: 12, fontWeight: 800, padding: '6px 14px', borderRadius: 8, border: '1px solid #6366f1', cursor: !dirty || busy ? 'default' : 'pointer', background: !dirty || busy ? '#cbd5e1' : '#6366f1', color: '#fff' }}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
        {dirty && <span style={{ fontSize: 11, color: '#b45309' }}>unsaved changes</span>}
      </div>
    </div>
  )
}

export function WorkbenchStageCanvas(props: { nodeId: string; onSelectStage?: (k: string) => void; fullSize?: boolean }): React.ReactElement {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}
