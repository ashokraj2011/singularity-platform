// ─────────────────────────────────────────────────────────────────────────────
// @workgraph/engine — type definitions used by the browser runtime AND the
// server-side runtime. No Prisma imports here so the package stays
// browser-friendly.
// ─────────────────────────────────────────────────────────────────────────────

export type EdgeType =
  | 'SEQUENTIAL'
  | 'CONDITIONAL'
  | 'PARALLEL_SPLIT'
  | 'PARALLEL_JOIN'
  | 'ERROR_BOUNDARY'

export type NodeStatus =
  | 'PENDING'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED'

export type RunStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'

// ─── Generic shapes — work for both Prisma rows and engine state ────────────

export interface EngineEdge {
  id: string
  sourceNodeId: string
  targetNodeId: string
  edgeType: EdgeType | string
  condition?: unknown
}

export interface EngineNodeDef {
  id: string
  nodeType: string
  label?: string | null
  config?: Record<string, unknown> | null
}

// ─── Workflow definition (read from /workflow-templates/:id/design-graph) ───

export interface WorkflowDefinition {
  workflowId: string
  versionHash: string
  name: string
  variables?: Array<{
    key: string
    type?: string
    defaultValue?: unknown
    scope?: 'INPUT' | 'CONSTANT'
  }>
  globals?: Record<string, unknown>
  nodes: EngineNodeDef[]
  edges: EngineEdge[]
}

// ─── Run state (lives in browser memory + IndexedDB) ────────────────────────

// ─── Sub-task (ad-hoc checklist item attached to a node at runtime) ─────────

export interface SubTask {
  id: string
  title: string
  assignee?: string   // free-text email / name of the person responsible
  notes?: string
  done: boolean
  createdAt: string
  doneAt?: string
}

// ─── Delegation record ────────────────────────────────────────────────────────

export interface DelegationRecord {
  from: string   // who delegated
  to: string     // who received
  at: string     // ISO timestamp
  note?: string
}

export interface RunNodeState {
  id: string
  nodeType: string
  status: NodeStatus
  output?: unknown
  formData?: Record<string, unknown>
  attachmentIds?: string[]
  claimedBy?: string
  decision?: 'APPROVED' | 'REJECTED' | 'APPROVED_WITH_CONDITIONS'
  comments?: string
  activatedAt?: string
  completedAt?: string
  failureReason?: string
  /** Ad-hoc sub-tasks created at runtime for this node */
  subTasks?: SubTask[]
  /** Delegation history — each entry records a hand-off */
  delegations?: DelegationRecord[]
}

export interface RunEdgeState {
  id: string
  traversed: boolean
}

export interface RunLogEntry {
  ts: string
  kind: string         // e.g. 'NodeActivated', 'NodeCompleted', 'PathStall'
  nodeId?: string
  message?: string
  data?: Record<string, unknown>
}

export interface RunState {
  runId: string
  workflowId: string
  workflowVersionHash: string
  name: string
  status: RunStatus
  context: {
    _globals: Record<string, unknown>
    _vars:    Record<string, unknown>
    _params:  Record<string, unknown>
    [key: string]: unknown
  }
  nodes: Record<string, RunNodeState>
  edges: Record<string, RunEdgeState>
  log: RunLogEntry[]
  startedAt: string
  updatedAt: string
  version: number       // monotonically incremented for snapshot OCC
  createdById?: string
}

// ─── Branch condition shapes (used by EdgeEvaluator) ────────────────────────

export type ConditionOp =
  | '==' | '!=' | '>' | '>=' | '<' | '<='
  | 'contains' | 'not_contains'
  | 'in' | 'not_in'
  | 'exists' | 'not_exists'
  | 'starts_with' | 'ends_with'

export interface BranchCondition {
  id?: string
  left: string
  op: ConditionOp
  right: string
}

export interface Branch {
  label?: string
  logic?: 'AND' | 'OR'
  conditions: BranchCondition[]
  priority?: number
  isDefault?: boolean
}
