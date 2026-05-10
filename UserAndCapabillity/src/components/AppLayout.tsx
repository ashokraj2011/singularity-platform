import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import {
  Users, Building2, UsersRound, Layers, Share2,
  ShieldCheck, Key, GitBranch, ClipboardList,
  LogOut, BarChart3, ChevronRight,
} from 'lucide-react'
import { useAuthStore } from '@/store/auth.store'
import { cn } from '@/lib/utils'

interface NavItem {
  to: string
  icon: React.ElementType
  label: string
}

const navGroups: { title: string; items: NavItem[] }[] = [
  {
    title: 'Identity',
    items: [
      { to: '/users', icon: Users, label: 'Users' },
      { to: '/business-units', icon: Building2, label: 'Business Units' },
      { to: '/teams', icon: UsersRound, label: 'Teams' },
    ],
  },
  {
    title: 'Access Control',
    items: [
      { to: '/capabilities', icon: Layers, label: 'Capabilities' },
      { to: '/capability-graph', icon: GitBranch, label: 'Capability Graph' },
      { to: '/roles', icon: ShieldCheck, label: 'Roles' },
      { to: '/permissions', icon: Key, label: 'Permissions' },
      { to: '/sharing-grants', icon: Share2, label: 'Sharing Grants' },
    ],
  },
  {
    title: 'Operations',
    items: [
      { to: '/authz-check', icon: BarChart3, label: 'Authz Playground' },
      { to: '/audit', icon: ClipboardList, label: 'Audit Log' },
    ],
  },
]

export function AppLayout() {
  const { user, logout } = useAuthStore()
  const navigate = useNavigate()

  function handleLogout() {
    logout()
    navigate('/login')
  }

  const initials = (user?.display_name ?? user?.email ?? '?')
    .split(' ')
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <div className="flex h-screen" style={{ background: '#F0F4F8' }}>
      {/* Sidebar */}
      <aside
        className="w-64 flex flex-col shrink-0"
        style={{
          background: '#0E3B2D',
          backgroundImage: 'linear-gradient(180deg, #0E3B2D 0%, #082821 100%)',
        }}
      >
        {/* Logo */}
        <div className="px-5 py-5" style={{ borderBottom: '1px solid rgba(245,242,234,0.08)' }}>
          <div className="flex items-center gap-3">
            <img
              src="/singularity-mark.png"
              alt="Singularity"
              width={36}
              height={36}
              className="shrink-0 select-none"
              style={{ filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.25))' }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/singularity-logo.png' }}
            />
            <div className="leading-tight">
              <div
                className="text-sm font-bold leading-none"
                style={{ color: '#F5F2EA', letterSpacing: '0.04em' }}
              >
                Singularity
              </div>
              <div
                className="text-[9px] font-medium leading-none mt-1 uppercase"
                style={{ color: 'rgba(245,242,234,0.55)', letterSpacing: '0.18em' }}
              >
                Governed Agentic Delivery
              </div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 px-3">
          {navGroups.map(group => (
            <div key={group.title} className="mb-5">
              <p
                className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-widest"
                style={{ color: 'rgba(245,242,234,0.35)' }}
              >
                {group.title}
              </p>
              {group.items.map(item => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-all duration-150 mb-0.5 group relative',
                      isActive
                        ? 'font-medium'
                        : 'font-normal',
                    )
                  }
                  style={({ isActive }) => ({
                    color: isActive ? '#F5F2EA' : 'rgba(245,242,234,0.65)',
                    background: isActive ? 'rgba(245,242,234,0.08)' : 'transparent',
                    borderLeft: isActive ? '3px solid #00A651' : '3px solid transparent',
                  })}
                >
                  {({ isActive }) => (
                    <>
                      <item.icon
                        className="w-4 h-4 shrink-0 transition-colors"
                        style={{ color: isActive ? '#00A651' : 'rgba(245,242,234,0.5)' }}
                      />
                      <span className="flex-1">{item.label}</span>
                      {isActive && (
                        <ChevronRight
                          className="w-3 h-3 shrink-0"
                          style={{ color: 'rgba(245,242,234,0.4)' }}
                        />
                      )}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        {/* User footer */}
        <div
          className="px-4 py-3"
          style={{ borderTop: '1px solid rgba(245,242,234,0.08)', background: 'rgba(8,40,33,0.5)' }}
        >
          <div className="flex items-center gap-2.5">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
              style={{ background: '#006236', color: '#F5F2EA', letterSpacing: '0.02em' }}
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
                  style={{ color: '#00A651' }}
                >
                  Super Admin
                </p>
              )}
            </div>
            <button
              onClick={handleLogout}
              className="p-1.5 rounded-md transition-colors"
              style={{ color: 'rgba(245,242,234,0.4)' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'rgba(245,242,234,0.85)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'rgba(245,242,234,0.4)')}
              title="Sign out"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  )
}
