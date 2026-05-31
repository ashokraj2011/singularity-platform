import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { AlertCircle, Loader2, ExternalLink, KeyRound, ShieldCheck } from 'lucide-react'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/auth.store'
import { useActiveContextStore, type Membership } from '../../store/activeContext.store'

const AUTH_PROVIDER  = (import.meta.env.VITE_AUTH_PROVIDER ?? 'iam') as 'local' | 'iam'
// M100 P3 — same-origin under the edge gateway (was :5175). Note: under the
// single origin, RequireAuth bounces unauthenticated users to the portal /login
// before this standalone page is reached; this default just avoids a dead :5175.
const IAM_LOGIN_URL  = import.meta.env.VITE_IAM_LOGIN_URL  ?? '/iam/login'

// Local-dev shortcut support. When VITE_PSEUDO_IAM_URL is set, this can still
// point at pseudo-IAM; otherwise the default follows the current compose stack's
// real IAM service on :8100 so the primary button does not dead-end.
const PSEUDO_IAM_URL    = import.meta.env.VITE_PSEUDO_IAM_URL    ?? 'http://localhost:8100/api/v1'
const AUTO_LOGIN        = (import.meta.env.VITE_AUTO_LOGIN     ?? '0') !== '0'
const PSEUDO_LOGIN_EMAIL = import.meta.env.VITE_PSEUDO_LOGIN_EMAIL ?? 'admin@singularity.local'
const PSEUDO_LOGIN_PASSWORD = import.meta.env.VITE_PSEUDO_LOGIN_PASSWORD ?? 'Admin1234!'

async function fetchMemberships(token: string): Promise<Membership[]> {
  try {
    const res = await api.get('/lookup/me/memberships', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = res.data as unknown
    if (Array.isArray(data)) return data as Membership[]
    if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown[] }).items)) {
      return (data as { items: Membership[] }).items
    }
  } catch {
    // Fall back to pseudo IAM for local smoke tests where the Workgraph proxy
    // may not be pointed at pseudo mode yet.
    try {
      const res = await fetch(`${PSEUDO_IAM_URL.replace(/\/$/, '')}/me/memberships`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!res.ok) return []
      return await res.json() as Membership[]
    } catch {
      return []
    }
  }
  return []
}

async function verifyWorkgraphToken(token: string) {
  const res = await api.get('/auth/me', { headers: { Authorization: `Bearer ${token}` } })
  return {
    id: res.data.id,
    email: res.data.email,
    displayName: res.data.displayName,
    teamId: res.data.teamId,
    roles: res.data.roles?.map((r: { name: string }) => r.name) ?? [],
  }
}

export function LoginPage() {
  const navigate = useNavigate()
  const setAuth = useAuthStore(s => s.setAuth)
  const setMemberships = useActiveContextStore(s => s.setMemberships)
  const clearContext = useActiveContextStore(s => s.clear)

  // Local-mode form state
  const [email, setEmail]       = useState('admin@workgraph.local')
  const [password, setPassword] = useState('admin123')
  // IAM-mode form state
  const [iamEmail, setIamEmail]       = useState('admin@singularity.local')
  const [iamPassword, setIamPassword] = useState('Admin1234!')

  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(false)

  // Tab UI: 'local' (legacy) vs 'iam'.  Default to whichever the env says.
  const [tab, setTab] = useState<'local' | 'iam'>(AUTH_PROVIDER)

  async function completeLogin(token: string, user: Awaited<ReturnType<typeof verifyWorkgraphToken>>) {
    setAuth(token, user)
    clearContext()
    const ms = await fetchMemberships(token)
    setMemberships(ms)
    navigate(ms.length > 0 ? '/context-picker' : '/dashboard')
  }

  // M12 — one-click sign in for local development. It talks to whichever IAM
  // endpoint is configured above and then verifies the token with Workgraph.
  async function pseudoLogin() {
    setError(''); setLoading(true)
    try {
      const res = await fetch(`${PSEUDO_IAM_URL.replace(/\/$/, '')}/auth/local/login`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ email: PSEUDO_LOGIN_EMAIL, password: PSEUDO_LOGIN_PASSWORD }),
      })
      if (!res.ok) {
        throw new Error(`pseudo-IAM ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
      const body = await res.json() as { access_token: string; user: { id: string; email: string; display_name?: string; is_super_admin?: boolean } }
      const verifiedUser = await verifyWorkgraphToken(body.access_token)
      await completeLogin(body.access_token, verifiedUser)
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } }; message?: string })?.response?.data?.message
        ?? (err as Error).message
      setError(
        msg.includes('IAM rejected token')
          ? `IAM returned a token, but Workgraph rejected it. Check that Workgraph IAM_BASE_URL points at ${PSEUDO_IAM_URL}.`
          : msg,
      )
      setLoading(false)
    }
  }

  // Auto-login on mount when VITE_AUTO_LOGIN=1 (the default for dev). The user
  // should see a brief "signing in…" splash and then land on /dashboard
  // without having to type anything. Set VITE_AUTO_LOGIN=0 to disable.
  useEffect(() => {
    if (AUTO_LOGIN) void pseudoLogin()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleLocalSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const res = await api.post('/auth/login', { email, password })
      const verifiedUser = await verifyWorkgraphToken(res.data.token)
      await completeLogin(res.data.token, verifiedUser)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Authentication failed'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  async function handleIamSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const login = await api.post('/auth/iam-login', { email: iamEmail, password: iamPassword })
      const token = login.data.access_token as string
      const user = await verifyWorkgraphToken(token)
      await completeLogin(token, user)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
                  ?? 'IAM token rejected. Make sure the token is current and IAM is reachable.'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{
        background:
          'radial-gradient(ellipse at top, var(--brand-forest-light, #155041) 0%, var(--brand-forest, #0E3B2D) 45%, var(--brand-forest-deep, #082821) 100%)',
      }}
    >
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 60% 50% at 50% -10%, rgba(0,166,81,0.12) 0%, transparent 70%)',
        }}
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="relative w-full max-w-sm"
      >
        <div
          className="rounded-xl p-7 shadow-2xl"
          style={{
            background: 'var(--surface-card, #ffffff)',
            border: '1px solid rgba(245,242,234,0.1)',
            boxShadow: '0 24px 60px rgba(8,40,33,0.35)',
          }}
        >
          {/* Logo */}
          <div className="flex items-center justify-center gap-3 mb-6">
            <img
              src="/singularity-mark.png"
              alt="Singularity"
              width={44}
              height={44}
              className="shrink-0 select-none"
              style={{ filter: 'drop-shadow(0 2px 8px rgba(8,40,33,0.25))' }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/singularity-logo.png' }}
            />
            <div>
              <h1 className="text-base font-bold" style={{ color: 'var(--text-strong, #0A2240)', letterSpacing: '0.04em' }}>
                Singularity
              </h1>
              <p className="text-[10px] font-semibold uppercase" style={{ color: 'var(--brand-green, #00843D)', letterSpacing: '0.18em' }}>
                Workflow Manager
              </p>
            </div>
          </div>

          <h2 className="text-lg font-semibold mb-1 text-center" style={{ color: 'var(--text-strong, #0A2240)' }}>Sign in</h2>
          <p className="text-sm mb-5 text-center" style={{ color: 'var(--text-muted, #64748b)' }}>Choose how you want to authenticate</p>

          {/* M12 — one-click local-dev sign-in. Always visible so even if
              auto-login is disabled or fails, a single click gets you in. */}
          <button
            onClick={() => void pseudoLogin()}
            disabled={loading}
            className="w-full mb-5 h-11 rounded-lg flex items-center justify-center gap-2 font-semibold text-sm transition-all"
            style={{
              background: 'var(--brand-green-tint, #e6f4ed)',
              border: '1px solid rgba(0,132,61,0.18)',
              color: 'var(--brand-green-dark, #006236)',
            }}
          >
            {loading
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Signing in…</>
              : <><ShieldCheck className="w-4 h-4" /> Continue as super admin</>}
          </button>
          <p className="text-[11px] -mt-3 mb-5 text-center" style={{ color: 'var(--text-muted, #64748b)' }}>
            Local dev shortcut using the configured IAM endpoint.{' '}
            <span style={{ color: 'var(--text-faint, #94a3b8)' }}>Auto-login: {AUTO_LOGIN ? 'on' : 'off'} · target: {PSEUDO_IAM_URL}</span>
          </p>

          {/* Tab switcher */}
          <div
            className="flex gap-1 p-1 rounded-lg mb-5"
            style={{ background: 'var(--surface-light, #F0F4F8)', border: '1px solid var(--surface-border, #E2E8F0)' }}
          >
            <button
              onClick={() => { setTab('iam'); setError('') }}
              className="flex-1 h-8 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition-all"
              style={{
                background: tab === 'iam' ? 'var(--surface-card, #ffffff)' : 'transparent',
                color: tab === 'iam' ? 'var(--brand-green, #00843D)' : 'var(--text-muted, #64748b)',
                boxShadow: tab === 'iam' ? '0 1px 3px rgba(10,34,64,0.08)' : 'none',
              }}
            >
              <ExternalLink className="w-3 h-3" />
              Singularity IAM
            </button>
            <button
              onClick={() => { setTab('local'); setError('') }}
              className="flex-1 h-8 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition-all"
              style={{
                background: tab === 'local' ? 'var(--surface-card, #ffffff)' : 'transparent',
                color: tab === 'local' ? 'var(--brand-green, #00843D)' : 'var(--text-muted, #64748b)',
                boxShadow: tab === 'local' ? '0 1px 3px rgba(10,34,64,0.08)' : 'none',
              }}
            >
              <KeyRound className="w-3 h-3" />
              Local
            </button>
          </div>

          {tab === 'iam' && (
            <form onSubmit={handleIamSubmit} className="space-y-4">
              <div className="space-y-2">
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted, #64748b)' }}>
                  Sign in with your{' '}
                  <a href={IAM_LOGIN_URL} target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--brand-green, #00843D)' }}>
                    Singularity IAM
                  </a>
                  {' '}credentials. Workgraph verifies the IAM token before opening the studio.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="label-xs">Email address</label>
                <input
                  type="email"
                  value={iamEmail}
                  onChange={e => setIamEmail(e.target.value)}
                  required
                  className="w-full h-10 rounded-md px-3 text-sm outline-none transition-all duration-200"
                  style={{
                    background: 'var(--surface-card, #ffffff)',
                    border: '1px solid var(--surface-border, #E2E8F0)',
                    color: 'var(--text-strong, #0A2240)',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = 'var(--brand-green, #00843D)' }}
                  onBlur={e => { e.currentTarget.style.borderColor = 'var(--surface-border, #E2E8F0)' }}
                />
              </div>

              <div className="space-y-1.5">
                <label className="label-xs">Password</label>
                <input
                  type="password"
                  value={iamPassword}
                  onChange={e => setIamPassword(e.target.value)}
                  required
                  className="w-full h-10 rounded-md px-3 text-sm outline-none transition-all duration-200"
                  style={{
                    background: 'var(--surface-card, #ffffff)',
                    border: '1px solid var(--surface-border, #E2E8F0)',
                    color: 'var(--text-strong, #0A2240)',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = 'var(--brand-green, #00843D)' }}
                  onBlur={e => { e.currentTarget.style.borderColor = 'var(--surface-border, #E2E8F0)' }}
                />
              </div>

              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm"
                  style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#fca5a5' }}
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </motion.div>
              )}

              <button
                type="submit"
                disabled={loading || !iamEmail.trim() || !iamPassword}
                className="w-full h-10 rounded-lg text-sm font-semibold transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                style={{
                  background: loading ? 'rgba(0,132,61,0.55)' : 'var(--brand-green, #00843D)',
                  color: 'var(--brand-warm-white, #F5F2EA)',
                  boxShadow: loading ? 'none' : '0 8px 18px rgba(0,132,61,0.18)',
                }}
              >
                {loading ? (<><Loader2 className="w-4 h-4 animate-spin" /> Signing in with IAM…</>) : 'Sign in with IAM'}
              </button>
            </form>
          )}

          {tab === 'local' && (
            <form onSubmit={handleLocalSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="label-xs">Email address</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  className="w-full h-10 rounded-md px-3 text-sm outline-none transition-all duration-200"
                  style={{
                    background: 'var(--surface-card, #ffffff)',
                    border: '1px solid var(--surface-border, #E2E8F0)',
                    color: 'var(--text-strong, #0A2240)',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = 'var(--brand-green, #00843D)' }}
                  onBlur={e => { e.currentTarget.style.borderColor = 'var(--surface-border, #E2E8F0)' }}
                />
              </div>

              <div className="space-y-1.5">
                <label className="label-xs">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  className="w-full h-10 rounded-md px-3 text-sm outline-none transition-all duration-200"
                  style={{
                    background: 'var(--surface-card, #ffffff)',
                    border: '1px solid var(--surface-border, #E2E8F0)',
                    color: 'var(--text-strong, #0A2240)',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = 'var(--brand-green, #00843D)' }}
                  onBlur={e => { e.currentTarget.style.borderColor = 'var(--surface-border, #E2E8F0)' }}
                />
              </div>

              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm"
                  style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#fca5a5' }}
                >
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {error}
                </motion.div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full h-10 rounded-lg text-sm font-semibold transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                style={{
                  background: loading ? 'rgba(0,132,61,0.55)' : 'var(--brand-green, #00843D)',
                  color: 'var(--brand-warm-white, #F5F2EA)',
                  boxShadow: loading ? 'none' : '0 8px 18px rgba(0,132,61,0.18)',
                }}
              >
                {loading ? (<><Loader2 className="w-4 h-4 animate-spin" /> Authenticating…</>) : 'Sign in'}
              </button>
            </form>
          )}

          <div className="mt-6 pt-4" style={{ borderTop: '1px solid var(--surface-border, #E2E8F0)' }}>
            <p className="label-xs text-center">
              {tab === 'iam'
                ? 'Authentication delegated to Singularity IAM'
                : 'Demo credentials pre-filled'}
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  )
}
