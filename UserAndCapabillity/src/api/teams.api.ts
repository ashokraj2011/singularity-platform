import { api } from 'identity-web/lib/api'
import type { Team, TeamMembership, CreateTeamRequest, UpdateTeamRequest, AddTeamMemberRequest, PageResponse } from 'identity-web/types'

export const teamsApi = {
  list: (params?: { page?: number; size?: number }) =>
    api.get<PageResponse<Team>>('/teams', { params }).then(r => r.data),
  get: (id: string) =>
    api.get<Team>(`/teams/${id}`).then(r => r.data),
  create: (body: CreateTeamRequest) =>
    api.post<Team>('/teams', body).then(r => r.data),
  update: (id: string, body: UpdateTeamRequest) =>
    api.patch<Team>(`/teams/${id}`, body).then(r => r.data),
  listChildren: (id: string) =>
    api.get<Team[]>(`/teams/${id}/children`).then(r => r.data),
  addChild: (id: string, childTeamId: string) =>
    api.post<Team>(`/teams/${id}/children`, { child_team_id: childTeamId }).then(r => r.data),
  listMembers: (teamId: string) =>
    api.get<TeamMembership[]>(`/teams/${teamId}/members`).then(r => r.data),
  addMember: (teamId: string, body: AddTeamMemberRequest) =>
    api.post<TeamMembership>(`/teams/${teamId}/members`, body).then(r => r.data),
  removeMember: (teamId: string, userId: string) =>
    api.delete(`/teams/${teamId}/members/${userId}`).then(r => r.data),
}
