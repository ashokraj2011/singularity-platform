export type RoleScope = 'platform' | 'capability'

export interface Role {
  id: string
  role_key: string
  name: string
  description?: string
  role_scope: RoleScope
  system_role: boolean
  metadata?: Record<string, unknown>
  tags: string[]
  created_at: string
  updated_at: string
}

export interface CreateRoleRequest {
  role_key: string
  name: string
  description?: string
  role_scope: RoleScope
  metadata?: Record<string, unknown>
  tags?: string[]
}

export interface AssignPermissionRequest {
  permission_key: string
}
