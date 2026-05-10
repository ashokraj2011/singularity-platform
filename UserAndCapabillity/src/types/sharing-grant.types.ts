export type GrantType = 'view' | 'execute' | 'integrate' | 'administer_limited'
export type GrantStatus = 'active' | 'suspended' | 'revoked'

export interface SharingGrant {
  id: string
  provider_capability_id: string
  consumer_capability_id: string
  grant_type: GrantType
  allowed_permissions: string[]
  status: GrantStatus
  approved_by?: string
  approved_at?: string
  metadata: Record<string, unknown>
  created_at: string
}

export interface CreateSharingGrantRequest {
  provider_capability_id: string
  consumer_capability_id: string
  grant_type: GrantType
  allowed_permissions: string[]
  metadata?: Record<string, unknown>
}
