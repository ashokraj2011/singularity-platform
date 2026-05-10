import { api } from '@/lib/api'
import type { Team, TeamMembership, CreateTeamRequest, AddTeamMemberRequest, PageResponse } from '@/types'

export const teamsApi = {
  list: (params?: { page?: number; size?: number }) =>
    api.get<PageResponse<Team>>('/teams', { params }).then(r => r.data),
  get: (id: string) =>
    api.get<Team>(`/teams/${id}`).then(r => r.data),
  create: (body: CreateTeamRequest) =>
    api.post<Team>('/teams', body).then(r => r.data),
  listMembers: (teamId: string) =>
    api.get<TeamMembership[]>(`/teams/${teamId}/members`).then(r => r.data),
  addMember: (teamId: string, body: AddTeamMemberRequest) =>
    api.post<TeamMembership>(`/teams/${teamId}/members`, body).then(r => r.data),
  removeMember: (teamId: string, userId: string) =>
    api.delete(`/teams/${teamId}/members/${userId}`).then(r => r.data),
}
