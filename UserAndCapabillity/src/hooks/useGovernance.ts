import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { governanceApi } from '@/api/governance.api'
import type { CreateGovernedByRequest, UpdateGovernedByRequest } from '@/types'

// queryKey convention mirrors useCapabilities: ['capabilities', id, 'governance', ...].

export function useGovernedBy(capabilityId: string, includeInactive = false) {
  return useQuery({
    queryKey: ['capabilities', capabilityId, 'governance', 'governed-by', includeInactive],
    queryFn: () => governanceApi.listGovernedBy(capabilityId, includeInactive),
    enabled: !!capabilityId,
  })
}

export function useGoverns(capabilityId: string) {
  return useQuery({
    queryKey: ['capabilities', capabilityId, 'governance', 'governs'],
    queryFn: () => governanceApi.listGoverns(capabilityId),
    enabled: !!capabilityId,
  })
}

export function useGoverningCapabilities() {
  return useQuery({
    queryKey: ['capabilities', 'governing'],
    queryFn: () => governanceApi.listGoverningCapabilities(),
    staleTime: 30_000,
  })
}

function useGovernanceInvalidator(capabilityId: string) {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['capabilities', capabilityId, 'governance'] })
}

export function useAttachGovernance(capabilityId: string) {
  const invalidate = useGovernanceInvalidator(capabilityId)
  return useMutation({
    mutationFn: (body: CreateGovernedByRequest) => governanceApi.attach(capabilityId, body),
    onSuccess: invalidate,
  })
}

export function useUpdateGovernance(capabilityId: string) {
  const invalidate = useGovernanceInvalidator(capabilityId)
  return useMutation({
    mutationFn: ({ attachmentId, body }: { attachmentId: string; body: UpdateGovernedByRequest }) =>
      governanceApi.update(capabilityId, attachmentId, body),
    onSuccess: invalidate,
  })
}

export function useDeactivateGovernance(capabilityId: string) {
  const invalidate = useGovernanceInvalidator(capabilityId)
  return useMutation({
    mutationFn: (attachmentId: string) => governanceApi.deactivate(capabilityId, attachmentId),
    onSuccess: invalidate,
  })
}

export function useReactivateGovernance(capabilityId: string) {
  const invalidate = useGovernanceInvalidator(capabilityId)
  return useMutation({
    mutationFn: (attachmentId: string) => governanceApi.reactivate(capabilityId, attachmentId),
    onSuccess: invalidate,
  })
}
