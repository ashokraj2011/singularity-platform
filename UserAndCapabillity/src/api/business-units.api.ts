import { api } from '@/lib/api'
import type { BusinessUnit, CreateBusinessUnitRequest, PageResponse } from '@/types'

export const businessUnitsApi = {
  list: (params?: { page?: number; size?: number }) =>
    api.get<PageResponse<BusinessUnit>>('/business-units', { params }).then(r => r.data),
  get: (id: string) =>
    api.get<BusinessUnit>(`/business-units/${id}`).then(r => r.data),
  create: (body: CreateBusinessUnitRequest) =>
    api.post<BusinessUnit>('/business-units', body).then(r => r.data),
}
