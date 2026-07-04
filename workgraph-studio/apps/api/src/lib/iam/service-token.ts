/**
 * M11 follow-up — IAM service-token bootstrap.
 *
 * Replaces the practice of pasting a 60-minute admin user JWT into
 * `IAM_SERVICE_TOKEN` env. On first call this module:
 *   1. Logs in to IAM with bootstrap credentials (env: IAM_BOOTSTRAP_USERNAME
 *      + IAM_BOOTSTRAP_PASSWORD; admin user only — dev-time secret manager
 *      should hold these in prod).
 *   2. Calls IAM POST /api/v1/auth/service-token with our scopes.
 *   3. Caches the token in process memory until ~24h before expiry, then
 *      auto-refreshes on the next call.
 *
 * Resolution order for a token:
 *   - Explicit `config.IAM_SERVICE_TOKEN` (operator override) — wins,
 *     never refreshed (caller's responsibility).
 *   - Bootstrap creds present → mint and cache.
 *   - Neither → return undefined; callers fall back to whatever they
 *     can do without IAM (typically degraded but not crashing).
 */

import { config } from '../../config'
import { isJsonObject, readUpstreamJsonBody, upstreamSnippet } from '../upstream-json'

const SCOPES = ['read:reference-data', 'read:mcp-servers', 'publish:events']
const SERVICE_NAME = 'workgraph-api'
const REFRESH_BUFFER_HOURS = 24             // refresh when <24h to expiry
const TTL_HOURS            = 24 * 30        // mint with 30-day TTL

interface CachedToken {
  jwt:        string
  expiresAt:  Date
}

let cached:  CachedToken | null = null
let inflight: Promise<string | undefined> | null = null

async function readIamTokenJson(res: Response, source: string): Promise<Record<string, unknown> | null> {
  const body = await readUpstreamJsonBody(res)
  if (!body.raw.trim()) {
    console.warn(`[iam-service-token] ${source} returned an empty response (${res.status})`)
    return null
  }
  if (body.parseError) {
    console.warn(`[iam-service-token] ${source} returned invalid JSON (${res.status}): ${body.parseError}; body=${upstreamSnippet(body.raw, 200)}`)
    return null
  }
  if (isJsonObject(body.data)) return body.data
  console.warn(`[iam-service-token] ${source} returned a non-object JSON response (${res.status})`)
  return null
}

function accessTokenFromBody(body: Record<string, unknown> | null, source: string): string | undefined {
  const token = body?.access_token
  if (typeof token === 'string' && token.trim()) return token
  console.warn(`[iam-service-token] ${source} response did not include access_token`)
  return undefined
}

function decodeExp(jwt: string): Date | null {
  try {
    const parts = jwt.split('.')
    if (parts.length < 2) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null
  } catch { return null }
}

function decodePayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split('.')
    if (parts.length < 2) return null
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>
  } catch { return null }
}

export function configuredTenantIdsForServiceToken(): string[] {
  return [...new Set(
    config.IAM_SERVICE_TOKEN_TENANT_IDS
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
  )].sort()
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

export function validateIamServiceTokenTenantScope(jwt: string | undefined): boolean {
  if (config.TENANT_ISOLATION_MODE !== 'strict') return true
  const required = configuredTenantIdsForServiceToken()
  if (required.length === 0) {
    console.warn('[iam-service-token] TENANT_ISOLATION_MODE=strict requires IAM_SERVICE_TOKEN_TENANT_IDS')
    return false
  }
  const payload = jwt ? decodePayload(jwt) : null
  const rawTenantIds = payload?.tenant_ids
  const actual = Array.isArray(rawTenantIds)
    ? [...new Set(rawTenantIds.filter((value): value is string => typeof value === 'string' && value.trim() !== '').map(value => value.trim()))].sort()
    : []
  if (!sameStringSet(actual, required)) {
    console.warn('[iam-service-token] service token tenant_ids do not match IAM_SERVICE_TOKEN_TENANT_IDS')
    return false
  }
  return true
}

function isFresh(t: CachedToken | null): t is CachedToken {
  if (!t) return false
  const ms = t.expiresAt.getTime() - Date.now()
  return ms > REFRESH_BUFFER_HOURS * 3600 * 1000
}

async function mint(): Promise<string | undefined> {
  if (!config.IAM_BASE_URL) return undefined
  const username = process.env.IAM_BOOTSTRAP_USERNAME
  const password = process.env.IAM_BOOTSTRAP_PASSWORD
  if (!username || !password) {
    console.warn('[iam-service-token] IAM_BOOTSTRAP_USERNAME/PASSWORD not set; cannot auto-mint')
    return undefined
  }
  const base = config.IAM_BASE_URL.replace(/\/$/, '')

  const loginRes = await fetch(`${base}/auth/local/login`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ email: username, password }),
    signal:  AbortSignal.timeout(10_000),
  })
  if (!loginRes.ok) {
    console.warn(`[iam-service-token] bootstrap login failed (${loginRes.status})`)
    return undefined
  }
  const loginBody = await readIamTokenJson(loginRes, 'bootstrap login')
  const userJwt = accessTokenFromBody(loginBody, 'bootstrap login')
  if (!userJwt) return undefined

  const mintRes = await fetch(`${base}/auth/service-token`, {
    method:  'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${userJwt}` },
    body:    JSON.stringify({
      service_name: SERVICE_NAME,
      scopes:       SCOPES,
      tenant_ids:   configuredTenantIdsForServiceToken(),
      ttl_hours:    TTL_HOURS,
    }),
    signal:  AbortSignal.timeout(10_000),
  })
  if (!mintRes.ok) {
    console.warn(`[iam-service-token] mint failed (${mintRes.status}): ${(await mintRes.text()).slice(0, 200)}`)
    return undefined
  }
  const body = await readIamTokenJson(mintRes, 'service-token mint')
  const svcJwt = accessTokenFromBody(body, 'service-token mint')
  if (!svcJwt) return undefined
  if (!validateIamServiceTokenTenantScope(svcJwt)) return undefined

  const exp = decodeExp(svcJwt)
  cached = { jwt: svcJwt, expiresAt: exp ?? new Date(Date.now() + TTL_HOURS * 3600 * 1000) }
  console.log(`[iam-service-token] minted ${SERVICE_NAME} token; expires ${cached.expiresAt.toISOString()}`)
  return svcJwt
}

/**
 * Returns a valid IAM bearer token to use for service-to-service calls.
 * Prefers the explicit env override; otherwise auto-mints + caches.
 * Coalesces concurrent calls via an inflight promise.
 */
export async function getIamServiceToken(): Promise<string | undefined> {
  // Explicit override wins (operator-set, e.g. for one-off testing).
  if (config.IAM_SERVICE_TOKEN) {
    return validateIamServiceTokenTenantScope(config.IAM_SERVICE_TOKEN)
      ? config.IAM_SERVICE_TOKEN
      : undefined
  }
  if (isFresh(cached)) return cached.jwt
  if (inflight) return inflight
  inflight = (async () => {
    try {
      return await mint()
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** Force a refresh on the next `getIamServiceToken()` call. */
export function invalidateIamServiceToken(): void {
  cached = null
}
