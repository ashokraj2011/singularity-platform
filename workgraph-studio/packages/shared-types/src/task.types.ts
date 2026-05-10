export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'PENDING_REVIEW' | 'COMPLETED' | 'CANCELLED'

export type AssignmentMode =
  | 'DIRECT_USER'
  | 'TEAM_QUEUE'
  | 'ROLE_BASED'
  | 'SKILL_BASED'
  | 'AGENT'

export interface TaskDTO {
  id: string
  instanceId?: string
  nodeId?: string
  title: string
  description?: string
  status: TaskStatus
  assignmentMode: AssignmentMode
  priority: number
  dueAt?: string
  assignedToId?: string
  assignedToName?: string
  teamId?: string
  teamName?: string
  createdById?: string
  createdAt: string
  updatedAt: string
}

export interface TaskCommentDTO {
  id: string
  taskId: string
  authorId: string
  authorName: string
  content: string
  createdAt: string
}

export interface TeamQueueItemDTO {
  id: string
  teamId: string
  taskId: string
  claimedById?: string
  task: TaskDTO
  enqueuedAt: string
  claimedAt?: string
}
