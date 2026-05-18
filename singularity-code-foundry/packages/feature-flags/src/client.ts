/**
 * M42.0 — Foundry feature-flag client.
 *
 * Queries workgraph-api's /api/admin/feature-flags?key=… (GET requires
 * any authenticated bearer, PUT is admin-only inside the router). Caches
 * each key in-process with a TTL so the Foundry's hot paths don't hit
 * the workgraph-api on every operation.
 *
 * Cache TTL default 30s — short enough that an admin flipping the
 * Operations toggle propagates in well under a minute; long enough that
 * a CLI loop or REST endpoint doesn't hammer the admin DB. The TTL can
 * be tuned per construction for tests.
 */
import { FeatureDisabledError } from './errors'
import { FLAG_PARENTS, type FeatureFlagRecord, type FoundryFlag } from './types'

export interface FeatureFlagsClientOptions {
  /** workgraph-api base URL (e.g. http://workgraph-api:8080). */
  baseUrl: string
  /** Bearer token used for the GET request. Any authenticated user can read. */
  bearerToken: string
  /** Per-key cache TTL in milliseconds. Default 30_000. */
  cacheTtlMs?: number
  /** Optional fetch shim for tests. */
  fetchImpl?: typeof fetch
}

interface CacheEntry {
  enabled: boolean
  loadedAt: number
}

export class FeatureFlagsClient {
  private readonly baseUrl: string
  private readonly bearer: string
  private readonly ttl: number
  private readonly fetchImpl: typeof fetch
  private readonly cache: Map<string, CacheEntry> = new Map()

  constructor(opts: FeatureFlagsClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.bearer = opts.bearerToken
    this.ttl = opts.cacheTtlMs ?? 30_000
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  /**
   * Resolve the effective enabled state of a flag, AND-ing with every
   * ancestor declared in FLAG_PARENTS. Used by both isEnabled() and
   * assertEnabled().
   */
  async isEnabled(flag: FoundryFlag): Promise<boolean> {
    const self = await this.rawEnabled(flag)
    if (!self) return false
    for (const parent of FLAG_PARENTS[flag] ?? []) {
      if (!(await this.rawEnabled(parent))) return false
    }
    return true
  }

  /**
   * Like isEnabled but throws FeatureDisabledError when off. The thrown
   * error carries the specific flag that's off (the flag itself if it's
   * the one disabled, or the ancestor name if a parent is off) so the
   * caller can surface a precise reason.
   */
  async assertEnabled(flag: FoundryFlag): Promise<void> {
    if (!(await this.rawEnabled(flag))) {
      throw new FeatureDisabledError(flag, flag)
    }
    for (const parent of FLAG_PARENTS[flag] ?? []) {
      if (!(await this.rawEnabled(parent))) {
        throw new FeatureDisabledError(flag, parent)
      }
    }
  }

  /** Drop the cache. Useful right after a known toggle so the next
   *  call sees the new value without waiting out the TTL. */
  invalidate(): void {
    this.cache.clear()
  }

  // ─────────────────────────────────────────────────────────────────

  private async rawEnabled(key: string): Promise<boolean> {
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.loadedAt < this.ttl) {
      return cached.enabled
    }
    const url = `${this.baseUrl}/api/admin/feature-flags/${encodeURIComponent(key)}`
    const res = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${this.bearer}` },
    })
    if (res.status === 404) {
      // Unknown key behaves as off — safer default for a kill-switch
      // system. Cache the off state so we don't poll missing keys.
      this.cache.set(key, { enabled: false, loadedAt: Date.now() })
      return false
    }
    if (!res.ok) {
      // Don't cache transient failures — try again next call.
      throw new Error(`feature-flag fetch ${url} returned ${res.status}`)
    }
    const flag = (await res.json()) as FeatureFlagRecord
    this.cache.set(key, { enabled: Boolean(flag.enabled), loadedAt: Date.now() })
    return Boolean(flag.enabled)
  }
}
