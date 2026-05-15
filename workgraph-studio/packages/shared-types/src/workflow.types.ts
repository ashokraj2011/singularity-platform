export type NodeType =
  | 'START'
  | 'END'
  | 'HUMAN_TASK'
  | 'AGENT_TASK'
  | 'WORKBENCH_TASK'
  | 'APPROVAL'
  | 'DECISION_GATE'
  | 'CONSUMABLE_CREATION'
  | 'TOOL_REQUEST'
  | 'POLICY_CHECK'
  | 'TIMER'
  | 'SIGNAL_WAIT'
  | 'SIGNAL_EMIT'
  | 'CALL_WORKFLOW'
  | 'WORK_ITEM'
  | 'FOREACH'
  | 'PARALLEL_FORK'
  | 'PARALLEL_JOIN'
  | 'INCLUSIVE_GATEWAY'
  | 'EVENT_GATEWAY'
  | 'DATA_SINK'
  | 'SET_CONTEXT'
  | 'ERROR_CATCH'
  | 'CUSTOM'

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
  | 'SKIPPED'
  | 'FAILED'
  | 'BLOCKED'

export type InstanceStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'PAUSED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED'

export interface WorkflowTemplateDTO {
  id: string
  name: string
  description?: string
  currentVersion: number
  createdById?: string
  createdAt: string
  updatedAt: string
}

export interface WorkflowInstanceDTO {
  id: string
  templateId?: string
  initiativeId?: string
  name: string
  status: InstanceStatus
  context: Record<string, unknown>
  startedAt?: string
  completedAt?: string
  createdById?: string
  createdAt: string
  updatedAt: string
}

export interface WorkflowPhaseDTO {
  id: string
  instanceId: string
  name: string
  displayOrder: number
  color?: string
  createdAt: string
}

export interface WorkflowNodeDTO {
  id: string
  instanceId: string
  phaseId?: string
  nodeType: NodeType
  label: string
  status: NodeStatus
  config: Record<string, unknown>
  positionX: number
  positionY: number
  createdAt: string
  updatedAt: string
}

export interface WorkflowEdgeDTO {
  id: string
  instanceId: string
  sourceNodeId: string
  targetNodeId: string
  edgeType: EdgeType
  condition?: Record<string, unknown>
  label?: string
  createdAt: string
}

export interface WorkflowMutationDTO {
  id: string
  instanceId: string
  nodeId?: string
  mutationType: string
  beforeState?: Record<string, unknown>
  afterState?: Record<string, unknown>
  performedById?: string
  performedAt: string
}
