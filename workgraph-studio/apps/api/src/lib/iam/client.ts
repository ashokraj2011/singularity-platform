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
import { readUpstreamJsonBody, upstreamSnippet } from '../upstream-json'

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

type IamBody = {
  value: unknown
  text: string
  parseError?: string
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
  // NOTE: extensionless specifier — tsconfig is CommonJS/node resolution, so
  // a literal `.js` specifier fails to resolve to the `.ts` source in the dev
  // runtime, silently breaking ALL service-token auto-mint (every runtime IAM
  // call then 401s). Keep it extensionless so it resolves in dev + build.
  let token = init.token
  if (!token) {
    try {
      const { getIamServiceToken } = await import('./service-token')
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

async function readIamBody(res: Response): Promise<IamBody> {
  const body = await readUpstreamJsonBody(res)
  return { value: body.data, text: body.raw, parseError: body.parseError }
}

function iamBodyPreview(body: IamBody): string {
  if (typeof body.value === 'string') return upstreamSnippet(body.value, 200)
  try {
    return upstreamSnippet(JSON.stringify(body.value), 200)
  } catch {
    return upstreamSnippet(body.text, 200)
  }
}

async function readIamJson<T>(res: Response, path: string): Promise<T> {
  const body = await readIamBody(res)
  if (body.parseError) {
    throw new IamUnavailableError(`IAM ${path} returned invalid JSON (${res.status}): ${iamBodyPreview(body)}`)
  }
  return body.value as T
}

async function iamResponseError(res: Response, path: string): Promise<string> {
  const body = await readIamBody(res)
  return `IAM ${path} -> ${res.status}: ${iamBodyPreview(body)}`
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
  const body = await readIamBody(res)
  if (res.status === 401 || res.status === 403) {
    throw new IamUnauthorizedError(`IAM denied request to ${path} (${res.status})`)
  }
  if (res.status === 404) {
    // Not-found is normal for resolver lookups; return null so callers can
    // distinguish "not present" from "upstream broken".
    return null
  }
  if (!res.ok) {
    throw new IamUnavailableError(`IAM ${res.status} on ${path}: ${iamBodyPreview(body)}`)
  }
  if (body.parseError) {
    throw new IamUnavailableError(`IAM ${path} returned invalid JSON (${res.status}): ${iamBodyPreview(body)}`)
  }
  return body.value
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
    const body = await readIamJson<{ valid?: boolean; user?: IamUser; reason?: string }>(res, '/auth/verify')
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
  const user = await readIamJson<IamUser>(res, '/me')
  cacheSet(token, user, config.IAM_VERIFY_CACHE_TTL)
  return user
}

export async function getUser(userId: string, callerToken?: string): Promise<IamUser> {
  const res = await iamFetch(`/users/${encodeURIComponent(userId)}`, { token: callerToken })
  if (!res.ok) throw new IamUnavailableError(`IAM /users/${userId} → ${res.status}`)
  return readIamJson<IamUser>(res, `/users/${userId}`)
}

export async function getTeamMembers(teamId: string, callerToken?: string): Promise<IamTeamMember[]> {
  const res = await iamFetch(`/teams/${encodeURIComponent(teamId)}/members`, { token: callerToken })
  if (!res.ok) throw new IamUnavailableError(`IAM /teams/${teamId}/members → ${res.status}`)
  return readIamJson<IamTeamMember[]>(res, `/teams/${teamId}/members`)
}

export async function getCapabilityMembers(capabilityId: string, callerToken?: string): Promise<IamCapabilityMember[]> {
  const res = await iamFetch(`/capabilities/${encodeURIComponent(capabilityId)}/members`, { token: callerToken })
  if (!res.ok) throw new IamUnavailableError(`IAM /capabilities/${capabilityId}/members → ${res.status}`)
  return readIamJson<IamCapabilityMember[]>(res, `/capabilities/${capabilityId}/members`)
}

export interface IamCapabilityRelationship {
  source_capability_id: string
  target_capability_id: string
  relationship_type: string
  inheritance_policy?: string
  metadata?: Record<string, unknown>
}

/**
 * M101 (Epic→child) — capability-relationship graph for dynamic child
 * discovery. Returns rows where `capabilityId` is the SOURCE (IAM
 * GET /capabilities/:id/relationships). The Epic workflow filters by
 * `relationship_type` (a convention, e.g. 'decomposes_to') to resolve its
 * child capabilities. A missing endpoint / no relationships yields an empty
 * list so callers can fall back to statically-declared targets. Uses the
 * auto-minted IAM service token when no caller token is supplied (the
 * workflow-runtime path has no user token).
 */
export async function listCapabilityRelationships(
  capabilityId: string,
  callerToken?: string,
): Promise<IamCapabilityRelationship[]> {
  const res = await iamFetch(`/capabilities/${encodeURIComponent(capabilityId)}/relationships`, { token: callerToken }).catch(() => null)
  if (!res || res.status === 404) return []
  if (!res.ok) throw new IamUnavailableError(`IAM /capabilities/${capabilityId}/relationships → ${res.status}`)
  return readIamJson<IamCapabilityRelationship[]>(res, `/capabilities/${capabilityId}/relationships`)
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
  return readIamJson<IamUser[]>(res, `/skills/${skillKey}/users`)
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
    const data = await readIamJson<any>(res, path)
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
  const data = await readIamJson<any>(res, `/users/${userId}/skills`)
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
  try {
    return await readIamJson<IamAuthzCheckResponse>(res, '/authz/check')
  } catch (err) {
    return { allowed: false, reason: err instanceof Error ? err.message : 'authz/check returned invalid JSON' }
  }
}

// ── Capability cache helpers (refreshes the local capabilities_cache row) ────

import { prisma } from '../prisma'

export type CapabilityCacheRow = {
  id:     string
  name:   string
  type:   string | null
  status: string | null
  isGoverning?: boolean
}

export async function getCapability(capabilityId: string, callerToken?: string): Promise<CapabilityCacheRow | null> {
  // Try local cache first
  const cached = await prisma.capability.findUnique({ where: { id: capabilityId } }).catch(() => null)
  if (cached) {
    return { id: cached.id, name: cached.name, type: cached.type, status: cached.status, isGoverning: cached.isGoverning }
  }
  // Pull from IAM
  const res = await iamFetch(`/capabilities/${encodeURIComponent(capabilityId)}`, { token: callerToken }).catch(() => null)
  if (!res || !res.ok) return null
  const cap = await readIamJson<{ id: string; name: string; capability_type?: string; status?: string; is_governing?: boolean }>(
    res,
    `/capabilities/${capabilityId}`,
  ).catch(() => null)
  if (!cap?.id || !cap.name) return null
  const isGov = Boolean(cap.is_governing)
  // Upsert into cache
  try {
    const upserted = await prisma.capability.upsert({
      where:  { id: cap.id },
      create: { id: cap.id, name: cap.name, type: cap.capability_type ?? null, status: cap.status ?? null, isGoverning: isGov },
      update: { name: cap.name, type: cap.capability_type ?? null, status: cap.status ?? null, isGoverning: isGov, syncedAt: new Date() },
    })
    return { id: upserted.id, name: upserted.name, type: upserted.type, status: upserted.status, isGoverning: upserted.isGoverning }
  } catch {
    // Cache table may not exist yet (added in Phase B migration). Return live.
    return { id: cap.id, name: cap.name, type: cap.capability_type ?? null, status: cap.status ?? null, isGoverning: isGov }
  }
}

// ── Capability Governance Model (G2) ─────────────────────────────────────────

export interface GovernanceResolveContext {
  capability_id: string            // governed operational capability
  work_item_type?: string
  workflow_type?: string
  workflow_id?: string
  stage_key?: string
  agent_role?: string
  node_id?: string
  risk_level?: string
}

/**
 * Resolve the governance overlay for a (capability, run, stage) context by
 * calling IAM `POST /governance/resolve`. Returns the resolved overlay (the
 * `data` block) or null when IAM is unreachable / has no governance. Uses the
 * auto-minted service token on the runtime path (no user token).
 */
export async function resolveGovernance(
  ctx: GovernanceResolveContext,
  callerToken?: string,
): Promise<Record<string, unknown> | null> {
  const res = await iamFetch('/governance/resolve', {
    method: 'POST', body: JSON.stringify(ctx), token: callerToken,
  }).catch(() => null)
  if (!res || !res.ok) return null
  const body = await readIamJson<{ success?: boolean; data?: Record<string, unknown> }>(res, '/governance/resolve').catch(() => null)
  return body?.data ?? null
}

/**
 * Whether a capability plays a GOVERNING role (architecture board, compliance,
 * standards group). Governing capabilities govern work; they never receive
 * delivery work — the routing guard uses this to exclude them from targets.
 * Cache-first; falls back to IAM. FAIL-OPEN (returns false) on any error so a
 * governance lookup can never block legitimate delivery routing.
 */
export async function isCapabilityGoverning(capabilityId: string, callerToken?: string): Promise<boolean> {
  try {
    const cap = await getCapability(capabilityId, callerToken)
    return Boolean(cap?.isGoverning)
  } catch {
    return false
  }
}

// ── Capability Governance Model (G7a/G8) — governed-by attachment mutations ──
// Used by the G8 stage-governance reconciler. The service token must carry the
// `governance:author` scope for ADVISORY (and `governance:enforce` for
// REQUIRED/BLOCKING) — see IAM app/governance/authz.py.

export interface IamGovernanceAttachment {
  id: string
  capability_id: string
  governing_capability_id: string
  mode: string
  scope: string
  target_kind?: string | null
  target_key?: string | null
  priority: number
  is_active: boolean
  version: number
  contributions?: Record<string, unknown>
}

export interface AttachGovernedByBody {
  governing_capability_id: string
  mode?: string
  scope?: string
  target_kind?: string | null
  target_key?: string | null
  priority?: number
  waiver_allowed?: boolean
  contributions?: Record<string, unknown>
}

export async function listGovernedByAttachments(
  capabilityId: string, includeInactive = false, callerToken?: string,
): Promise<IamGovernanceAttachment[]> {
  const qs = includeInactive ? '?include_inactive=true' : ''
  const res = await iamFetch(`/capabilities/${encodeURIComponent(capabilityId)}/governed-by${qs}`, { token: callerToken }).catch(() => null)
  if (!res || res.status === 404) return []
  if (!res.ok) throw new IamUnavailableError(`IAM governed-by list → ${res.status}`)
  return readIamJson<IamGovernanceAttachment[]>(res, `/capabilities/${capabilityId}/governed-by${qs}`)
}

export async function attachGovernedBy(
  capabilityId: string, body: AttachGovernedByBody, callerToken?: string,
): Promise<IamGovernanceAttachment> {
  const res = await iamFetch(`/capabilities/${encodeURIComponent(capabilityId)}/governed-by`, {
    method: 'POST', body: JSON.stringify(body), token: callerToken,
  })
  if (!res.ok) throw new IamUnavailableError(await iamResponseError(res, 'attach governed-by'))
  return readIamJson<IamGovernanceAttachment>(res, `/capabilities/${capabilityId}/governed-by`)
}

export async function patchGovernanceAttachment(
  capabilityId: string, attachmentId: string, body: Partial<AttachGovernedByBody>, callerToken?: string,
): Promise<IamGovernanceAttachment> {
  const res = await iamFetch(`/capabilities/${encodeURIComponent(capabilityId)}/governed-by/${encodeURIComponent(attachmentId)}`, {
    method: 'PATCH', body: JSON.stringify(body), token: callerToken,
  })
  if (!res.ok) throw new IamUnavailableError(await iamResponseError(res, 'patch governed-by'))
  return readIamJson<IamGovernanceAttachment>(res, `/capabilities/${capabilityId}/governed-by/${attachmentId}`)
}

export async function deactivateGovernanceAttachment(
  capabilityId: string, attachmentId: string, callerToken?: string,
): Promise<void> {
  const res = await iamFetch(`/capabilities/${encodeURIComponent(capabilityId)}/governed-by/${encodeURIComponent(attachmentId)}/deactivate`, {
    method: 'POST', token: callerToken,
  })
  if (!res.ok) throw new IamUnavailableError(`IAM deactivate governed-by → ${res.status}`)
}
