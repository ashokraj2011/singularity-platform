import { api } from '@/lib/api'

export interface AuthzCheckRequest {
  user_id: string
  capability_id: string
  action: string
  resource_type?: string
  resource_id?: string
  requesting_capability_id?: string
}

export interface AuthzCheckResponse {
  allowed: boolean
  reason?: string
  roles?: string[]
  permissions?: string[]
  source?: string
}

export const authzApi = {
  check: (body: AuthzCheckRequest) =>
    api.post<AuthzCheckResponse>('/authz/check', body).then(r => r.data),
  bulkCheck: (user_id: string, checks: Omit<AuthzCheckRequest, 'user_id'>[]) =>
    api.post<{ results: AuthzCheckResponse[] }>('/authz/bulk-check', { user_id, checks }).then(r => r.data),
}
