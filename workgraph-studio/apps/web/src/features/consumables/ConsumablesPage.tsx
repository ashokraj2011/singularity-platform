import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { Package, FileStack } from 'lucide-react'
import { api } from '../../lib/api'

type Consumable = { id: string; name: string; status: string; currentVersion: number; type?: { name: string } }

const statusColor: Record<string, string> = {
  DRAFT: '#64748b',
  UNDER_REVIEW: '#f59e0b',
  APPROVED: '#22d3ee',
  PUBLISHED: '#10b981',
  CONSUMED: '#8b5cf6',
  REJECTED: '#ef4444',
  SUPERSEDED: '#475569',
}

export function ConsumablesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['consumables'],
    queryFn: () => api.get('/consumables').then(r => r.data),
  })

  const items: Consumable[] = data?.content ?? (Array.isArray(data) ? data : [])

  const published = items.filter(c => c.status === 'PUBLISHED').length
  const pending = items.filter(c => c.status === 'UNDER_REVIEW').length

  return (
    <div className="p-6 max-w-4xl">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Package className="w-5 h-5" style={{ color: '#22d3ee' }} />
          <h1 className="page-header">Consumables</h1>
        </div>
        <p className="text-sm text-slate-500 font-mono">
          {items.length} total · {published} published · {pending} under review
        </p>
      </motion.div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-16 rounded-xl" />)}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((c, i) => {
            const color = statusColor[c.status] ?? '#64748b'
            return (
              <motion.div
                key={c.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25, delay: i * 0.04 }}
                className="glass-card rounded-xl p-4 hover:bg-white/[0.02] transition-all duration-200"
                style={{ border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                    style={{ background: `${color}12`, border: `1px solid ${color}20` }}
                  >
                    <FileStack className="w-3.5 h-3.5" style={{ color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-200 truncate">{c.name}</p>
                    <p className="text-xs text-slate-500 font-mono mt-0.5">
                      {c.type?.name ?? 'Unknown type'} · v{c.currentVersion}
                    </p>
                  </div>
                  <span
                    className="text-xs font-mono px-2 py-0.5 rounded-md shrink-0"
                    style={{ background: `${color}12`, color, border: `1px solid ${color}20` }}
                  >
                    {c.status}
                  </span>
                </div>
              </motion.div>
            )
          })}

          {items.length === 0 && (
            <div className="glass-panel rounded-xl py-16 text-center">
              <Package className="w-10 h-10 text-slate-700 mx-auto mb-3" />
              <p className="text-slate-500 text-sm">No consumables yet</p>
              <p className="text-slate-600 text-xs mt-1">Consumables are created by workflow nodes</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
