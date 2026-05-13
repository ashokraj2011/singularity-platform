import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { Zap, AlertCircle, Loader2, ExternalLink, KeyRound, ShieldCheck } from 'lucide-react'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/auth.store'
import { useActiveContextStore, type Membership } from '../../store/activeContext.store'

const AUTH_PROVIDER  = (import.meta.env.VITE_AUTH_PROVIDER ?? 'local') as 'local' | 'iam'
const IAM_LOGIN_URL  = import.meta.env.VITE_IAM_LOGIN_URL  ?? 'http://localhost:5175/login'

// M12 — pseudo-IAM auto-login support. When VITE_PSEUDO_IAM_URL is set, the
// "Continue as super admin" button (and the auto-login effect when
// VITE_AUTO_LOGIN=1) calls pseudo-IAM directly and stores the token.
// Defaults: pseudo-IAM at :8101, auto-login disabled so real IAM remains the
// default source of truth. Set VITE_AUTO_LOGIN=1 for pseudo-IAM smoke tests.
const PSEUDO_IAM_URL    = import.meta.env.VITE_PSEUDO_IAM_URL    ?? 'http://localhost:8101/api/v1'
const AUTO_LOGIN        = (import.meta.env.VITE_AUTO_LOGIN     ?? '0') !== '0'
const PSEUDO_LOGIN_EMAIL = import.meta.env.VITE_PSEUDO_LOGIN_EMAIL ?? 'admin@pseudo.local'

async function fetchMemberships(token: string): Promise<Membership[]> {
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

export function LoginPage() {
  const navigate = useNavigate()
  const setAuth = useAuthStore(s => s.setAuth)
  const setMemberships = useActiveContextStore(s => s.setMemberships)
  const setActive = useActiveContextStore(s => s.setActive)

  // Local-mode form state
  const [email, setEmail]       = useState('admin@workgraph.local')
  const [password, setPassword] = useState('admin123')
  // IAM-mode paste-token state
  const [iamToken, setIamToken] = useState('')

  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(false)

  // Tab UI: 'local' (legacy) vs 'iam'.  Default to whichever the env says.
  const [tab, setTab] = useState<'local' | 'iam'>(AUTH_PROVIDER)

  // M12 — one-click sign in via pseudo-IAM. Talks directly to pseudo-IAM
  // (default :8101) which accepts ANY credentials and returns a JWT signed
  // with the same JWT_SECRET as real IAM, so workgraph-api accepts it.
  async function pseudoLogin() {
    setError(''); setLoading(true)
    try {
      const res = await fetch(`${PSEUDO_IAM_URL.replace(/\/$/, '')}/auth/local/login`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ email: PSEUDO_LOGIN_EMAIL, password: 'pseudo' }),
      })
      if (!res.ok) {
        throw new Error(`pseudo-IAM ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
      const body = await res.json() as { access_token: string; user: { id: string; email: string; display_name?: string; is_super_admin?: boolean } }
      setAuth(body.access_token, {
        id:          body.user.id,
        email:       body.user.email,
        displayName: body.user.display_name ?? body.user.email,
        roles:       body.user.is_super_admin ? ['super-admin'] : [],
      })
      // Multi-tenant model: fetch memberships, then either auto-pick (1 option)
      // or send the user to the picker page (>1).
      const ms = await fetchMemberships(body.access_token)
      setMemberships(ms)
      if (ms.length === 1) {
        setActive(ms[0])
        navigate('/dashboard')
      } else if (ms.length > 1) {
        navigate('/context-picker')
      } else {
        navigate('/dashboard')
      }
    } catch (err) {
      setError((err as Error).message)
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
      setAuth(res.data.token, res.data.user)
      navigate('/dashboard')
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
      // We don't call /auth/login in IAM mode — the IAM-issued bearer goes
      // straight to the auth middleware, which mirrors the user on first hit.
      // Verify by calling /auth/me; if it succeeds, we're good.
      const res = await api.get('/auth/me', { headers: { Authorization: `Bearer ${iamToken.trim()}` } })
      const user = {
        id: res.data.id,
        email: res.data.email,
        displayName: res.data.displayName,
        teamId: res.data.teamId,
        roles: res.data.roles?.map((r: { name: string }) => r.name) ?? [],
      }
      setAuth(iamToken.trim(), user)
      navigate('/dashboard')
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
      className="min-h-screen flex items-center justify-center canvas-grid"
      style={{ background: '#020617' }}
    >
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 60% 50% at 50% -10%, rgba(34,211,238,0.06) 0%, transparent 70%)',
        }}
      />

      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="relative w-full max-w-sm"
      >
        <div
          className="glass-panel rounded-2xl p-8"
          style={{ boxShadow: '0 0 40px rgba(34,211,238,0.06), 0 25px 50px rgba(0,0,0,0.5)' }}
        >
          {/* Logo */}
          <div className="flex items-center justify-center gap-3 mb-6">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{ background: 'rgba(34,211,238,0.15)', border: '1px solid rgba(34,211,238,0.3)' }}
            >
              <Zap className="w-5 h-5" style={{ color: '#22d3ee' }} />
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-100 neon-glow" style={{ letterSpacing: '0.08em' }}>
                WORKGRAPH
              </h1>
              <p className="text-[10px] font-mono" style={{ color: '#22d3ee', opacity: 0.75 }}>
                ENTERPRISE STUDIO
              </p>
            </div>
          </div>

          <h2 className="text-lg font-semibold text-slate-200 mb-1">Sign in</h2>
          <p className="text-sm text-slate-500 mb-5">Choose how you want to authenticate</p>

          {/* M12 — one-click pseudo-IAM sign-in. Always visible so even if
              auto-login is disabled or fails, a single click gets you in. */}
          <button
            onClick={() => void pseudoLogin()}
            disabled={loading}
            className="w-full mb-5 h-11 rounded-lg flex items-center justify-center gap-2 font-semibold text-sm transition-all"
            style={{
              background: 'linear-gradient(135deg, rgba(34,211,238,0.15), rgba(34,211,238,0.05))',
              border: '1px solid rgba(34,211,238,0.4)',
              color: '#22d3ee',
            }}
          >
            {loading
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Signing in…</>
              : <><ShieldCheck className="w-4 h-4" /> Continue as super admin (Pseudo IAM)</>}
          </button>
          <p className="text-[11px] text-slate-500 -mt-3 mb-5 text-center">
            For local dev — pseudo-IAM accepts any credentials.{' '}
            <span className="text-slate-600">Auto-login: {AUTO_LOGIN ? 'on' : 'off'} · target: {PSEUDO_IAM_URL}</span>
          </p>

          {/* Tab switcher */}
          <div
            className="flex gap-1 p-1 rounded-lg mb-5"
            style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <button
              onClick={() => { setTab('iam'); setError('') }}
              className="flex-1 h-8 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition-all"
              style={{
                background: tab === 'iam' ? 'rgba(34,211,238,0.15)' : 'transparent',
                color: tab === 'iam' ? '#22d3ee' : '#64748b',
              }}
            >
              <ExternalLink className="w-3 h-3" />
              Singularity IAM
            </button>
            <button
              onClick={() => { setTab('local'); setError('') }}
              className="flex-1 h-8 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition-all"
              style={{
                background: tab === 'local' ? 'rgba(34,211,238,0.15)' : 'transparent',
                color: tab === 'local' ? '#22d3ee' : '#64748b',
              }}
            >
              <KeyRound className="w-3 h-3" />
              Local
            </button>
          </div>

          {tab === 'iam' && (
            <form onSubmit={handleIamSubmit} className="space-y-4">
              <div className="space-y-2">
                <p className="text-xs text-slate-400 leading-relaxed">
                  Sign in to{' '}
                  <a href={IAM_LOGIN_URL} target="_blank" rel="noreferrer" className="underline" style={{ color: '#22d3ee' }}>
                    Singularity IAM
                  </a>
                  , copy your access token from there, and paste it below.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="label-xs">IAM access token</label>
                <textarea
                  value={iamToken}
                  onChange={e => setIamToken(e.target.value)}
                  required
                  rows={3}
                  placeholder="eyJhbGciOiJIUzI1NiIs..."
                  className="w-full rounded-lg px-3 py-2 text-xs font-mono text-slate-200 placeholder-slate-600 outline-none transition-all duration-200 resize-none"
                  style={{
                    background: 'rgba(15,23,42,0.8)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = 'rgba(34,211,238,0.4)' }}
                  onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
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
                disabled={loading || !iamToken.trim()}
                className="w-full h-10 rounded-lg text-sm font-semibold transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                style={{
                  background: loading ? 'rgba(34,211,238,0.5)' : '#22d3ee',
                  color: '#020617',
                  boxShadow: loading ? 'none' : '0 0 16px rgba(34,211,238,0.2)',
                }}
              >
                {loading ? (<><Loader2 className="w-4 h-4 animate-spin" /> Verifying with IAM…</>) : 'Continue'}
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
                  className="w-full h-10 rounded-lg px-3 text-sm text-slate-200 placeholder-slate-600 outline-none transition-all duration-200"
                  style={{
                    background: 'rgba(15,23,42,0.8)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = 'rgba(34,211,238,0.4)' }}
                  onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
                />
              </div>

              <div className="space-y-1.5">
                <label className="label-xs">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  className="w-full h-10 rounded-lg px-3 text-sm text-slate-200 placeholder-slate-600 outline-none transition-all duration-200"
                  style={{
                    background: 'rgba(15,23,42,0.8)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                  onFocus={e => { e.currentTarget.style.borderColor = 'rgba(34,211,238,0.4)' }}
                  onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
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
                  background: loading ? 'rgba(34,211,238,0.5)' : '#22d3ee',
                  color: '#020617',
                  boxShadow: loading ? 'none' : '0 0 16px rgba(34,211,238,0.2)',
                }}
              >
                {loading ? (<><Loader2 className="w-4 h-4 animate-spin" /> Authenticating…</>) : 'Sign in'}
              </button>
            </form>
          )}

          <div className="mt-6 pt-4 border-t border-white/[0.06]">
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
