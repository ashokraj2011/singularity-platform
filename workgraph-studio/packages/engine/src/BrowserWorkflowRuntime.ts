// ─────────────────────────────────────────────────────────────────────────────
// BrowserWorkflowRuntime — in-memory state machine that runs a workflow
// definition entirely client-side. No Prisma, no fetch. Subscribers get
// notified after every state mutation so React can re-render.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  WorkflowDefinition,
  RunState,
  RunNodeState,
  RunStatus,
  EngineEdge,
  EngineNodeDef,
  SubTask,
} from './types'
import { resolveNextEdges, previewBranches, type BranchPreview } from './GraphTraverser'
import { evaluateEdge, resolvePath } from './EdgeEvaluator'

type Listener = (state: RunState) => void

const AUTO_ADVANCE_NODE_TYPES = new Set([
  'START',
  'END',
  'SET_CONTEXT',
  'PARALLEL_FORK',
  'PARALLEL_JOIN',
  'INCLUSIVE_GATEWAY',
  'EVENT_GATEWAY',
  'TIMER',          // browser: just auto-advance
  'SIGNAL_EMIT',
  'CALL_WORKFLOW',  // placeholder: marks complete in browser only
])

const SERVER_SIDE_ONLY = new Set([
  'TOOL_REQUEST',
  'AGENT_TASK',
  'CALL_WORKFLOW',
  'SIGNAL_WAIT',
  'POLICY_CHECK',
  'DATA_SINK',
  'CUSTOM',
  'CONSUMABLE_CREATION',  // CONSUMABLE_CREATION still has a form, but we still mark below
])

function nowIso() { return new Date().toISOString() }

function genRunId(): string {
  // RFC4122 v4 via crypto if available
  const c = (globalThis as any).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `run_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

function mergeOutput<T extends Record<string, unknown>>(ctx: T, nodeId: string, output: unknown): T {
  const next: T = { ...ctx }
  if (output && typeof output === 'object') {
    Object.assign(next, output as Record<string, unknown>)
    ;(next as Record<string, unknown>)[nodeId] = output
  } else if (output !== undefined) {
    ;(next as Record<string, unknown>)[nodeId] = output
  }
  return next
}

export class BrowserWorkflowRuntime {
  private state: RunState
  private definition: WorkflowDefinition
  private listeners = new Set<Listener>()

  constructor(state: RunState, definition: WorkflowDefinition) {
    this.state = state
    this.definition = definition
  }

  // ─── Construction helpers ───────────────────────────────────────────────

  static initRunState(opts: {
    definition: WorkflowDefinition
    name: string
    params?: Record<string, unknown>
    globals?: Record<string, unknown>
    createdById?: string
  }): RunState {
    const { definition, name, params = {}, globals = {}, createdById } = opts
    const ts = nowIso()

    // Hydrate _vars from definition.variables[].defaultValue, overlaid with
    // explicit params for INPUT-scope variables.
    const varsFromDef: Record<string, unknown> = {}
    for (const v of definition.variables ?? []) {
      if (v.defaultValue !== undefined) varsFromDef[v.key] = v.defaultValue
    }
    const _vars = { ...varsFromDef, ...params }

    const nodes: Record<string, RunNodeState> = {}
    for (const n of definition.nodes) {
      nodes[n.id] = {
        id: n.id,
        nodeType: n.nodeType,
        status: 'PENDING',
      }
    }
    const edges: Record<string, { id: string; traversed: boolean }> = {}
    for (const e of definition.edges) {
      edges[e.id] = { id: e.id, traversed: false }
    }

    return {
      runId: genRunId(),
      workflowId: definition.workflowId,
      workflowVersionHash: definition.versionHash,
      name,
      status: 'DRAFT',
      context: {
        _globals: { ...(definition.globals ?? {}), ...globals },
        _vars,
        _params: { ...params },
      },
      nodes,
      edges,
      log: [{ ts, kind: 'RunCreated', message: `Run "${name}" created` }],
      startedAt: ts,
      updatedAt: ts,
      version: 1,
      createdById,
    }
  }

  // ─── Subscription ───────────────────────────────────────────────────────

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit() {
    for (const l of this.listeners) l(this.state)
  }

  getState(): RunState { return this.state }

  // ─── Mutation primitive ─────────────────────────────────────────────────

  private mutate(fn: (draft: RunState) => void) {
    const draft: RunState = JSON.parse(JSON.stringify(this.state))
    fn(draft)
    draft.updatedAt = nowIso()
    draft.version += 1
    this.state = draft
    this.emit()
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  start(actorId?: string) {
    if (this.state.status !== 'DRAFT') return
    this.mutate(d => {
      d.status = 'ACTIVE'
      d.log.push({ ts: nowIso(), kind: 'RunStarted', message: actorId ? `Started by ${actorId}` : 'Started' })
      const startNode = this.definition.nodes.find(n => n.nodeType === 'START')
      if (!startNode) {
        d.status = 'FAILED'
        d.log.push({ ts: nowIso(), kind: 'NoStartNode', message: 'No START node in definition' })
        return
      }
      d.nodes[startNode.id].status = 'COMPLETED'
      d.nodes[startNode.id].completedAt = nowIso()
      d.log.push({ ts: nowIso(), kind: 'NodeCompleted', nodeId: startNode.id, message: 'START' })
    })
    // Cascade from the START node
    const startNode = this.definition.nodes.find(n => n.nodeType === 'START')!
    this.cascadeAfter(startNode.id, actorId)
  }

  pause(actorId?: string) {
    if (this.state.status !== 'ACTIVE') return
    this.mutate(d => {
      d.status = 'PAUSED'
      d.log.push({ ts: nowIso(), kind: 'RunPaused', message: actorId ? `Paused by ${actorId}` : 'Paused' })
    })
  }

  resume(actorId?: string) {
    if (this.state.status !== 'PAUSED') return
    this.mutate(d => {
      d.status = 'ACTIVE'
      d.log.push({ ts: nowIso(), kind: 'RunResumed', message: actorId ? `Resumed by ${actorId}` : 'Resumed' })
    })
  }

  cancel(reason: string, actorId?: string) {
    if (this.state.status === 'COMPLETED' || this.state.status === 'CANCELLED') return
    this.mutate(d => {
      d.status = 'CANCELLED'
      for (const id of Object.keys(d.nodes)) {
        if (d.nodes[id].status === 'PENDING' || d.nodes[id].status === 'ACTIVE') {
          d.nodes[id].status = 'SKIPPED'
        }
      }
      d.log.push({ ts: nowIso(), kind: 'RunCancelled', message: `${reason}${actorId ? ` (by ${actorId})` : ''}` })
    })
  }

  // ─── Node interactions ──────────────────────────────────────────────────

  claim(nodeId: string, actor: string) {
    if (!this.state.nodes[nodeId] || this.state.nodes[nodeId].status !== 'ACTIVE') return
    this.mutate(d => {
      d.nodes[nodeId].claimedBy = actor
      d.log.push({ ts: nowIso(), kind: 'NodeClaimed', nodeId, message: `Claimed by ${actor}` })
    })
  }

  /**
   * Delegate (forward) a node to another user.
   * Transfers claimedBy to `toUser` and appends a delegation record.
   */
  delegate(nodeId: string, toUser: string, note?: string, fromUser?: string) {
    if (!this.state.nodes[nodeId] || this.state.nodes[nodeId].status !== 'ACTIVE') return
    const from = fromUser ?? this.state.nodes[nodeId].claimedBy ?? 'unknown'
    this.mutate(d => {
      const n = d.nodes[nodeId]
      if (!n.delegations) n.delegations = []
      n.delegations.push({ from, to: toUser, at: nowIso(), note })
      n.claimedBy = toUser
      d.log.push({
        ts: nowIso(),
        kind: 'NodeDelegated',
        nodeId,
        message: `Delegated from ${from} to ${toUser}${note ? `: ${note}` : ''}`,
      })
    })
  }

  // ─── Sub-tasks ────────────────────────────────────────────────────────────

  addSubTask(nodeId: string, task: { title: string; assignee?: string; notes?: string }): SubTask | null {
    if (!this.state.nodes[nodeId]) return null
    const subTask: SubTask = {
      id: `st_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title: task.title,
      assignee: task.assignee,
      notes: task.notes,
      done: false,
      createdAt: nowIso(),
    }
    this.mutate(d => {
      const n = d.nodes[nodeId]
      if (!n.subTasks) n.subTasks = []
      n.subTasks.push(subTask)
      d.log.push({ ts: nowIso(), kind: 'SubTaskAdded', nodeId, message: task.title })
    })
    return subTask
  }

  toggleSubTask(nodeId: string, taskId: string) {
    const node = this.state.nodes[nodeId]
    if (!node?.subTasks) return
    this.mutate(d => {
      const st = d.nodes[nodeId].subTasks?.find(t => t.id === taskId)
      if (!st) return
      st.done = !st.done
      st.doneAt = st.done ? nowIso() : undefined
      d.log.push({ ts: nowIso(), kind: st.done ? 'SubTaskDone' : 'SubTaskReopened', nodeId, message: st.title })
    })
  }

  removeSubTask(nodeId: string, taskId: string) {
    if (!this.state.nodes[nodeId]?.subTasks) return
    this.mutate(d => {
      const n = d.nodes[nodeId]
      const st = n.subTasks?.find(t => t.id === taskId)
      n.subTasks = n.subTasks?.filter(t => t.id !== taskId) ?? []
      d.log.push({ ts: nowIso(), kind: 'SubTaskRemoved', nodeId, message: st?.title })
    })
  }

  saveDraft(nodeId: string, formData: Record<string, unknown>, attachmentIds: string[] = []) {
    this.mutate(d => {
      if (!d.nodes[nodeId]) return
      d.nodes[nodeId].formData = formData
      d.nodes[nodeId].attachmentIds = attachmentIds
      d.log.push({ ts: nowIso(), kind: 'NodeDraftSaved', nodeId })
    })
  }

  /**
   * Mark an ACTIVE node as completed and cascade downstream activations.
   */
  complete(
    nodeId: string,
    output: { form?: Record<string, unknown>; attachments?: string[]; [key: string]: unknown } = {},
    actorId?: string,
  ) {
    const node = this.state.nodes[nodeId]
    if (!node || node.status !== 'ACTIVE') return

    this.mutate(d => {
      const n = d.nodes[nodeId]
      n.status = 'COMPLETED'
      n.completedAt = nowIso()
      if (output.form !== undefined) n.formData = output.form
      if (output.attachments !== undefined) n.attachmentIds = output.attachments
      n.output = output
      d.context = mergeOutput(d.context, nodeId, output)
      d.log.push({ ts: nowIso(), kind: 'NodeCompleted', nodeId, message: actorId ? `By ${actorId}` : undefined })
    })

    this.cascadeAfter(nodeId, actorId)
  }

  /**
   * Approval decision. APPROVED → cascade downstream as normal complete.
   * REJECTED → mark node FAILED + try ERROR_BOUNDARY, otherwise fail run.
   */
  decide(
    nodeId: string,
    decision: 'APPROVED' | 'REJECTED' | 'APPROVED_WITH_CONDITIONS',
    payload: { form?: Record<string, unknown>; attachments?: string[]; comments?: string } = {},
    actorId?: string,
  ) {
    const node = this.state.nodes[nodeId]
    if (!node || node.status !== 'ACTIVE') return

    if (decision === 'REJECTED') {
      this.mutate(d => {
        const n = d.nodes[nodeId]
        n.status = 'FAILED'
        n.completedAt = nowIso()
        n.decision = decision
        n.comments = payload.comments
        n.formData = payload.form
        n.failureReason = `Approval rejected${payload.comments ? `: ${payload.comments}` : ''}`
        d.log.push({ ts: nowIso(), kind: 'ApprovalRejected', nodeId, message: payload.comments })
      })
      this.handleFailure(nodeId, actorId)
      return
    }

    this.mutate(d => {
      const n = d.nodes[nodeId]
      n.status = 'COMPLETED'
      n.completedAt = nowIso()
      n.decision = decision
      n.comments = payload.comments
      n.formData = payload.form
      n.attachmentIds = payload.attachments
      const out = { decision, comments: payload.comments, form: payload.form, attachments: payload.attachments }
      n.output = out
      d.context = mergeOutput(d.context, nodeId, out)
      d.log.push({ ts: nowIso(), kind: 'ApprovalApproved', nodeId, message: payload.comments })
    })
    this.cascadeAfter(nodeId, actorId)
  }

  // ─── Cascade & failure ──────────────────────────────────────────────────

  private cascadeAfter(completedNodeId: string, actorId?: string) {
    const completedNode = this.definition.nodes.find(n => n.id === completedNodeId)
    if (!completedNode) return

    const outgoing = this.definition.edges.filter(e => e.sourceNodeId === completedNodeId)
    if (outgoing.length === 0) {
      this.checkComplete()
      return
    }

    const result = resolveNextEdges(completedNode, outgoing, this.state.context)

    if (result.pathStall) {
      this.mutate(d => {
        d.log.push({
          ts: nowIso(),
          kind: 'PathStall',
          nodeId: completedNodeId,
          message: 'No matching branch and no default — workflow halted',
        })
        d.status = 'FAILED'
      })
      return
    }

    // Mark traversed
    this.mutate(d => {
      for (const e of [...result.chosenEdges, ...result.joinEdges]) {
        if (d.edges[e.id]) d.edges[e.id].traversed = true
      }
    })

    const targetNodes: EngineNodeDef[] = []

    // Regular targets
    for (const edge of result.chosenEdges) {
      const target = this.definition.nodes.find(n => n.id === edge.targetNodeId)
      if (target) targetNodes.push(target)
    }

    // PARALLEL_JOIN — bump counter on the JOIN node config; only fire when met
    for (const edge of result.joinEdges) {
      const target = this.definition.nodes.find(n => n.id === edge.targetNodeId)
      if (!target) continue
      const cfg = (target.config ?? {}) as Record<string, unknown>
      const expected = Number(cfg.expected_joins ?? cfg.expectedBranches ?? 0)
      this.mutate(d => {
        const n = d.nodes[target.id]
        const completed = Number((n as any)._completed_joins ?? 0) + 1
        ;(n as any)._completed_joins = completed
        if (completed >= expected && expected > 0) {
          // ready
          ;(n as any)._joinReady = true
        }
      })
      const joinReady = (this.state.nodes[target.id] as any)._joinReady === true
      if (joinReady) targetNodes.push(target)
    }

    // Activate each target (or auto-advance internal-only nodes)
    for (const t of targetNodes) {
      this.activate(t, actorId)
    }

    this.checkComplete()
  }

  private activate(node: EngineNodeDef, actorId?: string) {
    if (this.state.status !== 'ACTIVE') return
    if (this.state.nodes[node.id].status !== 'PENDING') return

    this.mutate(d => {
      d.nodes[node.id].status = 'ACTIVE'
      d.nodes[node.id].activatedAt = nowIso()
      d.log.push({ ts: nowIso(), kind: 'NodeActivated', nodeId: node.id, message: node.nodeType })
    })

    // Server-side-only nodes block in browser-only mode
    if (SERVER_SIDE_ONLY.has(node.nodeType) && node.nodeType !== 'CONSUMABLE_CREATION') {
      this.mutate(d => {
        d.log.push({
          ts: nowIso(),
          kind: 'ServerSideOnly',
          nodeId: node.id,
          message: `${node.nodeType} requires server-side execution. Mark complete manually to continue.`,
        })
      })
      return
    }

    if (node.nodeType === 'END') {
      // Mark complete and finish
      this.mutate(d => {
        d.nodes[node.id].status = 'COMPLETED'
        d.nodes[node.id].completedAt = nowIso()
        d.status = 'COMPLETED'
        d.log.push({ ts: nowIso(), kind: 'RunCompleted', nodeId: node.id })
      })
      return
    }

    if (AUTO_ADVANCE_NODE_TYPES.has(node.nodeType)) {
      // Auto-advance — handle a couple of node types' side effects, then cascade
      if (node.nodeType === 'SET_CONTEXT') {
        const cfg = (node.config ?? {}) as Record<string, unknown>
        const assignments = Array.isArray(cfg.assignments) ? cfg.assignments as Array<{ path: string; value: unknown }> : []
        this.mutate(d => {
          for (const a of assignments) {
            this.applyAssignment(d, a.path, a.value)
          }
        })
      }
      this.complete(node.id, {}, actorId ?? '<auto>')
      return
    }

    // Otherwise — leaves node ACTIVE, awaiting user action
  }

  private applyAssignment(state: RunState, path: string, value: unknown) {
    const parts = path.split('.')
    let target: any
    let key = parts[0]
    if (key === 'globals' || key === '_globals') {
      target = state.context._globals
      parts.shift()
    } else if (key === 'vars' || key === '_vars') {
      target = state.context._vars
      parts.shift()
    } else if (key === 'params' || key === '_params') {
      target = state.context._params
      parts.shift()
    } else {
      target = state.context
    }
    while (parts.length > 1) {
      const p = parts.shift()!
      if (target[p] === undefined || target[p] === null || typeof target[p] !== 'object') {
        target[p] = {}
      }
      target = target[p]
    }
    target[parts[0]] = value
  }

  private handleFailure(nodeId: string, _actorId?: string) {
    // Look for ERROR_BOUNDARY edge from this node
    const errEdge = this.definition.edges.find(
      e => e.sourceNodeId === nodeId && e.edgeType === 'ERROR_BOUNDARY',
    )
    if (errEdge) {
      const target = this.definition.nodes.find(n => n.id === errEdge.targetNodeId)
      if (target) {
        this.mutate(d => {
          d.edges[errEdge.id] && (d.edges[errEdge.id].traversed = true)
          d.log.push({ ts: nowIso(), kind: 'ErrorBoundaryActivated', nodeId, message: target.id })
        })
        this.activate(target)
        return
      }
    }
    this.mutate(d => {
      d.status = 'FAILED'
      d.log.push({ ts: nowIso(), kind: 'RunFailed', nodeId })
    })
  }

  private checkComplete() {
    const stillRunning = Object.values(this.state.nodes).some(n => n.status === 'PENDING' || n.status === 'ACTIVE')
    if (!stillRunning && this.state.status === 'ACTIVE') {
      this.mutate(d => {
        d.status = 'COMPLETED'
        d.log.push({ ts: nowIso(), kind: 'RunCompleted' })
      })
    }
  }

  // ─── Read-only previews ─────────────────────────────────────────────────

  previewBranches(nodeId: string): BranchPreview[] {
    const node = this.definition.nodes.find(n => n.id === nodeId)
    if (!node) return []
    const outgoing = this.definition.edges.filter(e => e.sourceNodeId === nodeId)
    return previewBranches(node, outgoing, this.state.context)
  }

  // exposed so UIs can resolve a path against the current context (variable picker, etc.)
  resolvePath(path: string): unknown {
    return resolvePath(this.state.context, path)
  }

  evalEdge(edge: EngineEdge): boolean {
    return evaluateEdge(edge, this.state.context)
  }
}

export function isRunStatusFinal(s: RunStatus): boolean {
  return s === 'COMPLETED' || s === 'FAILED' || s === 'CANCELLED'
}
