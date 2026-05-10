export type ApprovalStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'APPROVED_WITH_CONDITIONS'
  | 'NEEDS_MORE_INFORMATION'
  | 'DEFERRED'
  | 'ESCALATED'

export interface ApprovalRequestDTO {
  id: string
  instanceId?: string
  nodeId?: string
  subjectType: string
  subjectId: string
  requestedById: string
  requestedByName: string
  assignedToId?: string
  assignedToName?: string
  status: ApprovalStatus
  dueAt?: string
  createdAt: string
  updatedAt: string
}

export interface ApprovalDecisionDTO {
  id: string
  requestId: string
  decidedById: string
  decidedByName: string
  decision: ApprovalStatus
  conditions?: string
  notes?: string
  decidedAt: string
}
