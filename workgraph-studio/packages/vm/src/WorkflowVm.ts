// ─────────────────────────────────────────────────────────────────────────────
// WorkflowVm — the portable orchestration loop. A Prisma-free re-implementation
// of the activate → execute → bind → advance cycle from the server's
// WorkflowRuntime, driving @workgraph/engine's GraphTraverser / EdgeEvaluator.
//
// Runs a verified WorkflowImage against injected adapters, persisting state and
// tamper-evident receipts through a StateStore. Deterministic nodes run offline;
// service-bound nodes BLOCK (park) when their adapter is offline, so the run can
// resume + sync later.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto'
import type { EngineEdge, EngineNodeDef, WorkflowDefinition } from '@workgraph/engine'
import { resolveNextEdges } from '@workgraph/engine'
import type {
  WorkflowImage,
  Adapters,
  VmRunState,
  VmNodeRecord,
  VmReceipt,
  ExecContext,
  ExecOutcome,
  Clock,
} from './types.js'
import type { StateStore } from './state/StateStore.js'
import { ExecutorRegistry, defaultRegistry } from './executors/registry.js'
import { sha256Hex } from './image/canonical.js'
import { signDigest } from './image/sign.js'

export interface WorkflowVmOptions {
  image: WorkflowImage
  store: StateStore
  adapters: Adapters
  registry?: ExecutorRegistry
  /** Ed25519 private key (base64 PKCS8) to sign receipts. */
  receiptSigningKeyB64?: string
  clock?: Clock
  /** Called for every run-log entry (default: no-op). */
  onLog?: (entry: { runId: string; ts: string; kind: string; nodeId?: string; message?: string }) => void
}

function setNestedPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}
    cur = cur[parts[i]] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

type ArtifactBinding = { id?: string; name?: string; bindingPath?: string }

export class WorkflowVm {
  private readonly def: WorkflowDefinition
  private readonly image: WorkflowImage
  private readonly store: StateStore
  private readonly adapters: Adapters
  private readonly registry: ExecutorRegistry
  private readonly clock: Clock
  private readonly signKey?: string
  private readonly onLog?: WorkflowVmOptions['onLog']

  private readonly nodeById: Map<string, EngineNodeDef>
  private readonly outgoing: Map<string, EngineEdge[]>
  private readonly incoming: Map<string, EngineEdge[]>

  constructor(opts: WorkflowVmOptions) {
    this.image = opts.image
    this.def = opts.image.payload.workflow
    this.store = opts.store
    this.adapters = opts.adapters
    this.registry = opts.registry ?? defaultRegistry()
    this.clock = opts.clock ?? opts.adapters.clock
    this.signKey = opts.receiptSigningKeyB64
    this.onLog = opts.onLog

    this.nodeById = new Map(this.def.nodes.map(n => [n.id, n]))
    this.outgoing = new Map()
    this.incoming = new Map()
    for (const e of this.def.edges) {
      const out = this.outgoing.get(e.sourceNodeId) ?? []
      out.push(e)
      this.outgoing.set(e.sourceNodeId, out)
      const inc = this.incoming.get(e.targetNodeId) ?? []
      inc.push(e)
      this.incoming.set(e.targetNodeId, inc)
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Start a fresh run and drive it until completion or a blocking node. */
  async start(inputs: Record<string, unknown> = {}, opts: { runId?: string; actorId?: string; tenantId?: string } = {}): Promise<VmRunState> {
    const runId = opts.runId ?? randomUUID()
    const now = this.clock.now().toISOString()

    const vars: Record<string, unknown> = {}
    for (const v of this.def.variables ?? []) {
      if (v.scope !== 'INPUT' && v.defaultValue !== undefined) vars[v.key] = v.defaultValue
    }

    const state: VmRunState = {
      runId,
      imageId: this.image.manifest.imageId,
      workflowId: this.def.workflowId,
      status: 'ACTIVE',
      context: {
        _globals: { ...(this.def.globals ?? {}) },
        _vars: vars,
        _params: { ...inputs },
        ...(opts.actorId ? { _actorId: opts.actorId } : {}),
        ...(opts.tenantId ? { _tenantId: opts.tenantId } : {}),
      },
      nodes: {},
      traversedEdgeIds: [],
      startedAt: now,
      updatedAt: now,
      version: 1,
    }

    // Seed node records + activate entry nodes (START type, or no incoming edges).
    for (const n of this.def.nodes) {
      state.nodes[n.id] = { nodeId: n.id, nodeType: n.nodeType, status: 'PENDING' }
    }
    const entries = this.def.nodes.filter(
      n => n.nodeType === 'START' || (this.incoming.get(n.id)?.length ?? 0) === 0,
    )
    for (const n of entries) this.activate(state, n.id)

    this.store.saveRun(state)
    return this.drive(state)
  }

  /** Resume a parked run — e.g. after a human decision arrived or reconnection. */
  async resume(runId: string): Promise<VmRunState> {
    const state = this.store.loadRun(runId)
    if (!state) throw new Error(`run ${runId} not found`)
    if (state.status === 'COMPLETED' || state.status === 'FAILED' || state.status === 'CANCELLED') return state
    // Re-activate blocked nodes so the loop retries them (adapter may be online now).
    for (const rec of Object.values(state.nodes)) {
      if (rec.status === 'BLOCKED') {
        rec.status = 'ACTIVE'
        rec.blockedReason = undefined
      }
    }
    state.status = 'ACTIVE'
    return this.drive(state)
  }

  // ── Core loop ───────────────────────────────────────────────────────────────

  private async drive(state: VmRunState): Promise<VmRunState> {
    // Process active nodes until none remain runnable this pass.
    for (;;) {
      const activeId = Object.values(state.nodes).find(n => n.status === 'ACTIVE')?.nodeId
      if (!activeId) break

      const node = this.nodeById.get(activeId)!
      const outcome = await this.runNode(state, node)

      if (outcome.kind === 'COMPLETED') {
        this.completeNode(state, node, outcome.output ?? {})
        this.emitReceipt(state, node, 'COMPLETED', outcome.output)
        this.advance(state, node)
      } else if (outcome.kind === 'BLOCKED') {
        const rec = state.nodes[node.id]
        rec.status = 'BLOCKED'
        rec.blockedReason = outcome.reason
        state.status = 'BLOCKED'
        this.touch(state)
        this.store.saveRun(state)
        return state // park — a later resume() picks up from here
      } else {
        // FAILED — try an ERROR_BOUNDARY edge, else fail the run.
        const rec = state.nodes[node.id]
        rec.status = 'FAILED'
        rec.failureReason = outcome.reason
        rec.completedAt = this.clock.now().toISOString()
        this.emitReceipt(state, node, 'FAILED', { reason: outcome.reason })
        const handler = (this.outgoing.get(node.id) ?? []).find(e => e.edgeType === 'ERROR_BOUNDARY')
        if (handler) {
          this.markTraversed(state, handler)
          this.activate(state, handler.targetNodeId)
        } else {
          state.status = 'FAILED'
          this.touch(state)
          this.store.saveRun(state)
          return state
        }
      }
      this.touch(state)
      this.store.saveRun(state)
    }

    if (state.status === 'ACTIVE') {
      const anyBlocked = Object.values(state.nodes).some(n => n.status === 'BLOCKED')
      state.status = anyBlocked ? 'BLOCKED' : 'COMPLETED'
      this.touch(state)
      this.store.saveRun(state)
    }
    return state
  }

  private async runNode(state: VmRunState, node: EngineNodeDef): Promise<ExecOutcome> {
    // Pre-execution policy gate: node types the bundled policy marks as gated must
    // clear governance before their executor runs (fail-closed when offline).
    if (this.image.payload.policy.gatedNodeTypes.includes(node.nodeType)) {
      const gate = await this.policyGate(state, node)
      if (gate) return gate
    }

    const executor = this.registry.get(node.nodeType)
    if (!executor) {
      // Unknown node type → safe default: block offline so nothing is skipped.
      return { kind: 'BLOCKED', reason: `no executor for node type ${node.nodeType}` }
    }
    const ctx = this.execContext(state, node)
    try {
      return await executor.execute(ctx)
    } catch (err) {
      return { kind: 'FAILED', reason: (err as Error).message }
    }
  }

  private async policyGate(state: VmRunState, node: EngineNodeDef): Promise<ExecOutcome | null> {
    const cfg = (node.config ?? {}) as Record<string, unknown>
    const capabilityId = typeof cfg.capabilityId === 'string' ? cfg.capabilityId : ''
    const policy = this.image.payload.policy
    if (capabilityId && policy.allowedCapabilities.includes(capabilityId)) return null
    if (this.adapters.iam.online()) {
      const res = await this.adapters.iam.authzCheck({ capabilityId: capabilityId || node.id })
      return res.allowed ? null : { kind: 'FAILED', reason: res.reason ?? 'authorization denied' }
    }
    if (policy.failClosed) {
      this.log(state, node.id, 'PolicyGateBlocked', 'gated node offline (fail-closed)')
      return { kind: 'BLOCKED', reason: `gated node ${node.nodeType} offline (fail-closed)` }
    }
    return null
  }

  private execContext(state: VmRunState, node: EngineNodeDef): ExecContext {
    return {
      runId: state.runId,
      node: { id: node.id, nodeType: node.nodeType, label: node.label, config: node.config ?? null },
      context: state.context,
      adapters: this.adapters,
      assets: this.image.payload.assets,
      policy: this.image.payload.policy,
      offline: !this.anyAdapterOnline(),
      log: (kind, message, data) => this.log(state, node.id, kind, message, data),
    }
  }

  private anyAdapterOnline(): boolean {
    const a = this.adapters
    return a.iam.online() || a.llm.online() || a.tool.online() || a.git.online() || a.human.online() || a.audit.online()
  }

  // ── State transitions ────────────────────────────────────────────────────────

  private activate(state: VmRunState, nodeId: string): void {
    const rec = state.nodes[nodeId]
    if (!rec) return
    if (rec.status === 'COMPLETED' || rec.status === 'ACTIVE') return
    rec.status = 'ACTIVE'
    rec.activatedAt = this.clock.now().toISOString()
  }

  private completeNode(state: VmRunState, node: EngineNodeDef, output: Record<string, unknown>): void {
    const rec = state.nodes[node.id]
    rec.status = 'COMPLETED'
    rec.output = output
    rec.completedAt = this.clock.now().toISOString()
    // Expose node output under context[nodeId] for downstream reference.
    state.context[node.id] = output
    this.applyOutputBindings(state.context, node, output)
  }

  private applyOutputBindings(context: Record<string, unknown>, node: EngineNodeDef, output: Record<string, unknown>): void {
    const cfg = (node.config ?? {}) as Record<string, unknown>
    const outputs = Array.isArray(cfg.outputArtifacts) ? (cfg.outputArtifacts as ArtifactBinding[]) : []
    for (const a of outputs) {
      const path = typeof a.bindingPath === 'string' ? a.bindingPath.trim() : ''
      if (!path) continue
      const value = a.name && a.name in output ? output[a.name] : a.id && a.id in output ? output[a.id] : undefined
      if (value === undefined) continue
      setNestedPath(context, path, value)
    }
  }

  private advance(state: VmRunState, node: EngineNodeDef): void {
    const outgoing = this.outgoing.get(node.id) ?? []
    const { chosenEdges, joinEdges } = resolveNextEdges(node, outgoing, state.context)
    for (const e of [...chosenEdges, ...joinEdges]) {
      this.markTraversed(state, e)
      this.maybeActivateTarget(state, e.targetNodeId)
    }
  }

  private maybeActivateTarget(state: VmRunState, targetId: string): void {
    const target = this.nodeById.get(targetId)
    if (!target) return
    if (target.nodeType === 'PARALLEL_JOIN') {
      // AND-join: activate only once every incoming edge has been traversed.
      const inc = this.incoming.get(targetId) ?? []
      const allIn = inc.every(e => state.traversedEdgeIds.includes(e.id))
      if (allIn) this.activate(state, targetId)
    } else {
      this.activate(state, targetId)
    }
  }

  private markTraversed(state: VmRunState, edge: EngineEdge): void {
    if (!state.traversedEdgeIds.includes(edge.id)) state.traversedEdgeIds.push(edge.id)
  }

  private touch(state: VmRunState): void {
    state.updatedAt = this.clock.now().toISOString()
    state.version += 1
  }

  // ── Receipts (tamper-evident, hash-chained, optionally signed) ──────────────

  private emitReceipt(state: VmRunState, node: EngineNodeDef, status: string, output: unknown): void {
    const prevHash = this.store.lastReceiptHash(state.runId) ?? 'GENESIS'
    const emittedAt = this.clock.now().toISOString()
    const body = {
      runId: state.runId,
      imageId: state.imageId,
      nodeId: node.id,
      nodeType: node.nodeType,
      status,
      output,
      emittedAt,
      prevHash,
    }
    const hash = sha256Hex(JSON.stringify(body))
    const receipt: VmReceipt = {
      receiptId: randomUUID(),
      runId: state.runId,
      nodeId: node.id,
      nodeType: node.nodeType,
      status,
      output,
      emittedAt,
      prevHash,
      hash,
      signature: this.signKey ? signDigest(hash, this.signKey) : undefined,
    }
    this.store.appendReceipt(receipt)
    // Queue for sync to audit-gov (offline-safe; never dropped).
    void this.adapters.audit.emit({
      runId: state.runId,
      nodeId: node.id,
      kind: `NodeReceipt:${status}`,
      severity: 'audit',
      payload: { receiptId: receipt.receiptId, hash, prevHash },
    })
  }

  private log(state: VmRunState, nodeId: string | undefined, kind: string, message?: string, _data?: Record<string, unknown>): void {
    this.onLog?.({ runId: state.runId, ts: this.clock.now().toISOString(), kind, nodeId, message })
  }
}

// Re-export the node record type for convenience.
export type { VmNodeRecord }
