import { api } from '@/lib/api'
import type { Role, CreateRoleRequest, AssignPermissionRequest, PageResponse } from '@/types'

export const rolesApi = {
  list: (params?: { page?: number; size?: number }) =>
    api.get<PageResponse<Role>>('/roles', { params }).then(r => r.data),
  get: (roleKey: string) =>
    api.get<Role>(`/roles/${roleKey}`).then(r => r.data),
  create: (body: CreateRoleRequest) =>
    api.post<Role>('/roles', body).then(r => r.data),
  addPermission: (roleKey: string, body: AssignPermissionRequest) =>
    api.post(`/roles/${roleKey}/permissions`, body).then(r => r.data),
  removePermission: (roleKey: string, permissionKey: string) =>
    api.delete(`/roles/${roleKey}/permissions/${permissionKey}`).then(r => r.data),
}
