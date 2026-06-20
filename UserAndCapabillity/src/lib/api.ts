import axios from 'axios'
import { sharedAuthToken, redirectToPortalLogin } from './sharedAuth'

// Platform Web proxies IAM through /api/iam. The old Vite app used
// BASE_URL + /api/v1, but in the unified Next shell /identity is a UI route,
// not an API prefix.
const API_BASE = '/api/iam'

export const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use(config => {
  // M100 P2 — canonical portal session first (shared localStorage), then the
  // legacy 'iam-auth' store standalone.
  let token = sharedAuthToken()
  if (!token) {
    const raw = localStorage.getItem('iam-auth')
    if (raw) {
      try {
        const { state } = JSON.parse(raw) as { state: { token: string | null } }
        token = state.token ?? null
      } catch {
        // ignore
      }
    }
  }
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('iam-auth')
      // M100 P2 — one login for the platform: bounce to the portal login.
      redirectToPortalLogin()
    }
    return Promise.reject(err)
  },
)
