// ─────────────────────────────────────────────────────────────────────────────
// @workgraph/vm — type definitions for the portable Workflow VM.
//
// Builds on @workgraph/engine (WorkflowDefinition, EngineNode/Edge, EdgeEvaluator,
// GraphTraverser). Nothing here imports Prisma or Express so the package runs
// anywhere Node runs (laptop, container, edge, air-gapped host).
// ─────────────────────────────────────────────────────────────────────────────

import type { WorkflowDefinition, NodeStatus, RunStatus } from '@workgraph/engine'

export const WGVM_ENGINE_ABI = 1 as const

// ─── Governance policy snapshot (bundled into the image) ────────────────────

export interface GovernancePolicySnapshot {
  /** Opaque hash of the policy at build time — carried in the manifest. */
  policyHash: string
  /** Node types that require a governance decision before they may run. */
  gatedNodeTypes: string[]
  /** Capability ids the workflow is allowed to invoke offline. */
  allowedCapabilities: string[]
  /** Node types that always require a human approval, even offline. */
  approvalRequiredNodeTypes: string[]
  /** When true, any gate that cannot be evaluated blocks the run (fail-closed). */
  failClosed: boolean
}

// ─── Manifest — the signed table of contents of a .wgvm image ───────────────

export interface WorkflowImageManifest {
  /** Format identifier — always "wgvm". */
  format: 'wgvm'
  /** Content-addressed id of the image (sha256 of the canonical payload). */
  imageId: string
  /** Engine ABI the image was built against; the VM refuses mismatches. */
  engineAbi: number
  workflowId: string
  workflowName: string
  /** design-graph version hash the image was built from. */
  versionHash: string
  /** Node types referenced by the workflow (drives adapter capability checks). */
  nodeTypes: string[]
  /** Adapter capabilities the image needs to run online (e.g. "llm", "iam"). */
  requiredAdapters: string[]
  policyHash: string
  builtAt: string
  builtBy?: string
  /** sha256 of each embedded payload file, keyed by logical path. */
  fileDigests: Record<string, string>
}

// ─── Signature envelope ─────────────────────────────────────────────────────

export interface ImageSignature {
  algorithm: 'ed25519'
  /** base64 public key (SPKI DER) of the signer. */
  publicKey: string
  /** base64 signature over the canonical digest of manifest + payload. */
  signature: string
  keyId?: string
}

// ─── The in-memory image ────────────────────────────────────────────────────

export interface WorkflowImagePayload {
  workflow: WorkflowDefinition
  policy: GovernancePolicySnapshot
  /** Node-embedded assets required offline (prompt text, python sources, …). */
  assets: Record<string, string>
}

export interface WorkflowImage {
  manifest: WorkflowImageManifest
  payload: WorkflowImagePayload
  signature?: ImageSignature
}

// ─── Run state ──────────────────────────────────────────────────────────────

export type VmRunStatus = RunStatus | 'BLOCKED'

export interface VmNodeRecord {
  nodeId: string
  nodeType: string
  status: NodeStatus | 'BLOCKED'
  output?: unknown
  activatedAt?: string
  completedAt?: string
  failureReason?: string
  /** Set when a node is parked awaiting an offline-degraded external step. */
  blockedReason?: string
}

export interface VmReceipt {
  receiptId: string
  runId: string
  nodeId: string
  nodeType: string
  status: string
  output?: unknown
  emittedAt: string
  /** Hash chained from the previous receipt for tamper-evidence. */
  prevHash: string
  hash: string
  /** ed25519 signature over `hash` when a signing key is configured. */
  signature?: string
}

export interface VmRunState {
  runId: string
  imageId: string
  workflowId: string
  status: VmRunStatus
  context: {
    _globals: Record<string, unknown>
    _vars: Record<string, unknown>
    _params: Record<string, unknown>
    [key: string]: unknown
  }
  nodes: Record<string, VmNodeRecord>
  traversedEdgeIds: string[]
  startedAt: string
  updatedAt: string
  version: number
}

// ─── Execution result of a single node ──────────────────────────────────────

export type ExecOutcome =
  | { kind: 'COMPLETED'; output?: Record<string, unknown> }
  | { kind: 'FAILED'; reason: string }
  | { kind: 'BLOCKED'; reason: string; resumeToken?: string }

export interface ExecContext {
  runId: string
  node: { id: string; nodeType: string; label?: string | null; config?: Record<string, unknown> | null }
  /** Live, mutable run context (read for inputs; executors may return outputs). */
  context: Record<string, unknown>
  adapters: Adapters
  assets: Record<string, string>
  policy: GovernancePolicySnapshot
  /** True when no online adapters are reachable — executors should degrade. */
  offline: boolean
  log: (kind: string, message?: string, data?: Record<string, unknown>) => void
}

export interface NodeExecutor {
  /** Node types this executor handles. */
  readonly handles: string[]
  execute(ctx: ExecContext): Promise<ExecOutcome>
}

// ─── Adapter interfaces (Phase 2 fills in real impls) ───────────────────────

export interface Adapters {
  iam: IamAdapter
  llm: LlmAdapter
  tool: McpToolAdapter
  git: GitAdapter
  human: HumanTaskAdapter
  audit: AuditAdapter
  discovery: DiscoveryAdapter
  clock: Clock
}

export interface Clock {
  now(): Date
}

export interface IamAuthzRequest {
  actorId?: string
  capabilityId: string
  tenantId?: string
}
export interface IamAdapter {
  online(): boolean
  authzCheck(req: IamAuthzRequest): Promise<{ allowed: boolean; reason?: string }>
}

export interface LlmAdapter {
  online(): boolean
  complete(input: { prompt: string; model?: string; tools?: unknown[] }): Promise<{ text: string; raw?: unknown }>
}

export interface McpToolAdapter {
  online(): boolean
  invoke(input: { tool: string; params: Record<string, unknown> }): Promise<{ result: unknown }>
}

export interface GitAdapter {
  online(): boolean
  push(input: { repo: string; branch: string; message?: string }): Promise<{ ok: boolean; ref?: string }>
}

export interface HumanTaskRequest {
  runId: string
  nodeId: string
  title: string
  assignee?: string
}
export interface HumanTaskAdapter {
  online(): boolean
  /** Returns a decision when online, or throws OfflineError to force a BLOCK. */
  requestDecision(req: HumanTaskRequest): Promise<{ decision: 'APPROVED' | 'REJECTED'; by?: string }>
}

export interface AuditEvent {
  runId: string
  nodeId?: string
  kind: string
  severity?: 'info' | 'warn' | 'error' | 'audit'
  payload?: Record<string, unknown>
}
export interface AuditAdapter {
  online(): boolean
  emit(event: AuditEvent): Promise<void>
}

// ─── Discovery / Elicitation (ADR 0006) ─────────────────────────────────────
// Portable analogue of the server DiscoveryService. A DISCOVERY node reduces
// unknowns by asking the central discovery loop to elicit questions/assumptions
// (online → Context Fabric/MCP via the platform); offline it throws OfflineError
// so the executor parks the run until reconnected (fail-closed on unknowns).

export interface DiscoveryQuestionSpec {
  id?: string
  text: string
  /** Blocking questions gate the node (park while OPEN). */
  blocking: boolean
  status?: 'OPEN' | 'ANSWERED' | 'DISMISSED'
  answer?: string
}

export interface DiscoveryAssumptionSpec {
  text: string
  confidence: number
}

export interface DiscoveryElicitRequest {
  runId: string
  nodeId: string
  /** Discovery session scope id (defaults to the run id). */
  scopeId: string
  hint?: string
  context?: string
  /** Configured seed questions carried in the image (source='configured'). */
  seedQuestions: DiscoveryQuestionSpec[]
}

export interface DiscoveryElicitResult {
  questions: DiscoveryQuestionSpec[]
  assumptions: DiscoveryAssumptionSpec[]
}

export interface DiscoveryAdapter {
  online(): boolean
  /** Runs one elicit iteration online; throws OfflineError when disconnected. */
  elicit(req: DiscoveryElicitRequest): Promise<DiscoveryElicitResult>
}

export class OfflineError extends Error {
  constructor(capability: string) {
    super(`adapter capability "${capability}" is offline`)
    this.name = 'OfflineError'
  }
}
