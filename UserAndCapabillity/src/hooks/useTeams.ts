import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { teamsApi } from '@/api/teams.api'
import type { CreateTeamRequest, AddTeamMemberRequest } from '@/types'

export function useTeams(params?: { page?: number; size?: number }) {
  return useQuery({
    queryKey: ['teams', params],
    queryFn: () => teamsApi.list(params),
    staleTime: 30_000,
  })
}

export function useTeam(id: string) {
  return useQuery({
    queryKey: ['teams', id],
    queryFn: () => teamsApi.get(id),
    enabled: !!id,
  })
}

export function useTeamMembers(teamId: string) {
  return useQuery({
    queryKey: ['teams', teamId, 'members'],
    queryFn: () => teamsApi.listMembers(teamId),
    enabled: !!teamId,
  })
}

export function useCreateTeam() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateTeamRequest) => teamsApi.create(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teams'] }),
  })
}

export function useAddTeamMember(teamId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: AddTeamMemberRequest) => teamsApi.addMember(teamId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teams', teamId, 'members'] }),
  })
}

export function useRemoveTeamMember(teamId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: string) => teamsApi.removeMember(teamId, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['teams', teamId, 'members'] }),
  })
}
