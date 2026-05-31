// M100 P2 — Single sign-on via shared localStorage.
//
// Behind the edge gateway every UI is served from ONE origin, so localStorage
// is shared across path prefixes. The portal owns login and persists the
// session under 'singularity-portal.auth' (zustand-persist shape
// `{ state: { token, user }, version }`). Sub-apps read THAT canonical token
// first and fall back to their own legacy store only when it is absent (e.g.
// the app is opened standalone on its own port during development).
//
// Returns the canonical bearer token, or null so the caller can fall back.
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

// Redirect to the portal's single login page (edge root). Used by route guards
// and 401 handlers so there is exactly one LoginPage across the platform.
export function redirectToPortalLogin(): void {
  if (typeof window === 'undefined') return
  if (window.location.pathname === '/login') return
  window.location.href = '/login'
}
