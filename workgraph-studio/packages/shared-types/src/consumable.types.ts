export type ConsumableStatus =
  | 'DRAFT'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'PUBLISHED'
  | 'SUPERSEDED'
  | 'CONSUMED'
  | 'REJECTED'

export interface ConsumableTypeDTO {
  id: string
  name: string
  description?: string
  schemaDef: Record<string, unknown>
  ownerRoleId?: string
  requiresApproval: boolean
  allowVersioning: boolean
  createdAt: string
  updatedAt: string
}

export interface ConsumableDTO {
  id: string
  typeId: string
  typeName: string
  instanceId?: string
  name: string
  status: ConsumableStatus
  currentVersion: number
  createdById?: string
  createdAt: string
  updatedAt: string
}

export interface ConsumableVersionDTO {
  id: string
  consumableId: string
  version: number
  payload: Record<string, unknown>
  createdById?: string
  createdAt: string
}
