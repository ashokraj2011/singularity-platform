import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { Users } from 'lucide-react'
import { api } from '../../lib/api'

type User = { id: string; email: string; displayName: string; isActive: boolean; team?: { name: string } }

export function UsersPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get('/users').then(r => r.data),
  })

  const items: User[] = data?.content ?? (Array.isArray(data) ? data : [])
  const active = items.filter(u => u.isActive).length

  return (
    <div className="p-6 max-w-3xl">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Users className="w-5 h-5" style={{ color: '#22d3ee' }} />
          <h1 className="page-header">Users</h1>
        </div>
        <p className="text-sm text-slate-500 font-mono">{active} active · {items.length} total</p>
      </motion.div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-14 rounded-xl" />)}
        </div>
      ) : (
        <div className="glass-card rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
          {items.length === 0 ? (
            <div className="py-16 text-center">
              <Users className="w-10 h-10 text-slate-700 mx-auto mb-3" />
              <p className="text-slate-500 text-sm">No users found</p>
            </div>
          ) : (
            items.map((u, i) => (
              <motion.div
                key={u.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.2, delay: i * 0.04 }}
                className="flex items-center gap-4 px-4 py-3 hover:bg-white/[0.02] transition-colors"
                style={{ borderBottom: i < items.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}
              >
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-semibold"
                  style={{ background: 'rgba(34,211,238,0.1)', color: '#22d3ee', border: '1px solid rgba(34,211,238,0.2)' }}
                >
                  {u.displayName.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-200 truncate">{u.displayName}</p>
                  <p className="text-xs text-slate-500 truncate">
                    {u.email}{u.team ? ` · ${u.team.name}` : ''}
                  </p>
                </div>
                <span className="flex items-center gap-1.5 shrink-0">
                  <span
                    className={`status-dot ${u.isActive ? 'active' : ''}`}
                    style={!u.isActive ? { background: '#475569' } : {}}
                  />
                  <span className="text-xs font-mono" style={{ color: u.isActive ? '#10b981' : '#64748b' }}>
                    {u.isActive ? 'ACTIVE' : 'INACTIVE'}
                  </span>
                </span>
              </motion.div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
