import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { Building2 } from 'lucide-react'
import { api } from '../../lib/api'

type Team = { id: string; name: string; description?: string; department?: { name: string }; _count?: { users: number } }

export function TeamsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['teams'],
    queryFn: () => api.get('/teams').then(r => r.data),
  })

  const items: Team[] = data?.content ?? (Array.isArray(data) ? data : [])

  return (
    <div className="p-6 max-w-4xl">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Building2 className="w-5 h-5" style={{ color: '#22d3ee' }} />
          <h1 className="page-header">Teams</h1>
        </div>
        <p className="text-sm text-slate-500 font-mono">{items.length} teams · Organizational units</p>
      </motion.div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-24 rounded-xl" />)}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((team, i) => (
            <motion.div
              key={team.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: i * 0.05 }}
              className="glass-card rounded-xl p-4 hover:bg-white/[0.03] transition-all duration-200"
              style={{ border: '1px solid rgba(255,255,255,0.06)' }}
            >
              <div className="flex items-start gap-3">
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.15)' }}
                >
                  <Building2 className="w-4 h-4" style={{ color: '#22d3ee' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-200 truncate">{team.name}</p>
                  {team.department && (
                    <p className="text-xs text-slate-500 mt-0.5 truncate">{team.department.name}</p>
                  )}
                  {team.description && (
                    <p className="text-xs text-slate-600 mt-1 line-clamp-2">{team.description}</p>
                  )}
                  {team._count !== undefined && (
                    <p className="text-xs font-mono text-slate-600 mt-1">
                      {team._count.users} member{team._count.users !== 1 ? 's' : ''}
                    </p>
                  )}
                </div>
              </div>
            </motion.div>
          ))}

          {items.length === 0 && (
            <div className="col-span-full glass-panel rounded-xl py-16 text-center">
              <Building2 className="w-10 h-10 text-slate-700 mx-auto mb-3" />
              <p className="text-slate-500 text-sm">No teams configured</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
