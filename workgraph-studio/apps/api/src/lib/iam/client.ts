/**
 * Singularity IAM HTTP client.
 *
 * Used by the auth middleware to verify bearer tokens, by the permission
 * helpers to perform authz checks, and by the assignment routing to resolve
 * users on a team / capability / by skill.
 *
 * Two authentication modes when calling IAM:
 *   - Per-request: pass the user's bearer token (used for `/me`-style calls
 *     so IAM enforces its own authz on the lookup).
 *   - Service-to-service: when no user token is available, fall back to the
 *     long-lived `IAM_SERVICE_TOKEN`.
 */

import { config } from '../../config'

// ── Types mirroring IAM's SPA types (kept independent so we can adjust) ──────

export type IamUser = {
  id:               string
  email:            string
  display_name?:    string
  is_super_admin?:  boolean
}

export type IamTeamMember = {
  user_id:          string
  team_id:          string
  membership_type?: string
}

export type IamCapabilityMember = {
  user_id?:         string
  team_id?:         string
  capability_id:    string
  role_id?:         string
  role_key?:        string
  valid_from?:      string
  valid_until?:     string | null
}

export type IamAuthzCheckResponse = {
  allowed:          boolean
  reason?:          string
  roles?:           string[]
  permissions?:     string[]
  source?:          string
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class IamUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'IamUnavailableError' }
}
export class IamUnauthorizedError extends Error {
  constructor(message = 'IAM rejected the bearer token') { super(message); this.name = 'IamUnauthorizedError' }
}

// ── Tiny TTL cache (single-process, no external deps) ────────────────────────

type CacheEntry<T> = { value: T; expiresAt: number }
const verifyCache = new Map<string, CacheEntry<IamUser>>()

function cacheGet(token: string): IamUser | undefined {
  const entry = verifyCache.get(token)
  if (!entry) return undefined
  if (entry.expiresAt < Date.now()) {
    verifyCache.delete(token)
    return undefined
  }
  return entry.value
}

function cacheSet(token: string, user: IamUser, ttlSeconds: number): void {
  verifyCache.set(token, { value: user, expiresAt: Date.now() + ttlSeconds * 1000 })
}

export function clearIamVerifyCache(token?: string): void {
  if (token) verifyCache.delete(token)
  else verifyCache.clear()
}

// ── Internal fetch helper ────────────────────────────────────────────────────

async function iamFetch(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<Response> {
  if (!config.IAM_BASE_URL) {
    throw new IamUnavailableError('IAM_BASE_URL is not configured')
  }
  const url = `${config.IAM_BASE_URL.replace(/\/+$/, '')}${path}`
  // M11 follow-up — fall back to auto-minted service token instead of the
  // expiring user JWT in IAM_SERVICE_TOKEN env. Lazy import to avoid a cycle.
  let token = init.token
  if (!token) {
    try {
      const { getIamServiceToken } = await import('./service-token.js')
      token = await getIamServiceToken()
    } catch { /* fall through to undefined */ }
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  }
  let res: Response
  try {
    res = await fetch(url, { ...init, headers })
  } catch (err) {
    throw new IamUnavailableError(`IAM call failed (${path}): ${(err as Error).message}`)
  }
  return res
}

// ── M10 — federated lookup proxy ─────────────────────────────────────────────

/**
 * GET an IAM endpoint with the caller's bearer token forwarded. Returns the
 * parsed JSON body on 2xx, throws IamUnavailableError on 5xx/network and
 * IamUnauthorizedError on 401/403. No caching — federate-live model.
 */
export async function proxyGet(
  path: string,
  query: Record<string, string | number | undefined>,
  callerToken: string | undefined,
): Promise<unknown> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') qs.set(k, String(v))
  }
  const fullPath = qs.toString() ? `${path}?${qs.toString()}` : path
  const res = await iamFetch(fullPath, { method: 'GET', token: callerToken })
  const text = await res.text()
  let body: unknown
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (res.status === 401 || res.status === 403) {
    throw new IamUnauthorizedError(`IAM denied request to ${path} (${res.status})`)
  }
  if (res.status === 404) {
    // Not-found is normal for resolver lookups; return null so callers can
    // distinguish "not present" from "upstream broken".
    return null
  }
  if (!res.ok) {
    throw new IamUnavailableError(`IAM ${res.status} on ${path}: ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`)
  }
  return body
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Verify a bearer token by calling IAM. Tries `/auth/verify` first (preferred);
 * falls back to `GET /me` with the bearer when the introspection endpoint
 * isn't deployed yet.  Returns the IAM user on success; throws on invalid.
 *
 * Result is cached per token for `IAM_VERIFY_CACHE_TTL` seconds.
 */
export async function verifyToken(token: string): Promise<IamUser> {
  const cached = cacheGet(token)
  if (cached) return cached

  // Preferred path: dedicated introspection endpoint
  let res = await iamFetch('/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ token }),
    token: config.IAM_SERVICE_TOKEN,
  }).catch(() => null)

  if (res && res.ok) {
    const body = await res.json() as { valid?: boolean; user?: IamUser; reason?: string }
    if (!body.valid || !body.user) throw new IamUnauthorizedError(body.reason ?? 'Token rejected by IAM')
    cacheSet(token, body.user, config.IAM_VERIFY_CACHE_TTL)
    return body.user
  }

  // Fallback: bounce through `/me` using the user's own token
  res = await iamFetch('/me', { method: 'GET', token })
  if (res.status === 401 || res.status === 403) {
    throw new IamUnauthorizedError(`IAM rejected token (${res.status})`)
  }
  if (!res.ok) {
    throw new IamUnavailableError(`IAM /me returned ${res.status}`)
  }
  const user = await res.json() as IamUser
  cacheSet(token, user, config.IAM_VERIFY_CACHE_TTL)
  return user
}

export async function getUser(userId: string, callerToken?: string): Promise<IamUser> {
  const res = await iamFetch(`/users/${encodeURIComponent(userId)}`, { token: callerToken })
  if (!res.ok) throw new IamUnavailableError(`IAM /users/${userId} → ${res.status}`)
  return res.json() as any
}

export async function getTeamMembers(teamId: string, callerToken?: string): Promise<IamTeamMember[]> {
  const res = await iamFetch(`/teams/${encodeURIComponent(teamId)}/members`, { token: callerToken })
  if (!res.ok) throw new IamUnavailableError(`IAM /teams/${teamId}/members → ${res.status}`)
  return res.json() as any
}

export async function getCapabilityMembers(capabilityId: string, callerToken?: string): Promise<IamCapabilityMember[]> {
  const res = await iamFetch(`/capabilities/${encodeURIComponent(capabilityId)}/members`, { token: callerToken })
  if (!res.ok) throw new IamUnavailableError(`IAM /capabilities/${capabilityId}/members → ${res.status}`)
  return res.json() as any
}

/**
 * Resolve users with a given skill key.  IAM doesn't yet model skills natively
 * — when the endpoint is missing, this falls back to an empty list and the
 * caller can still drop back to local Skill data via `prisma.userSkill`.
 */
export async function getUsersBySkill(skillKey: string, callerToken?: string): Promise<IamUser[]> {
  const res = await iamFetch(`/skills/${encodeURIComponent(skillKey)}/users`, { token: callerToken }).catch(() => null)
  if (!res || res.status === 404) return []
  if (!res.ok) throw new IamUnavailableError(`IAM /skills/${skillKey}/users → ${res.status}`)
  return res.json() as any
}

// ── Per-user lookups (with TTL cache for inbox-style hot paths) ──────────────

type CachedList<T> = { value: T[]; expiresAt: number }
const userTeamsCache  = new Map<string, CachedList<string>>()
const userSkillsCache = new Map<string, CachedList<string>>()

function getCached<T>(map: Map<string, CachedList<T>>, key: string): T[] | undefined {
  const entry = map.get(key)
  if (!entry) return undefined
  if (entry.expiresAt < Date.now()) { map.delete(key); return undefined }
  return entry.value
}

function setCached<T>(map: Map<string, CachedList<T>>, key: string, value: T[]): void {
  map.set(key, { value, expiresAt: Date.now() + (config.IAM_VERIFY_CACHE_TTL * 1000) })
}

export function clearIamUserCache(userId?: string): void {
  if (userId) {
    userTeamsCache.delete(userId)
    userSkillsCache.delete(userId)
  } else {
    userTeamsCache.clear()
    userSkillsCache.clear()
  }
}

/**
 * Team ids the user belongs to.  Tries `/users/:id/teams` first; falls back to
 * `/users/:id/memberships` (some IAM builds expose either name).  Returns an
 * empty array when neither endpoint exists — caller decides what to do then.
 */
export async function getUserTeams(userId: string, callerToken?: string): Promise<string[]> {
  const cached = getCached(userTeamsCache, userId)
  if (cached) return cached

  for (const path of [`/users/${encodeURIComponent(userId)}/teams`, `/users/${encodeURIComponent(userId)}/memberships`]) {
    const res = await iamFetch(path, { token: callerToken }).catch(() => null)
    if (!res) continue
    if (res.status === 404) continue
    if (!res.ok) throw new IamUnavailableError(`IAM ${path} → ${res.status}`)
    const data = await res.json() as any
    // Accept either [{ id, ... }] or [{ team_id, ... }] or { data: [...] }
    const arr: any[] = Array.isArray(data) ? data
                    : Array.isArray(data?.data) ? data.data
                    : Array.isArray(data?.content) ? data.content
                    : []
    const ids = arr
      .map(x => typeof x?.team_id === 'string' ? x.team_id : (typeof x?.id === 'string' ? x.id : null))
      .filter((s): s is string => !!s)
    setCached(userTeamsCache, userId, ids)
    return ids
  }

  // Endpoint missing — cache empty so we don't keep hammering 404s.
  setCached(userTeamsCache, userId, [])
  return []
}

/**
 * Skill keys the user holds.  Tries `/users/:id/skills`.  Returns empty when
 * IAM doesn't expose the endpoint (Skill model not yet shipped on IAM side).
 */
export async function getUserSkills(userId: string, callerToken?: string): Promise<string[]> {
  const cached = getCached(userSkillsCache, userId)
  if (cached) return cached

  const res = await iamFetch(`/users/${encodeURIComponent(userId)}/skills`, { token: callerToken }).catch(() => null)
  if (!res || res.status === 404) {
    setCached(userSkillsCache, userId, [])
    return []
  }
  if (!res.ok) throw new IamUnavailableError(`IAM /users/${userId}/skills → ${res.status}`)
  const data = await res.json() as any
  const arr: any[] = Array.isArray(data) ? data
                  : Array.isArray(data?.data) ? data.data
                  : Array.isArray(data?.content) ? data.content
                  : []
  // Accept either { key } or { skill_key } or { skill: { key } }
  const keys = arr
    .map(x => typeof x?.key === 'string' ? x.key
            : typeof x?.skill_key === 'string' ? x.skill_key
            : typeof x?.skill?.key === 'string' ? x.skill.key
            : null)
    .filter((s): s is string => !!s)
  setCached(userSkillsCache, userId, keys)
  return keys
}

/**
 * IAM authz check.  Returns false on any non-2xx (fail-closed).
 */
export async function authzCheck(
  userId: string,
  capabilityId: string,
  action: string,
  resource?: { resourceType?: string; resourceId?: string },
  callerToken?: string,
): Promise<IamAuthzCheckResponse> {
  const res = await iamFetch('/authz/check', {
    method: 'POST',
    body: JSON.stringify({
      user_id: userId,
      capability_id: capabilityId,
      action,
      resource_type: resource?.resourceType,
      resource_id: resource?.resourceId,
    }),
    token: callerToken,
  })
  if (!res.ok) return { allowed: false, reason: `authz/check returned ${res.status}` }
  return res.json() as any
}

// ── Capability cache helpers (refreshes the local capabilities_cache row) ────

import { prisma } from '../prisma'

export type CapabilityCacheRow = {
  id:     string
  name:   string
  type:   string | null
  status: string | null
}

export async function getCapability(capabilityId: string, callerToken?: string): Promise<CapabilityCacheRow | null> {
  // Try local cache first
  const cached = await prisma.capability.findUnique({ where: { id: capabilityId } }).catch(() => null)
  if (cached) {
    return { id: cached.id, name: cached.name, type: cached.type, status: cached.status }
  }
  // Pull from IAM
  const res = await iamFetch(`/capabilities/${encodeURIComponent(capabilityId)}`, { token: callerToken }).catch(() => null)
  if (!res || !res.ok) return null
  const cap = await res.json() as { id: string; name: string; capability_type?: string; status?: string }
  // Upsert into cache
  try {
    const upserted = await prisma.capability.upsert({
      where:  { id: cap.id },
      create: { id: cap.id, name: cap.name, type: cap.capability_type ?? null, status: cap.status ?? null },
      update: { name: cap.name, type: cap.capability_type ?? null, status: cap.status ?? null, syncedAt: new Date() },
    })
    return { id: upserted.id, name: upserted.name, type: upserted.type, status: upserted.status }
  } catch {
    // Cache table may not exist yet (added in Phase B migration). Return live.
    return { id: cap.id, name: cap.name, type: cap.capability_type ?? null, status: cap.status ?? null }
  }
}
