import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { businessUnitsApi } from '@/api/business-units.api'
import type { CreateBusinessUnitRequest } from '@/types'

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
