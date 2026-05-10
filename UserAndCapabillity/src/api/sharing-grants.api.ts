import { api } from '@/lib/api'
import type { SharingGrant, CreateSharingGrantRequest, PageResponse } from '@/types'

export const sharingGrantsApi = {
  list: (params?: { page?: number; size?: number; status?: string }) =>
    api.get<PageResponse<SharingGrant>>('/capability-sharing-grants', { params }).then(r => r.data),
  create: (body: CreateSharingGrantRequest) =>
    api.post<SharingGrant>('/capability-sharing-grants', body).then(r => r.data),
  approve: (id: string) =>
    api.post<SharingGrant>(`/capability-sharing-grants/${id}/approve`).then(r => r.data),
  revoke: (id: string) =>
    api.post<SharingGrant>(`/capability-sharing-grants/${id}/revoke`).then(r => r.data),
}
