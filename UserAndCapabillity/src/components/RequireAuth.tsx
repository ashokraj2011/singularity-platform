import { useEffect } from 'react'
import { useAuthStore } from '@/store/auth.store'
import { sharedAuthToken, redirectToPortalLogin } from '@/lib/sharedAuth'

export function RequireAuth({ children }: { children: React.ReactNode }) {
  // M100 P2 — prefer the canonical portal session (shared localStorage under
  // the single origin); fall back to this app's store standalone.
  const storeToken = useAuthStore(s => s.token)
  const token = sharedAuthToken() ?? storeToken
  useEffect(() => {
    // Absolute redirect (not <Navigate>) so under the edge gateway we land on
    // the portal '/login' at the origin root, not the basename-prefixed path.
    if (!token) redirectToPortalLogin()
  }, [token])
  if (!token) return null
  return <>{children}</>
}
