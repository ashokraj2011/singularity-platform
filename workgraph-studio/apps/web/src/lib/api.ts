import axios from 'axios'
import { useAuthStore } from '../store/auth.store'
import { sharedAuthToken, redirectToPortalLogin } from './sharedAuth'

// M100 P1 — base-relative API path so that under the single-origin edge
// gateway (base e.g. '/workflow/') calls go to '/workflow/api' and route to
// this app's backend; standalone (base '/') stays '/api'. import.meta.env
// .BASE_URL always ends with '/'.
const API_BASE = `${import.meta.env.BASE_URL}api`.replace(/\/{2,}/g, '/')

export const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use(config => {
  // M100 P2 — read the canonical portal session first (single origin ⇒ shared
  // localStorage), fall back to this app's legacy 'workgraph-auth' store.
  const token = sharedAuthToken() ?? useAuthStore.getState().token
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      useAuthStore.getState().logout()
      // M100 P2 — one login for the platform: bounce to the portal login.
      redirectToPortalLogin()
    }
    return Promise.reject(err)
  },
)
