export type AgentRunStatus =
  | 'REQUESTED'
  | 'RUNNING'
  | 'AWAITING_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'FAILED'

export interface AgentDTO {
  id: string
  name: string
  description?: string
  provider: string
  model: string
  isActive: boolean
  skills: string[]
  createdAt: string
  updatedAt: string
}

export interface AgentRunDTO {
  id: string
  agentId: string
  agentName: string
  instanceId?: string
  nodeId?: string
  status: AgentRunStatus
  initiatedById?: string
  startedAt?: string
  completedAt?: string
  createdAt: string
  updatedAt: string
}

export interface AgentRunOutputDTO {
  id: string
  runId: string
  outputType: string
  rawContent?: string
  structuredPayload?: Record<string, unknown>
  tokenCount?: number
  createdAt: string
}

export interface AgentReviewDTO {
  id: string
  runId: string
  reviewedById: string
  reviewedByName: string
  decision: 'APPROVED' | 'REJECTED'
  notes?: string
  reviewedAt: string
}
