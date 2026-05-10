import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { ShieldCheck, Lock } from 'lucide-react'
import { api } from '../../lib/api'

type Role = { id: string; name: string; description?: string; isSystemRole: boolean }

export function RolesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get('/roles').then(r => r.data),
  })

  const items: Role[] = data?.content ?? (Array.isArray(data) ? data : [])
  const systemRoles = items.filter(r => r.isSystemRole).length

  return (
    <div className="p-6 max-w-3xl">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className="w-5 h-5" style={{ color: '#22d3ee' }} />
          <h1 className="page-header">Roles</h1>
        </div>
        <p className="text-sm text-slate-500 font-mono">{systemRoles} system · {items.length - systemRoles} custom</p>
      </motion.div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-14 rounded-xl" />)}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((role, i) => (
            <motion.div
              key={role.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2, delay: i * 0.04 }}
              className="glass-card rounded-xl p-4 hover:bg-white/[0.02] transition-all duration-200"
              style={{ border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={
                    role.isSystemRole
                      ? { background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.15)' }
                      : { background: 'rgba(100,116,139,0.08)', border: '1px solid rgba(100,116,139,0.15)' }
                  }
                >
                  {role.isSystemRole
                    ? <Lock className="w-3.5 h-3.5" style={{ color: '#22d3ee' }} />
                    : <ShieldCheck className="w-3.5 h-3.5" style={{ color: '#64748b' }} />
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-slate-200 truncate">{role.name}</p>
                  {role.description && (
                    <p className="text-xs text-slate-500 truncate mt-0.5">{role.description}</p>
                  )}
                </div>
                {role.isSystemRole && (
                  <span
                    className="text-xs font-mono px-2 py-0.5 rounded-md shrink-0"
                    style={{ background: 'rgba(34,211,238,0.08)', color: '#22d3ee', border: '1px solid rgba(34,211,238,0.15)' }}
                  >
                    SYSTEM
                  </span>
                )}
              </div>
            </motion.div>
          ))}

          {items.length === 0 && (
            <div className="glass-panel rounded-xl py-16 text-center">
              <ShieldCheck className="w-10 h-10 text-slate-700 mx-auto mb-3" />
              <p className="text-slate-500 text-sm">No roles configured</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
