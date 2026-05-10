export interface UserDTO {
  id: string
  email: string
  displayName: string
  isActive: boolean
  teamId?: string
  teamName?: string
  roles: RoleSummaryDTO[]
  skills: SkillSummaryDTO[]
  createdAt: string
  updatedAt: string
}

export interface TeamDTO {
  id: string
  name: string
  description?: string
  departmentId?: string
  departmentName?: string
  memberCount: number
  createdAt: string
  updatedAt: string
}

export interface DepartmentDTO {
  id: string
  name: string
  parentId?: string
  createdAt: string
}

export interface RoleDTO {
  id: string
  name: string
  description?: string
  isSystemRole: boolean
  createdAt: string
}

export interface RoleSummaryDTO {
  id: string
  name: string
}

export interface SkillDTO {
  id: string
  name: string
  description?: string
  category?: string
  createdAt: string
}

export interface SkillSummaryDTO {
  id: string
  name: string
  proficiencyLevel?: number
}

export interface PermissionDTO {
  id: string
  name: string
  resource: string
  action: string
  description?: string
}

export interface TeamMemberDTO {
  userId: string
  displayName: string
  email: string
  joinedAt: string
}
