export interface Team {
  id: string
  team_key: string
  name: string
  description?: string
  bu_id?: string
  parent_team_id?: string
  metadata: Record<string, unknown>
  tags: string[]
  created_at: string
  updated_at: string
}

export interface TeamMembership {
  id: string
  team_id: string
  user_id: string
  membership_type: string
  created_at: string
}

export interface CreateTeamRequest {
  team_key: string
  name: string
  description?: string
  bu_key?: string
  parent_team_id?: string
  metadata?: Record<string, unknown>
  tags?: string[]
}

export interface AddTeamMemberRequest {
  user_id: string
  membership_type?: string
}
