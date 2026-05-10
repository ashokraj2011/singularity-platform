import { api } from '@/lib/api'
import type { Permission, PageResponse } from '@/types'

export const permissionsApi = {
  list: (params?: { page?: number; size?: number; category?: string }) =>
    api.get<PageResponse<Permission>>('/permissions', { params }).then(r => r.data),
}
