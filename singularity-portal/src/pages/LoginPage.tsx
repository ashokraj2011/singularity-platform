import { FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { iamApi } from '@/lib/api'
import { useAuthStore } from '@/store/auth.store'
import { BrandLockup } from '@/components/BrandLockup'

interface LoginResponse {
  access_token: string
  token_type: string
  user: {
    id: string
    email: string
    display_name?: string
    is_super_admin?: boolean
  }
}

export function LoginPage() {
  const navigate = useNavigate()
  const setSession = useAuthStore((s) => s.setSession)
  const [email, setEmail] = useState('admin@singularity.local')
  const [password, setPassword] = useState('Admin1234!')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await iamApi.post<LoginResponse>('/auth/local/login', { email, password })
      setSession(res.data.access_token, res.data.user)
      navigate('/', { replace: true })
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string; message?: string } } }
      setError(e?.response?.data?.detail ?? e?.response?.data?.message ?? 'Login failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="flex min-h-full items-center justify-center p-6"
      style={{
        background:
          'radial-gradient(ellipse at top, var(--brand-forest-light) 0%, var(--brand-forest) 45%, var(--brand-forest-deep) 100%)',
      }}
    >
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <BrandLockup variant="hero" />
        </div>

        <div
          className="rounded-xl p-7 shadow-2xl"
          style={{
            background: 'var(--surface-card)',
            border: '1px solid rgba(245,242,234,0.1)',
          }}
        >
          <h1 className="text-base font-semibold text-center" style={{ color: 'var(--text-strong)' }}>
            Sign in
          </h1>
          <p className="mt-1 mb-5 text-xs text-center" style={{ color: 'var(--text-muted)' }}>
            Authenticate with your Singularity IAM credentials.
          </p>

          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label
                className="mb-1 block text-xs font-medium"
                htmlFor="email"
                style={{ color: 'var(--text-strong)' }}
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm shadow-sm focus:outline-none"
                style={{ borderColor: 'var(--surface-border)' }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = 'var(--brand-green)'
                  e.currentTarget.style.boxShadow = '0 0 0 1px var(--brand-green)'
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = 'var(--surface-border)'
                  e.currentTarget.style.boxShadow = ''
                }}
              />
            </div>
            <div>
              <label
                className="mb-1 block text-xs font-medium"
                htmlFor="password"
                style={{ color: 'var(--text-strong)' }}
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm shadow-sm focus:outline-none"
                style={{ borderColor: 'var(--surface-border)' }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = 'var(--brand-green)'
                  e.currentTarget.style.boxShadow = '0 0 0 1px var(--brand-green)'
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = 'var(--surface-border)'
                  e.currentTarget.style.boxShadow = ''
                }}
              />
            </div>
            {error && (
              <div
                className="rounded-md px-3 py-2 text-xs"
                style={{
                  background: 'var(--status-error-bg, #fef2f2)',
                  color: 'var(--status-error-fg, #b91c1c)',
                  border: '1px solid var(--status-error-border, #fecaca)',
                }}
              >
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md px-4 py-2 text-sm font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-60"
              style={{ background: 'var(--brand-green)', color: 'var(--brand-warm-white)' }}
              onMouseEnter={(e) => !submitting && (e.currentTarget.style.background = 'var(--brand-green-dark)')}
              onMouseLeave={(e) => !submitting && (e.currentTarget.style.background = 'var(--brand-green)')}
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="mt-5 text-center text-[10px]" style={{ color: 'rgba(245,242,234,0.45)', letterSpacing: '0.08em' }}>
          GOVERNED AGENTIC DELIVERY · v0.1
        </p>
      </div>
    </div>
  )
}
