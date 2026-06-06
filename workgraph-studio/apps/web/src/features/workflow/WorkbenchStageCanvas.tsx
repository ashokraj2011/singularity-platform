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
 * approval), and prompt profile → PATCH /stages. Artifacts/questions land in P3;
 * the legacy accordion stays available (collapsed) until P3 subsumes it.
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
  expectedArtifacts: Array<{ id: string; kind: string; title: string }>
}
type EdgeView = { id: string; fromStageId: string; toStageId: string; kind: 'FORWARD' | 'SEND_BACK'; label: string | null }
type DefinitionView = { id: string; name: string; capabilityId: string | null; stages: StageView[]; edges: EdgeView[] }

const CONTEXT_POLICIES = ['NONE', 'STORY_ONLY', 'REPO_READ_ONLY', 'CODE_EDIT', 'VERIFY_ONLY', 'EVIDENCE_REVIEW'] as const
const TOOL_POLICIES = ['NONE', 'READ_ONLY', 'MUTATION', 'VERIFICATION'] as const

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
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null)
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
  const onNodeClick = useCallback((_e: unknown, node: Node) => setSelectedStageId(node.id), [])

  // Drop the selection if its stage was deleted/renamed out from under us.
  useEffect(() => {
    if (selectedStageId && data && !data.stages.some(s => s.id === selectedStageId)) setSelectedStageId(null)
  }, [data, selectedStageId])
  const selectedStage = useMemo(() => data?.stages.find(s => s.id === selectedStageId) ?? null, [data, selectedStageId])

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
          onSave={body => mPatchStage.mutate({ id: selectedStage.id, body })}
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

function StageInspector({ stage, agents, busy, onSave, onClose }: {
  stage: StageView; agents: RegistryAgent[]; busy: boolean
  onSave: (body: Record<string, unknown>) => void; onClose: () => void
}) {
  const [draft, setDraft] = useState<StageDraft>(() => draftFromStage(stage))
  useEffect(() => { setDraft(draftFromStage(stage)) }, [stage])
  const set = <K extends keyof StageDraft>(k: K, v: StageDraft[K]) => setDraft(d => ({ ...d, [k]: v }))
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromStage(stage))

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
    <div style={{ borderTop: '1px solid #e5e7eb', background: '#f8fafc', padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <strong style={{ fontSize: 13, color: '#0f172a' }}>Edit stage · <span style={{ fontFamily: 'ui-monospace, monospace', color: '#475569' }}>{stage.stageKey}</span></strong>
        <button type="button" onClick={onClose} style={{ fontSize: 11, border: 'none', background: 'none', cursor: 'pointer', color: '#64748b', fontWeight: 700 }}>✕ close</button>
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
