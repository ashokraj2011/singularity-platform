import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'motion/react'
import { Inbox, History, ArrowLeft, LogOut } from 'lucide-react'
import { useAuthStore } from '../../store/auth.store'

/**
 * Lightweight shell for the end-user runtime UI.  Lives at /runtime/* and
 * is intentionally separate from the studio chrome — assignees should not
 * see the workflow palette / canvas / admin tools.
 */
export function RuntimeShell() {
  const navigate = useNavigate()
  const user = useAuthStore(s => s.user)
  const logout = useAuthStore(s => s.logout)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--color-surface)' }}>
      {/* Top bar */}
      <header style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: '12px 22px', borderBottom: '1px solid var(--color-outline-variant)',
        background: '#fff', flexShrink: 0,
      }}>
        <button
          onClick={() => navigate('/dashboard')}
          title="Back to designer"
          style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8,
            border: '1px solid var(--color-outline-variant)', background: 'transparent',
            cursor: 'pointer', color: 'var(--color-outline)', fontSize: 12, fontWeight: 600,
          }}
        >
          <ArrowLeft size={12} /> Designer
        </button>

        <div style={{ width: 1, height: 22, background: 'var(--color-outline-variant)' }} />

        <h1 style={{ fontSize: 16, fontWeight: 800, color: 'var(--color-on-surface)', letterSpacing: '-0.01em' }}>
          Inbox
        </h1>

        <nav style={{ marginLeft: 14, display: 'flex', gap: 4 }}>
          <RuntimeNavLink to="/runtime"          icon={<Inbox size={13} />}   label="Inbox"   end />
          <RuntimeNavLink to="/runtime/history"  icon={<History size={13} />} label="History" />
        </nav>

        <span style={{ flex: 1 }} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span style={{ fontSize: 12, color: 'var(--color-outline)' }}>
            {user?.displayName ?? user?.email ?? 'Anonymous'}
          </span>
          <button
            onClick={() => { logout(); navigate('/login') }}
            title="Sign out"
            style={{
              width: 28, height: 28, borderRadius: 8, border: '1px solid var(--color-outline-variant)',
              background: 'transparent', cursor: 'pointer', color: 'var(--color-outline)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <LogOut size={12} />
          </button>
        </div>
      </header>

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
  )
}

function RuntimeNavLink({ to, icon, label, end }: { to: string; icon: React.ReactNode; label: string; end?: boolean }) {
  return (
    <NavLink to={to} end={end}>
      {({ isActive }) => (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '6px 12px', borderRadius: 8,
          fontSize: 12, fontWeight: 600,
          background: isActive ? 'rgba(0,132,61,0.10)' : 'transparent',
          color:      isActive ? '#00843D' : 'var(--color-outline)',
          border: `1px solid ${isActive ? 'rgba(0,132,61,0.25)' : 'transparent'}`,
        }}>
          {icon} {label}
        </span>
      )}
    </NavLink>
  )
}
