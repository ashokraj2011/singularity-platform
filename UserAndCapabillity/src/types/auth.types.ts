export interface LoginRequest {
  email: string
  password: string
}

export interface LoginResponse {
  access_token: string
  token_type: string
  user: AuthUser
}

export interface AuthUser {
  id: string
  email: string
  display_name?: string
  is_super_admin: boolean
}
