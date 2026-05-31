// M100 P2 — Single sign-on via shared localStorage (see the portal).
//
// Behind the edge gateway every UI shares ONE origin, so the portal's persisted
// session (key 'singularity-portal.auth', zustand-persist `{ state: { token } }`)
// is readable here. Read THAT canonical token first; fall back to this app's own
// 'iam-auth' store only standalone. The portal logs in via IAM, so the canonical
// token is already an IAM JWT this admin UI accepts.
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

export function redirectToPortalLogin(): void {
  if (typeof window === 'undefined') return
  if (window.location.pathname === '/login') return
  window.location.href = '/login'
}
