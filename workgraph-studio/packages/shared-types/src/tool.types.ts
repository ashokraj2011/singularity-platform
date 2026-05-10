export type ToolRunStatus =
  | 'REQUESTED'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'REJECTED'
  | 'FAILED'

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface ToolDTO {
  id: string
  name: string
  description?: string
  riskLevel: RiskLevel
  requiresApproval: boolean
  isActive: boolean
  actions: ToolActionDTO[]
  createdAt: string
  updatedAt: string
}

export interface ToolActionDTO {
  id: string
  toolId: string
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  riskLevel: RiskLevel
}

export interface ToolRunDTO {
  id: string
  toolId: string
  toolName: string
  actionId?: string
  instanceId?: string
  status: ToolRunStatus
  inputPayload: Record<string, unknown>
  outputPayload?: Record<string, unknown>
  requestedById?: string
  startedAt?: string
  completedAt?: string
  createdAt: string
  updatedAt: string
}
