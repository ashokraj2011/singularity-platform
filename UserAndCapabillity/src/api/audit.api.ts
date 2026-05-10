import { api } from '@/lib/api'
import type { AuditEvent, PageResponse } from '@/types'

export const auditApi = {
  list: (params?: {
    page?: number
    size?: number
    event_type?: string
    capability_id?: string
    actor_user_id?: string
    from?: string
    to?: string
  }) =>
    api.get<PageResponse<AuditEvent>>('/audit-events', { params }).then(r => r.data),
}
