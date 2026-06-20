import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { businessUnitsApi } from 'identity-web/api/business-units.api'
import type { CreateBusinessUnitRequest, UpdateBusinessUnitRequest } from 'identity-web/types'

export function useBusinessUnits(params?: { page?: number; size?: number }) {
  return useQuery({
    queryKey: ['business-units', params],
    queryFn: () => businessUnitsApi.list(params),
    staleTime: 60_000,
  })
}

export function useCreateBusinessUnit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateBusinessUnitRequest) => businessUnitsApi.create(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['business-units'] }),
  })
}

export function useUpdateBusinessUnit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateBusinessUnitRequest }) => businessUnitsApi.update(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['business-units'] }),
  })
}
