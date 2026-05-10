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

function decodeExp(jwt: string): Date | null {
  try {
    const parts = jwt.split('.')
    if (parts.length < 2) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null
  } catch { return null }
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
  const loginBody = await loginRes.json() as { access_token?: string }
  const userJwt = loginBody.access_token
  if (!userJwt) return undefined

  const mintRes = await fetch(`${base}/auth/service-token`, {
    method:  'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${userJwt}` },
    body:    JSON.stringify({
      service_name: SERVICE_NAME,
      scopes:       SCOPES,
      ttl_hours:    TTL_HOURS,
    }),
    signal:  AbortSignal.timeout(10_000),
  })
  if (!mintRes.ok) {
    console.warn(`[iam-service-token] mint failed (${mintRes.status}): ${(await mintRes.text()).slice(0, 200)}`)
    return undefined
  }
  const body = await mintRes.json() as { access_token?: string }
  const svcJwt = body.access_token
  if (!svcJwt) return undefined

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
  if (config.IAM_SERVICE_TOKEN) return config.IAM_SERVICE_TOKEN
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
