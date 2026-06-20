import { api } from 'identity-web/lib/api'
import type { LoginRequest, LoginResponse, AuthUser } from 'identity-web/types'

export const authApi = {
  login: (body: LoginRequest) =>
    api.post<LoginResponse>('/auth/local/login', body).then(r => r.data),
  me: () =>
    api.get<AuthUser>('/me').then(r => r.data),
}
