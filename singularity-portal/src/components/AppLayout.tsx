import { ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import {
  Home, Workflow, Bot, Users, BarChart3, ExternalLink, ServerCog,
  LogOut, ChevronRight, Zap,
} from 'lucide-react'
import { useAuthStore } from '@/store/auth.store'
import { env } from '@/lib/env'
import { cn } from '@/lib/cn'
import { BrandLockup } from './BrandLockup'
import { AppSwitcher } from './AppSwitcher'

const internalNav = [
  { to: '/', label: 'Dashboard', icon: Home, end: true },
  { to: '/engine', label: 'Engine', icon: Zap, end: false },
  { to: '/operations', label: 'Operations', icon: ServerCog, end: false },
]

const externalNav: { label: string; href: string; icon: typeof Workflow; subtitle: string }[] = [
  { label: 'Workflow Manager',   href: env.links.workgraphDesigner, icon: Workflow, subtitle: 'Design, run, and review workflows' },
  { label: 'Agent Studio',       href: env.links.agentAdmin,        icon: Bot,      subtitle: 'Agents, prompts, tools, learning' },
  { label: 'Identity & Access',  href: env.links.iamAdmin,          icon: Users,    subtitle: 'Users, teams, roles, capabilities' },
]

export function AppLayout({ children }: { children: ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const navigate = useNavigate()

  function onLogout() {
    logout()
    navigate('/login', { replace: true })
  }

  const initials = (user?.display_name ?? user?.email ?? '?')
    .split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()

  return (
    <div className="flex h-screen" style={{ background: 'var(--surface-light)' }}>
      <aside
        className="w-64 flex flex-col shrink-0"
        style={{
          background: 'var(--brand-forest)',
          backgroundImage: 'linear-gradient(180deg, var(--brand-forest) 0%, var(--brand-forest-deep) 100%)',
        }}
      >
        {/* Logo */}
        <div className="px-5 py-5" style={{ borderBottom: '1px solid rgba(245,242,234,0.08)' }}>
          <BrandLockup variant="compact" />
        </div>

        <AppSwitcher currentApp="operations" />

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 px-3">
          {/* Internal: portal pages */}
          <div className="mb-5">
            <p
              className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-widest"
              style={{ color: 'rgba(245,242,234,0.35)' }}
            >
              Portal
            </p>
            {internalNav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-all duration-150 mb-0.5',
                    isActive ? 'font-medium' : 'font-normal',
                  )
                }
                style={({ isActive }) => ({
                  color: isActive ? 'var(--brand-warm-white)' : 'rgba(245,242,234,0.65)',
                  background: isActive ? 'rgba(245,242,234,0.08)' : 'transparent',
                  borderLeft: isActive ? '3px solid var(--brand-green-accent)' : '3px solid transparent',
                })}
              >
                {({ isActive }) => (
                  <>
                    <item.icon
                      className="w-4 h-4 shrink-0 transition-colors"
                      style={{ color: isActive ? 'var(--brand-green-accent)' : 'rgba(245,242,234,0.5)' }}
                    />
                    <span className="flex-1">{item.label}</span>
                    {isActive && <ChevronRight className="w-3 h-3 shrink-0" style={{ color: 'rgba(245,242,234,0.4)' }} />}
                  </>
                )}
              </NavLink>
            ))}
          </div>

          {/* External: deep links to per-app UIs */}
          <div className="mb-5">
            <p
              className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-widest"
              style={{ color: 'rgba(245,242,234,0.35)' }}
            >
              Apps
            </p>
            {externalNav.map((item) => (
              <a
                key={item.href}
                href={item.href}
                target="_blank"
                rel="noreferrer"
                className="flex items-start gap-3 px-3 py-2 rounded-md text-sm transition-colors mb-0.5"
                style={{ color: 'rgba(245,242,234,0.65)' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(245,242,234,0.06)'
                  e.currentTarget.style.color = 'var(--brand-warm-white)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = 'rgba(245,242,234,0.65)'
                }}
              >
                <item.icon className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'rgba(245,242,234,0.5)' }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className="truncate">{item.label}</span>
                    <ExternalLink className="w-3 h-3 shrink-0 opacity-50" />
                  </div>
                  <div
                    className="text-[10px] truncate mt-0.5"
                    style={{ color: 'rgba(245,242,234,0.4)' }}
                  >
                    {item.subtitle}
                  </div>
                </div>
              </a>
            ))}
          </div>

          <div>
            <p
              className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-widest"
              style={{ color: 'rgba(245,242,234,0.35)' }}
            >
              Insights
            </p>
            <NavLink
              to="/engine"
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-all duration-150 mb-0.5',
                  isActive ? 'font-medium' : 'font-normal',
                )
              }
              style={({ isActive }) => ({
                color: isActive ? 'var(--brand-warm-white)' : 'rgba(245,242,234,0.65)',
                background: isActive ? 'rgba(245,242,234,0.08)' : 'transparent',
                borderLeft: isActive ? '3px solid var(--brand-green-accent)' : '3px solid transparent',
              })}
            >
              <BarChart3 className="w-4 h-4 shrink-0" style={{ color: 'rgba(245,242,234,0.5)' }} />
              <span>Analytics</span>
            </NavLink>
          </div>
        </nav>

        {/* User footer */}
        <div
          className="px-4 py-3"
          style={{
            borderTop: '1px solid rgba(245,242,234,0.08)',
            background: 'rgba(8,40,33,0.5)',
          }}
        >
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
              style={{
                background: 'var(--brand-green-dark)',
                color: 'var(--brand-warm-white)',
                letterSpacing: '0.02em',
              }}
            >
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <p
                className="text-xs font-medium truncate leading-tight"
                style={{ color: 'rgba(245,242,234,0.9)' }}
              >
                {user?.display_name ?? user?.email}
              </p>
              {user?.is_super_admin && (
                <p
                  className="text-[10px] leading-tight mt-0.5 font-medium"
                  style={{ color: 'var(--brand-green-accent)' }}
                >
                  Super Admin
                </p>
              )}
            </div>
            <button
              onClick={onLogout}
              className="p-1.5 rounded-md transition-colors"
              style={{ color: 'rgba(245,242,234,0.4)' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'rgba(245,242,234,0.85)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(245,242,234,0.4)')}
              title="Sign out"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-8">{children}</div>
      </main>
    </div>
  )
}
