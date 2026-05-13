export type UserStatus = 'active' | 'disabled' | 'invited' | 'locked'
export type AuthProvider = 'github' | 'pingfederate' | 'oidc' | 'local'

export interface User {
  id: string
  email: string
  display_name?: string
  status: UserStatus
  auth_provider?: AuthProvider
  external_subject?: string
  is_super_admin: boolean
  is_local_account: boolean
  metadata: Record<string, unknown>
  tags?: string[]
  created_at: string
  updated_at: string
}

export interface CreateUserRequest {
  email: string
  display_name?: string
  auth_provider?: AuthProvider
  external_subject?: string
  metadata?: Record<string, unknown>
  tags?: string[]
}

export interface UpdateUserRequest {
  display_name?: string
  status?: UserStatus
  is_super_admin?: boolean
  metadata?: Record<string, unknown>
}
