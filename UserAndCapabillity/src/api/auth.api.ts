import { api } from '@/lib/api'
import type { LoginRequest, LoginResponse, AuthUser } from '@/types'

export const authApi = {
  login: (body: LoginRequest) =>
    api.post<LoginResponse>('/auth/local/login', body).then(r => r.data),
  me: () =>
    api.get<AuthUser>('/me').then(r => r.data),
}
