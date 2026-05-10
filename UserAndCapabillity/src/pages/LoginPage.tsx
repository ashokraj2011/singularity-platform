import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useNavigate, useLocation } from 'react-router-dom'
import { Fingerprint, AlertCircle, Lock, Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authApi } from '@/api/auth.api'
import { useAuthStore } from '@/store/auth.store'

const schema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(1, 'Password is required'),
})
type FormValues = z.infer<typeof schema>

export function LoginPage() {
  const { setAuth } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? '/dashboard'

  const { register, handleSubmit, formState: { errors, isSubmitting }, setError } = useForm<FormValues>({
    resolver: zodResolver(schema),
  })

  async function onSubmit(values: FormValues) {
    try {
      const res = await authApi.login(values)
      setAuth(res.access_token, res.user)
      navigate(from, { replace: true })
    } catch {
      setError('root', { message: 'Invalid credentials. Please try again.' })
    }
  }

  return (
    <div className="min-h-screen flex">
      {/* Left panel — brand */}
      <div
        className="hidden lg:flex lg:w-2/5 flex-col items-center justify-center p-12 relative overflow-hidden"
        style={{ background: 'linear-gradient(145deg, #071829 0%, #0A2240 45%, #0D3060 100%)' }}
      >
        {/* Decorative circles */}
        <div
          className="absolute -top-24 -left-24 w-72 h-72 rounded-full opacity-10"
          style={{ background: '#00843D' }}
        />
        <div
          className="absolute -bottom-32 -right-16 w-96 h-96 rounded-full opacity-[0.07]"
          style={{ background: '#00A651' }}
        />
        <div
          className="absolute top-1/3 right-0 w-48 h-48 rounded-full opacity-[0.06]"
          style={{ background: '#ffffff' }}
        />

        {/* Content */}
        <div className="relative z-10 flex flex-col items-center text-center max-w-xs">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mb-6 shadow-2xl"
            style={{ background: '#00843D' }}
          >
            <Fingerprint className="text-white" style={{ width: 32, height: 32 }} />
          </div>

          <h1
            className="text-2xl font-bold tracking-wide mb-1"
            style={{ color: '#ffffff', letterSpacing: '0.06em' }}
          >
            SINGULARITY
          </h1>
          <p
            className="text-sm font-semibold tracking-widest mb-6"
            style={{ color: 'rgba(255,255,255,0.45)', letterSpacing: '0.2em' }}
          >
            IAM PLATFORM
          </p>

          <div
            className="w-8 h-0.5 rounded-full mb-6"
            style={{ background: '#00843D' }}
          />

          <p className="text-sm leading-relaxed" style={{ color: 'rgba(255,255,255,0.55)' }}>
            Identity and Access Management for enterprise capabilities, teams, and permissions.
          </p>

          <div className="mt-10 flex flex-col gap-2 w-full">
            {['Single source of truth for access', 'Fine-grained capability roles', 'Complete audit trail'].map(feature => (
              <div key={feature} className="flex items-center gap-2.5">
                <div
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: '#00A651' }}
                />
                <span className="text-xs text-left" style={{ color: 'rgba(255,255,255,0.5)' }}>
                  {feature}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Right panel — form */}
      <div
        className="flex-1 flex flex-col items-center justify-center p-8"
        style={{ background: '#F0F4F8' }}
      >
        {/* Mobile logo */}
        <div className="lg:hidden flex flex-col items-center mb-8">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center mb-3"
            style={{ background: '#00843D' }}
          >
            <Fingerprint className="text-white" style={{ width: 24, height: 24 }} />
          </div>
          <p className="text-sm font-bold tracking-wider" style={{ color: '#0A2240' }}>
            SINGULARITY IAM
          </p>
        </div>

        <div className="w-full max-w-sm">
          <div className="mb-8">
            <h2
              className="text-2xl font-bold mb-1"
              style={{ color: '#0A2240' }}
            >
              Welcome back
            </h2>
            <p className="text-sm" style={{ color: '#64748b' }}>
              Sign in to your admin account
            </p>
          </div>

          <div
            className="bg-white rounded-xl p-6"
            style={{ boxShadow: '0 1px 3px rgba(10,34,64,0.08), 0 4px 16px rgba(10,34,64,0.06)', border: '1px solid #E2E8F0' }}
          >
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
              {errors.root && (
                <div
                  className="flex items-center gap-2.5 text-sm rounded-lg px-3.5 py-2.5"
                  style={{ color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca' }}
                >
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {errors.root.message}
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#4A5568' }}>
                  Email Address
                </Label>
                <div className="relative">
                  <Mail
                    className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
                    style={{ color: '#94a3b8' }}
                  />
                  <Input
                    id="email"
                    type="email"
                    placeholder="admin@example.com"
                    className="pl-9"
                    style={{ borderColor: '#E2E8F0' }}
                    {...register('email')}
                  />
                </div>
                {errors.email && (
                  <p className="text-xs" style={{ color: '#dc2626' }}>{errors.email.message}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#4A5568' }}>
                  Password
                </Label>
                <div className="relative">
                  <Lock
                    className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
                    style={{ color: '#94a3b8' }}
                  />
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    className="pl-9"
                    style={{ borderColor: '#E2E8F0' }}
                    {...register('password')}
                  />
                </div>
                {errors.password && (
                  <p className="text-xs" style={{ color: '#dc2626' }}>{errors.password.message}</p>
                )}
              </div>

              <Button
                type="submit"
                className="w-full h-10 font-semibold text-sm tracking-wide"
                disabled={isSubmitting}
                style={{ background: '#00843D', color: '#ffffff' }}
              >
                {isSubmitting ? 'Signing in…' : 'Sign In'}
              </Button>
            </form>
          </div>

          <p
            className="text-center text-xs mt-4"
            style={{ color: '#94a3b8' }}
          >
            Local super admin credentials only
          </p>
        </div>
      </div>
    </div>
  )
}
