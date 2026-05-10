import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'motion/react'
import { Building2, ShieldCheck, ChevronRight, Crown } from 'lucide-react'
import { useActiveContextStore, type Membership } from '../../store/activeContext.store'
import { useAuthStore } from '../../store/auth.store'

export function ContextPickerPage() {
  const navigate = useNavigate()
  const memberships = useActiveContextStore(s => s.memberships)
  const setActive = useActiveContextStore(s => s.setActive)
  const user = useAuthStore(s => s.user)

  // Group memberships by capability so the user picks capability first, then
  // the role they want to play in that capability.
  const byCapability = useMemo(() => {
    const map = new Map<string, { capabilityName: string; teamName: string; roles: Membership[] }>()
    for (const m of memberships) {
      const existing = map.get(m.capability_id)
      if (existing) existing.roles.push(m)
      else map.set(m.capability_id, { capabilityName: m.capability_name, teamName: m.team_name, roles: [m] })
    }
    return Array.from(map.entries()).map(([id, v]) => ({ id, ...v }))
  }, [memberships])

  const [selectedCapability, setSelectedCapability] = useState<string | null>(
    byCapability.length === 1 ? byCapability[0].id : null,
  )

  function pickRole(m: Membership) {
    setActive(m)
    navigate('/dashboard')
  }

  if (memberships.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#020617' }}>
        <div className="glass-panel rounded-2xl p-8 max-w-sm text-center">
          <p className="text-slate-300 mb-4">No capabilities are assigned to your account.</p>
          <button
            onClick={() => navigate('/login')}
            className="text-xs underline"
            style={{ color: '#22d3ee' }}
          >
            Back to sign in
          </button>
        </div>
      </div>
    )
  }

  const selected = byCapability.find(c => c.id === selectedCapability) ?? null

  return (
    <div className="min-h-screen flex items-center justify-center canvas-grid" style={{ background: '#020617' }}>
      <div
        className="fixed inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse 60% 50% at 50% -10%, rgba(34,211,238,0.06) 0%, transparent 70%)' }}
      />
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className="relative w-full max-w-2xl"
      >
        <div
          className="glass-panel rounded-2xl p-8"
          style={{ boxShadow: '0 0 40px rgba(34,211,238,0.06), 0 25px 50px rgba(0,0,0,0.5)' }}
        >
          <div className="mb-6">
            <h2 className="text-lg font-semibold text-slate-100">Choose your working context</h2>
            <p className="text-sm text-slate-500 mt-1">
              Signed in as <span className="text-slate-300">{user?.email ?? 'unknown'}</span>. You belong to multiple capabilities — pick one to continue.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Capabilities */}
            <div>
              <h3 className="label-xs mb-2">Capability</h3>
              <div className="space-y-1.5">
                {byCapability.map(c => (
                  <button
                    key={c.id}
                    onClick={() => setSelectedCapability(c.id)}
                    className="w-full text-left rounded-lg px-3 py-2.5 flex items-center gap-2 transition-all"
                    style={{
                      background: selectedCapability === c.id ? 'rgba(34,211,238,0.12)' : 'rgba(15,23,42,0.6)',
                      border: `1px solid ${selectedCapability === c.id ? 'rgba(34,211,238,0.5)' : 'rgba(255,255,255,0.06)'}`,
                    }}
                  >
                    <Building2 className="w-4 h-4 shrink-0" style={{ color: selectedCapability === c.id ? '#22d3ee' : '#64748b' }} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-slate-200 truncate">{c.capabilityName}</div>
                      <div className="text-[10px] text-slate-500 truncate">{c.teamName} · {c.roles.length} role{c.roles.length === 1 ? '' : 's'}</div>
                    </div>
                    {selectedCapability === c.id && <ChevronRight className="w-3.5 h-3.5" style={{ color: '#22d3ee' }} />}
                  </button>
                ))}
              </div>
            </div>

            {/* Roles for selected capability */}
            <div>
              <h3 className="label-xs mb-2">Role</h3>
              {selected ? (
                <div className="space-y-1.5">
                  {selected.roles.map(m => (
                    <button
                      key={`${m.capability_id}-${m.role_key}`}
                      onClick={() => pickRole(m)}
                      className="w-full text-left rounded-lg px-3 py-2.5 flex items-center gap-2 transition-all"
                      style={{
                        background: 'rgba(15,23,42,0.6)',
                        border: '1px solid rgba(255,255,255,0.06)',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = 'rgba(34,211,238,0.4)' }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)' }}
                    >
                      {m.is_capability_owner
                        ? <Crown className="w-4 h-4 shrink-0" style={{ color: '#fbbf24' }} />
                        : <ShieldCheck className="w-4 h-4 shrink-0" style={{ color: '#64748b' }} />}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-slate-200">{m.role_name}</div>
                        <div className="text-[10px] text-slate-500 font-mono">{m.role_key}</div>
                      </div>
                      <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-slate-500 px-3 py-2.5 rounded-lg" style={{ background: 'rgba(15,23,42,0.4)', border: '1px dashed rgba(255,255,255,0.06)' }}>
                  Select a capability to see your roles.
                </div>
              )}
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-white/[0.06] flex items-center justify-between">
            <p className="text-[11px] text-slate-500">
              You can switch capability or role anytime from the topbar.
            </p>
            <button
              onClick={() => navigate('/login')}
              className="text-[11px] underline"
              style={{ color: '#64748b' }}
            >
              Sign out
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}
