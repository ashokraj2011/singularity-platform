import { useState, useEffect } from 'react'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'motion/react'
import {
  LayoutDashboard, FileText, GitBranch, ScrollText, Globe, Inbox,
  LogOut, Bell, Settings, ChevronLeft, ChevronRight, Puzzle, Link2, Activity, Play,
  Building2,
} from 'lucide-react'
import { useAuthStore } from '../store/auth.store'
import { useActiveContextStore } from '../store/activeContext.store'

// Top-level (everyday) navigation — no design / authoring access required.
const navItems = [
  { to: '/runtime',         label: 'Inbox',              icon: Inbox },
  { to: '/run',             label: 'Start Workflow',     icon: Play },
  { to: '/runs',            label: 'Runs',               icon: Activity },
  { to: '/dashboard',       label: 'Dashboard',          icon: LayoutDashboard },
]

// Administration — the design-time / authoring surface.  Hidden behind a
// header in the sidebar; users with no edit rights see it but can choose to
// ignore it.
const adminItems: { to: string; label: string; icon: typeof LayoutDashboard }[] = [
  { to: '/workflows',         label: 'Workflow Manager',  icon: GitBranch },
  { to: '/artifacts',         label: 'Artifact Studio',   icon: ScrollText },
  { to: '/node-types',        label: 'Node Types',        icon: Puzzle },
  { to: '/global-variables',  label: 'Variables',         icon: Globe },
  { to: '/connectors',        label: 'Connectors',        icon: Link2 },
  { to: '/audit',             label: 'Audit',             icon: FileText },
]

function ActiveContextChip() {
  const navigate = useNavigate()
  const active = useActiveContextStore(s => s.active)
  const memberships = useActiveContextStore(s => s.memberships)
  if (!active) return null
  const switchable = memberships.length > 1
  return (
    <button
      onClick={() => switchable && navigate('/context-picker')}
      title={switchable ? 'Switch capability or role' : `Single capability — ${active.capabilityName}`}
      disabled={!switchable}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 10px', borderRadius: 20,
        border: '1px solid var(--color-outline-variant)',
        background: 'var(--color-surface-container-low, rgba(0,0,0,0.02))',
        fontSize: 11, fontWeight: 600, color: 'var(--color-on-surface)',
        cursor: switchable ? 'pointer' : 'default',
      }}
    >
      <Building2 size={11} style={{ opacity: 0.6 }} />
      <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {active.capabilityName}
      </span>
      <span style={{
        padding: '1px 6px', borderRadius: 8,
        background: active.isCapabilityOwner ? 'rgba(251,191,36,0.15)' : 'rgba(0,132,61,0.10)',
        color: active.isCapabilityOwner ? '#b45309' : 'var(--color-primary)',
        fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
      }}>
        {active.roleName}
      </span>
    </button>
  )
}

function NavItem({ to, label, icon: Icon, collapsed }: { to: string; label: string; icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>; collapsed: boolean }) {
  return (
    <NavLink to={to} className="block">
      {({ isActive }) => (
        <div
          className="nav-item"
          title={collapsed ? label : undefined}
          style={{
            padding: collapsed ? '8px' : undefined,
            justifyContent: collapsed ? 'center' : undefined,
            ...(isActive ? {
              background: 'rgba(245,242,234,0.08)',
              color: 'var(--brand-warm-white)',
              fontWeight: 600,
            } : {}),
          }}
        >
          {isActive && (
            <motion.div
              layoutId="sing-nav-indicator"
              style={{
                position: 'absolute', ...(collapsed ? { left: 0, top: '50%', transform: 'translateY(-50%)', width: 3, height: 20, borderRadius: '0 2px 2px 0' } : { right: 0, top: '50%', transform: 'translateY(-50%)', width: 3, height: 20, borderRadius: '2px 0 0 2px' }),
                background: 'var(--brand-green-accent)',
                boxShadow: '0 0 8px rgba(0,166,81,0.45)',
              }}
            />
          )}
          <Icon
            className="w-4 h-4 shrink-0"
            style={{ color: isActive ? 'var(--brand-green-accent)' : 'rgba(245,242,234,0.5)' }}
          />
          {!collapsed && <span>{label}</span>}
        </div>
      )}
    </NavLink>
  )
}

export function AppLayout() {
  const { user, logout } = useAuthStore()
  const clearContext = useActiveContextStore(s => s.clear)
  const navigate = useNavigate()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('sidebar-collapsed') === 'true'
  })

  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', String(sidebarCollapsed))
  }, [sidebarCollapsed])

  function handleLogout() {
    logout()
    clearContext()
    navigate('/login')
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--color-surface)' }}>

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="shell-sidebar" style={{
        width: sidebarCollapsed ? 80 : 280,
        transition: 'width 0.24s ease-out',
      }}>

        {/* Brand */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: sidebarCollapsed ? 'space-around' : 'space-between',
          gap: sidebarCollapsed ? 0 : 12,
          padding: '18px 16px 14px',
          borderBottom: '1px solid rgba(245,242,234,0.08)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, minWidth: 0,
            opacity: sidebarCollapsed ? 0 : 1,
            transition: 'opacity 0.2s',
            pointerEvents: sidebarCollapsed ? 'none' : 'auto',
          }}>
            <img
              src="/singularity-mark.png"
              alt="Singularity"
              width={40}
              height={40}
              style={{
                flexShrink: 0,
                filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.18))',
                userSelect: 'none',
              }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/singularity-logo.png' }}
            />
            <div>
              <h2 style={{
                fontFamily: "var(--font-sans)",
                fontSize: '0.9375rem', fontWeight: 700,
                color: 'var(--brand-warm-white)',
                letterSpacing: '0.04em', lineHeight: 1.2,
              }}>
                Singularity
              </h2>
              <p style={{
                fontSize: '0.5625rem', fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: '0.18em',
                color: 'rgba(245,242,234,0.55)', opacity: 1, marginTop: 1,
              }}>
                Governed Agentic Delivery
              </p>
            </div>
          </div>
          <button
            onClick={() => setSidebarCollapsed(c => !c)}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            style={{
              width: 32, height: 32, borderRadius: 8, border: 'none',
              background: 'rgba(245,242,234,0.08)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--brand-green-accent)', transition: 'all 0.15s',
              flexShrink: 0,
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(245,242,234,0.14)'
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(245,242,234,0.08)'
            }}
          >
            {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
        </div>

        {/* User info */}
        <div style={{
          padding: sidebarCollapsed ? '10px 8px' : '10px 16px',
          borderBottom: '1px solid rgba(245,242,234,0.08)',
          display: 'flex', alignItems: 'center', justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
          gap: 10,
          opacity: sidebarCollapsed ? 0.6 : 1,
          transition: 'opacity 0.2s',
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: "'Public Sans', sans-serif",
            fontSize: 13, fontWeight: 700,
            background: 'rgba(0,166,81,0.18)', color: 'var(--brand-warm-white)',
            border: '1.5px solid rgba(0,166,81,0.35)',
          }}>
            {user?.displayName?.charAt(0) ?? 'U'}
          </div>
          {!sidebarCollapsed && (
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: 'rgba(245,242,234,0.9)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {user?.displayName}
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
                <span className="status-dot active" />
                <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'rgba(245,242,234,0.45)' }}>
                  Online
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav style={{ flex: 1, overflowY: 'auto', padding: '12px 8px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {navItems.map(item => <NavItem key={item.to} {...item} collapsed={sidebarCollapsed} />)}
          </div>

          {!sidebarCollapsed && (
            <div style={{ marginTop: 24 }}>
              <p className="label-xs" style={{ padding: '0 12px', marginBottom: 6 }}>Administration</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {adminItems.map(item => <NavItem key={item.to} {...item} collapsed={sidebarCollapsed} />)}
              </div>
            </div>
          )}
          {sidebarCollapsed && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {adminItems.map(item => <NavItem key={item.to} {...item} collapsed={sidebarCollapsed} />)}
            </div>
          )}
        </nav>

        {/* Sign out */}
        <div style={{ padding: '8px 8px 16px', borderTop: '1px solid rgba(245,242,234,0.08)' }}>
          <button
            onClick={handleLogout}
            title="Sign out"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
              gap: 8, width: '100%',
              padding: '8px 12px', borderRadius: 12, border: 'none', cursor: 'pointer',
              background: 'transparent', color: 'rgba(245,242,234,0.45)',
              fontSize: 14, fontWeight: 500, transition: 'all 0.15s',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(220,38,38,0.07)'
              ;(e.currentTarget as HTMLButtonElement).style.color = '#dc2626'
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
              ;(e.currentTarget as HTMLButtonElement).style.color = 'rgba(245,242,234,0.45)'
            }}
          >
            <LogOut size={15} />
            {!sidebarCollapsed && <span>Sign out</span>}
          </button>
        </div>
      </aside>

      {/* ── Right column ────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Topbar */}
        <header className="shell-topbar" style={{ height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px' }}>
          {/* Breadcrumb / workspace badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '4px 10px', borderRadius: 20,
              border: '1px solid rgba(0,132,61,0.18)',
              background: 'rgba(0,132,61,0.06)',
              fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.14em', color: 'var(--color-primary)',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-primary)', flexShrink: 0 }} />
              Workflow
            </span>
            <ActiveContextChip />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              style={{
                width: 32, height: 32, borderRadius: 10, border: '1px solid var(--color-outline-variant)',
                background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--color-outline)', transition: 'all 0.15s',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-surface-container)'
                ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--color-on-surface)'
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--color-outline)'
              }}
            >
              <Bell size={15} />
            </button>
            <button
              style={{
                width: 32, height: 32, borderRadius: 10, border: '1px solid var(--color-outline-variant)',
                background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--color-outline)', transition: 'all 0.15s',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-surface-container)'
                ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--color-on-surface)'
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                ;(e.currentTarget as HTMLButtonElement).style.color = 'var(--color-outline)'
              }}
            >
              <Settings size={15} />
            </button>
            <div style={{ width: 1, height: 20, background: 'var(--color-outline-variant)', margin: '0 2px' }} />
            <div style={{
              width: 32, height: 32, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: "'Public Sans', sans-serif",
              fontSize: 12, fontWeight: 700,
              background: 'rgba(0,132,61,0.12)', color: 'var(--color-primary)',
              border: '1.5px solid rgba(0,132,61,0.2)',
              cursor: 'default',
            }}>
              {user?.displayName?.charAt(0) ?? 'U'}
            </div>
          </div>
        </header>

        {/* Page content */}
        <main style={{ flex: 1, overflow: 'auto' }}>
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
              style={{ height: '100%' }}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  )
}
