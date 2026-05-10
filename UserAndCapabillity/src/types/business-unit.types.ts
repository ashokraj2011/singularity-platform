export interface BusinessUnit {
  id: string
  bu_key: string
  name: string
  description?: string
  parent_bu_id?: string
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface CreateBusinessUnitRequest {
  bu_key: string
  name: string
  description?: string
  parent_bu_id?: string
  metadata?: Record<string, unknown>
}
