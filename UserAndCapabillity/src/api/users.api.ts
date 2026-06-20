import { api } from 'identity-web/lib/api'
import type { User, CreateUserRequest, UpdateUserRequest, PageResponse, PlatformRole } from 'identity-web/types'

export const usersApi = {
  list: (params?: { page?: number; size?: number; search?: string }) =>
    api.get<PageResponse<User>>('/users', { params }).then(r => r.data),
  get: (id: string) =>
    api.get<User>(`/users/${id}`).then(r => r.data),
  create: (body: CreateUserRequest) =>
    api.post<User>('/users', body).then(r => r.data),
  update: (id: string, body: UpdateUserRequest) =>
    api.patch<User>(`/users/${id}`, body).then(r => r.data),
  listRoles: (userId: string) =>
    api.get<PlatformRole[]>(`/users/${userId}/roles`).then(r => r.data),
  assignRole: (userId: string, role_key: string) =>
    api.post(`/users/${userId}/roles`, { role_key }).then(r => r.data),
  removeRole: (userId: string, roleKey: string) =>
    api.delete(`/users/${userId}/roles/${roleKey}`).then(r => r.data),
  listTeams: (userId: string) =>
    api.get(`/users/${userId}/teams`).then(r => r.data as import('identity-web/types').Team[]),
}
