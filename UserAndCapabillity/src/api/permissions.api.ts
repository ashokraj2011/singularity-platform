import { api } from 'identity-web/lib/api'
import type { Permission, PageResponse } from 'identity-web/types'

export const permissionsApi = {
  list: (params?: { page?: number; size?: number; category?: string }) =>
    api.get<PageResponse<Permission>>('/permissions', { params }).then(r => r.data),
}
