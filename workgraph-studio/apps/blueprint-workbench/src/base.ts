// M100 P1 — base-relative URL prefixes for the single-origin edge gateway.
//
// import.meta.env.BASE_URL is the Vite `base` (always trailing-slashed): '/'
// standalone, '/workbench/' behind the gateway. We strip the trailing slash so
// these read cleanly as '/api' / '/audit-gov' standalone and
// '/workbench/api' / '/workbench/audit-gov' under the gateway. The edge strips
// the '/workbench' prefix before proxying, so the workbench's own nginx
// `location /api/` and `location /audit-gov/` blocks handle them unchanged.
const PREFIX = import.meta.env.BASE_URL.replace(/\/$/, '')

export const API_BASE = `${PREFIX}/api`
export const AUDIT_GOV_BASE = `${PREFIX}/audit-gov`

// M100 P2 — single sign-on: read the canonical portal session first (shared
// localStorage under one origin), so navigating from the portal carries the
// session with no re-login. Falls back to null → caller uses its legacy store.
export function sharedAuthToken(): string | null {
  try {
    const raw = localStorage.getItem('singularity-portal.auth')
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state?: { token?: string | null } }
    return parsed.state?.token ?? null
  } catch {
    return null
  }
}
