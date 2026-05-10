import { useQuery } from '@tanstack/react-query'
import { auditApi } from '@/api/audit.api'

export function useAuditEvents(params?: {
  page?: number
  size?: number
  event_type?: string
  capability_id?: string
  actor_user_id?: string
  from?: string
  to?: string
}) {
  return useQuery({
    queryKey: ['audit-events', params],
    queryFn: () => auditApi.list(params),
    staleTime: 10_000,
  })
}
