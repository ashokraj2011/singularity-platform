import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { sharingGrantsApi } from '@/api/sharing-grants.api'
import type { CreateSharingGrantRequest } from '@/types'

export function useSharingGrants(params?: { page?: number; size?: number; status?: string }) {
  return useQuery({
    queryKey: ['sharing-grants', params],
    queryFn: () => sharingGrantsApi.list(params),
    staleTime: 30_000,
  })
}

export function useCreateSharingGrant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateSharingGrantRequest) => sharingGrantsApi.create(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sharing-grants'] }),
  })
}

export function useApproveSharingGrant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharingGrantsApi.approve(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sharing-grants'] }),
  })
}

export function useRevokeSharingGrant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => sharingGrantsApi.revoke(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sharing-grants'] }),
  })
}
