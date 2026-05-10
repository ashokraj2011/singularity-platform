/**
 * M11.a — self-register with the platform-registry on startup, then send a
 * heartbeat every minute so `last_seen_at` stays fresh.
 *
 * No external dependency: just `fetch`. If `PLATFORM_REGISTRY_URL` is unset
 * or the registry is unreachable, this becomes a no-op so workgraph still
 * starts cleanly when running standalone (e.g. unit tests, sandbox dev).
 */

export interface RegisterPayload {
  service_name:  string
  display_name:  string
  version:       string
  base_url:      string
  internal_url?: string
  health_path?:  string
  auth_mode:     'none' | 'bearer-iam' | 'bearer-static' | 'mtls'
  owner_team?:   string
  metadata?:     Record<string, unknown>
  capabilities?: Array<{ capability_key: string; description?: string; metadata?: Record<string, unknown> }>
  contracts?:    Array<{
    kind: 'openapi' | 'tool-schema' | 'event-contract' | 'workflow-node-contract'
    contract_key: string
    version: string
    source_url: string
    sha256?: string
    metadata?: Record<string, unknown>
  }>
}

export interface RegisterOptions {
  registryUrl?:      string                 // defaults to env PLATFORM_REGISTRY_URL
  registerToken?:    string                 // optional bearer if registry requires it
  heartbeatSeconds?: number                 // defaults to 60
  log?:              (msg: string) => void  // defaults to console.log
}

let heartbeatTimer: NodeJS.Timeout | null = null

export function startSelfRegistration(payload: RegisterPayload, opts: RegisterOptions = {}): void {
  const url   = (opts.registryUrl   ?? process.env.PLATFORM_REGISTRY_URL ?? '').replace(/\/+$/, '')
  const token = opts.registerToken ?? process.env.PLATFORM_REGISTER_TOKEN
  const log   = opts.log ?? ((m) => console.log(`[platform-registry] ${m}`))
  if (!url) {
    log('PLATFORM_REGISTRY_URL not set; self-registration disabled')
    return
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`

  const register = async (): Promise<void> => {
    try {
      const res = await fetch(`${url}/api/v1/register`, {
        method:  'POST',
        headers,
        body:    JSON.stringify(payload),
        signal:  AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        log(`register POST failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
      }
    } catch (err) {
      log(`register POST errored: ${(err as Error).message}`)
    }
  }

  const heartbeat = async (): Promise<void> => {
    try {
      await fetch(`${url}/api/v1/services/${encodeURIComponent(payload.service_name)}/heartbeat`, {
        method:  'POST',
        headers,
        signal:  AbortSignal.timeout(3000),
      })
    } catch {
      // heartbeat failures are silent — registry liveness is not on the hot path
    }
  }

  // Fire initial register, then heartbeat every N seconds.
  void register()
  const intervalSec = opts.heartbeatSeconds ?? 60
  heartbeatTimer = setInterval(() => { void heartbeat() }, intervalSec * 1000)
  if (heartbeatTimer.unref) heartbeatTimer.unref()
}

export function stopSelfRegistration(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
}
