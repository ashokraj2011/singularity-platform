import { useQuery } from '@tanstack/react-query'
import { permissionsApi } from '@/api/permissions.api'

export function usePermissions(params?: { page?: number; size?: number; category?: string }) {
  return useQuery({
    queryKey: ['permissions', params],
    queryFn: () => permissionsApi.list(params),
    staleTime: 120_000,
  })
}
