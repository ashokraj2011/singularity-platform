export interface BusinessUnit {
  id: string
  bu_key: string
  name: string
  description?: string
  parent_bu_id?: string
  metadata: Record<string, unknown>
  tags?: string[]
  created_at: string
  updated_at: string
}

export interface CreateBusinessUnitRequest {
  bu_key: string
  name: string
  description?: string
  parent_bu_id?: string
  metadata?: Record<string, unknown>
  tags?: string[]
}

export interface UpdateBusinessUnitRequest {
  name?: string
  description?: string | null
  // null → detach (make root); string → set/move parent; omit → unchanged.
  parent_bu_id?: string | null
}
