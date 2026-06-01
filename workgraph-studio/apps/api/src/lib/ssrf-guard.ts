/**
 * SSRF guard for the workbench API-caller proxy (security review #3).
 *
 * The proxy lets an operator point workgraph-api at the workitem's locally-run
 * service. That makes it a server-side request surface: without guarding, a
 * caller could reach cloud metadata (169.254.169.254), other internal
 * services, or — via DNS — a public hostname that resolves to a private IP.
 *
 * Two layers, both needed:
 *   1. classifyAddress / isBlockedAddress — pure IP classification covering
 *      IPv4, IPv6, IPv4-mapped-IPv6, loopback, RFC1918 private, link-local
 *      (incl. the cloud metadata 169.254.169.254), unique-local, and
 *      unspecified. Used to vet BOTH IP literals in the URL AND every address
 *      the hostname resolves to.
 *   2. resolveTargetAddresses (in the router, async) — actually DNS-resolves
 *      the hostname and requires EVERY resolved address to be private, then
 *      the caller pins the connection to a resolved IP so a rebind between
 *      check and fetch can't swap in a public address (TOCTOU).
 *
 * Intent: the proxy may ONLY reach private/loopback addresses (the operator's
 * local dev service), never the public internet or metadata endpoints.
 */
import net from 'node:net'

export type AddressClass =
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'unique-local'
  | 'unspecified'
  | 'public'

/** Parse a dotted-quad into 4 octets, or null if not a valid IPv4 literal. */
function ipv4Octets(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number, number]
  if (o.some(n => n > 255)) return null
  return o
}

function classifyIpv4(o: [number, number, number, number]): AddressClass {
  const [a, b] = o
  if (a === 0) return 'unspecified'            // 0.0.0.0/8
  if (a === 127) return 'loopback'             // 127.0.0.0/8
  if (a === 10) return 'private'               // 10.0.0.0/8
  if (a === 192 && b === 168) return 'private' // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return 'private' // 172.16.0.0/12
  if (a === 169 && b === 254) return 'link-local'       // 169.254.0.0/16 (incl. 169.254.169.254 metadata)
  if (a === 100 && b >= 64 && b <= 127) return 'private' // 100.64.0.0/10 carrier-grade NAT — treat as internal
  return 'public'
}

/**
 * Classify an IP literal (v4 or v6, including IPv4-mapped-IPv6 like
 * ::ffff:127.0.0.1). Non-IP input returns null.
 */
export function classifyAddress(addr: string): AddressClass | null {
  const raw = addr.trim().replace(/^\[/, '').replace(/\]$/, '') // strip [ ] from bracketed IPv6
  const kind = net.isIP(raw)
  if (kind === 4) return classifyIpv4(ipv4Octets(raw)!)
  if (kind !== 6) return null

  const lower = raw.toLowerCase()
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible — classify by the v4 tail.
  const mapped = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(lower)
  if (mapped) {
    const o = ipv4Octets(mapped[1])
    if (o) return classifyIpv4(o)
  }
  if (lower === '::1') return 'loopback'
  if (lower === '::' || lower === '::0') return 'unspecified'
  if (lower.startsWith('fe80')) return 'link-local'        // fe80::/10
  if (lower.startsWith('fc') || lower.startsWith('fd')) return 'unique-local' // fc00::/7
  return 'public'
}

/** True when an IP literal must NOT be the connect target (it's public, or unclassifiable). */
export function isBlockedAddress(addr: string): boolean {
  const cls = classifyAddress(addr)
  // Unclassifiable (null) is blocked defensively; only the explicitly-internal
  // classes are allowed. link-local is BLOCKED — it covers cloud metadata.
  if (cls === null) return true
  return !(cls === 'loopback' || cls === 'private' || cls === 'unique-local')
}

/**
 * Infra hostnames the proxy is allowed to reach by name (docker-network
 * service names + localhost). These resolve to private addresses inside the
 * compose network; we still DNS-resolve + IP-check them at call time, so this
 * list is a convenience, not the security boundary.
 */
export const ALLOWED_INFRA_HOSTS = new Set([
  'localhost',
  'host.docker.internal',
  'mcp-server-demo',
  'mcp-sandbox-runner',
  'workgraph-api',
  'context-api',
  'audit-governance-service',
  'singularity-mcp-server-demo',
  'singularity-mcp-sandbox-runner',
])

export type UrlCheck =
  | { ok: true; url: URL; host: string; ipLiteral: string | null }
  | { ok: false; reason: string }

/**
 * Synchronous, pure pre-flight: validate protocol, and if the host is an IP
 * literal, classify it immediately (no DNS). Returns the parsed URL + whether
 * the host was an IP literal (so the caller knows whether DNS resolution is
 * still required). Does NOT by itself authorize a hostname — the caller must
 * DNS-resolve non-literal, non-allowlisted hosts and re-check every address.
 */
export function precheckTargetUrl(rawUrl: string): UrlCheck {
  let url: URL
  try { url = new URL(rawUrl) } catch { return { ok: false, reason: 'invalid URL' } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `protocol ${url.protocol} not allowed (http/https only)` }
  }
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!host) return { ok: false, reason: 'missing host' }
  const ipLiteral = net.isIP(host) ? host : null
  if (ipLiteral && isBlockedAddress(ipLiteral)) {
    return { ok: false, reason: `target IP '${ipLiteral}' is not a private/loopback address` }
  }
  return { ok: true, url, host, ipLiteral }
}
