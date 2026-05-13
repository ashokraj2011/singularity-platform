export type CapabilityType =
  | 'business_capability'
  | 'application_capability'
  | 'shared_capability'
  | 'delivery_capability'
  | 'collection_capability'
  | 'platform_capability'
  | 'technical_capability'

export type CapabilityStatus = 'active' | 'archived' | 'suspended'
export type CapabilityVisibility = 'private' | 'shared' | 'platform'

export type RelationshipType =
  | 'contains'
  | 'parent_child'
  | 'uses'
  | 'depends_on'
  | 'shared_with'
  | 'delivers_to'
  | 'collects_from'
  | 'governed_by'

export type InheritancePolicy =
  | 'none'
  | 'inherit_view'
  | 'inherit_execute'
  | 'inherit_admin'
  | 'explicit_grant_only'

export interface Capability {
  id: string
  capability_id: string
  name: string
  description?: string
  capability_type: CapabilityType
  status: CapabilityStatus
  visibility: CapabilityVisibility
  owner_bu_id?: string
  owner_team_id?: string
  metadata: Record<string, unknown>
  tags?: string[]
  created_by?: string
  created_at: string
  updated_at: string
}

export interface CapabilityRelationship {
  id: string
  source_capability_id: string
  target_capability_id: string
  relationship_type: RelationshipType
  inheritance_policy: InheritancePolicy
  metadata: Record<string, unknown>
  created_at: string
}

export interface CapabilityMembership {
  id: string
  capability_id: string
  user_id?: string
  team_id?: string
  role_id: string
  status: string
  granted_by?: string
  valid_from?: string
  valid_until?: string
  metadata: Record<string, unknown>
  created_at: string
}

export interface CreateCapabilityRequest {
  capability_id: string
  name: string
  description?: string
  capability_type: CapabilityType
  visibility?: CapabilityVisibility
  owner_bu_key?: string
  owner_team_key?: string
  metadata?: Record<string, unknown>
  tags?: string[]
}

export interface CreateCapabilityRelationshipRequest {
  target_capability_id: string
  relationship_type: RelationshipType
  inheritance_policy?: InheritancePolicy
  metadata?: Record<string, unknown>
}

export interface AddCapabilityMemberRequest {
  user_id?: string
  team_id?: string
  role_key: string
}
