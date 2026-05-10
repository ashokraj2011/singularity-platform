/**
 * Singularity IAM web client — used by the Node Inspector pickers (user /
 * team / role / skill / capability) and the Workflows list capability picker.
 *
 * Reads the same bearer token from `useAuthStore` that the workgraph API
 * uses, so when AUTH_PROVIDER=iam the user's IAM-issued token is what flows
 * to IAM as well.
 *
 * Endpoints not yet present in IAM (notably `/skills`) gracefully fall back
 * to an empty list so the UI doesn't crash.
 */

import axios, { type AxiosInstance } from 'axios'
import { useAuthStore } from '../store/auth.store'

const IAM_BASE_URL = (import.meta.env.VITE_IAM_BASE_URL as string | undefined) ?? ''

let client: AxiosInstance | null = null
function iam(): AxiosInstance {
  if (client) return client
  client = axios.create({ baseURL: IAM_BASE_URL })
  client.interceptors.request.use(cfg => {
    const token = useAuthStore.getState().token
    if (token) cfg.headers.Authorization = `Bearer ${token}`
    return cfg
  })
  return client
}

export function isIamConfigured(): boolean {
  return Boolean(IAM_BASE_URL)
}

// ── Types (subset of the IAM SPA's types — kept independent) ─────────────────

export type IamUser = {
  id:            string
  email:         string
  display_name?: string
}

export type IamTeam = {
  id:        string
  team_key?: string
  name:      string
  bu_id?:    string
}

export type IamCapability = {
  id:               string
  capability_id?:   string
  name:             string
  capability_type?: string
  status?:          string
}

export type IamRole = {
  role_key:    string
  name:        string
  role_scope?: 'platform' | 'capability'
}

export type IamSkill = {
  id:        string
  key:       string
  name:      string
  category?: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function unwrapPage<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[]
  if (data && typeof data === 'object' && Array.isArray((data as { data?: unknown[] }).data)) {
    return (data as { data: T[] }).data
  }
  if (data && typeof data === 'object' && Array.isArray((data as { content?: unknown[] }).content)) {
    return (data as { content: T[] }).content
  }
  return []
}

async function safeGet<T>(path: string, params?: Record<string, unknown>): Promise<T[]> {
  if (!isIamConfigured()) return []
  try {
    const res = await iam().get(path, { params })
    return unwrapPage<T>(res.data)
  } catch (err) {
    // 404 means the endpoint isn't there yet (e.g. /skills); treat as empty.
    if (axios.isAxiosError(err) && err.response?.status === 404) return []
    throw err
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function searchUsers(q?: string, page = 0, size = 20): Promise<IamUser[]> {
  return safeGet<IamUser>('/users', { search: q, page, size })
}

export async function listTeams(): Promise<IamTeam[]> {
  return safeGet<IamTeam>('/teams', { page: 0, size: 200 })
}

export async function listCapabilities(type?: string): Promise<IamCapability[]> {
  return safeGet<IamCapability>('/capabilities', { page: 0, size: 200, capability_type: type })
}

export async function listRoles(): Promise<IamRole[]> {
  return safeGet<IamRole>('/roles', { page: 0, size: 200 })
}

export async function listSkills(): Promise<IamSkill[]> {
  return safeGet<IamSkill>('/skills', { page: 0, size: 200 })
}

export async function getCapability(id: string): Promise<IamCapability | null> {
  if (!isIamConfigured()) return null
  try {
    const res = await iam().get(`/capabilities/${encodeURIComponent(id)}`)
    return res.data as IamCapability
  } catch {
    return null
  }
}
