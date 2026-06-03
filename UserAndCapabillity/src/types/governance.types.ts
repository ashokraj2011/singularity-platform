// Capability Governance Model (G7) — authoring types. Mirrors the IAM
// GovernanceAttachmentOut / CreateGovernedByRequest / UpdateGovernedByRequest
// schemas (singularity-iam-service/app/governance/schemas.py).

export type GovernanceMode = 'ADVISORY' | 'REQUIRED' | 'BLOCKING'
export type GovernanceScope =
  | 'ALL'
  | 'WORK_ITEM_TYPE'
  | 'WORKFLOW_TYPE'
  | 'WORKFLOW'
  | 'STAGE'

export const GOVERNANCE_MODES: GovernanceMode[] = ['ADVISORY', 'REQUIRED', 'BLOCKING']
export const GOVERNANCE_SCOPES: GovernanceScope[] = [
  'ALL', 'WORK_ITEM_TYPE', 'WORKFLOW_TYPE', 'WORKFLOW', 'STAGE',
]

export interface GovernanceAttachment {
  id: string
  relationship_id: string
  capability_id: string
  governing_capability_id: string
  mode: GovernanceMode
  scope: GovernanceScope
  target_kind?: string | null
  target_key?: string | null
  priority: number
  is_active: boolean
  effective_from?: string | null
  effective_to?: string | null
  waiver_allowed: boolean
  version: number
  contributions: Record<string, unknown>
  created_at: string
  updated_at?: string | null
}

export interface CreateGovernedByRequest {
  governing_capability_id: string
  mode?: GovernanceMode
  scope?: GovernanceScope
  target_kind?: string | null
  target_key?: string | null
  priority?: number
  effective_from?: string | null
  effective_to?: string | null
  waiver_allowed?: boolean
  inheritance_policy?: string
  contributions?: Record<string, unknown> | null
}

export interface UpdateGovernedByRequest {
  mode?: GovernanceMode
  scope?: GovernanceScope
  target_kind?: string | null
  target_key?: string | null
  priority?: number
  effective_from?: string | null
  effective_to?: string | null
  waiver_allowed?: boolean
  contributions?: Record<string, unknown> | null
}
