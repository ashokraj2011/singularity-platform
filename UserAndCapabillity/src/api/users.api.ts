import { api } from '@/lib/api'
import type { User, CreateUserRequest, UpdateUserRequest, PageResponse } from '@/types'

export const usersApi = {
  list: (params?: { page?: number; size?: number; search?: string }) =>
    api.get<PageResponse<User>>('/users', { params }).then(r => r.data),
  get: (id: string) =>
    api.get<User>(`/users/${id}`).then(r => r.data),
  create: (body: CreateUserRequest) =>
    api.post<User>('/users', body).then(r => r.data),
  update: (id: string, body: UpdateUserRequest) =>
    api.patch<User>(`/users/${id}`, body).then(r => r.data),
}
