import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'motion/react'
import { Plus, Briefcase, X, Loader2 } from 'lucide-react'
import { api } from '../../lib/api'

const statusColor: Record<string, string> = {
  DRAFT: '#64748b',
  ACTIVE: '#22d3ee',
  COMPLETED: '#10b981',
  CANCELLED: '#ef4444',
}

function StatusBadge({ status }: { status: string }) {
  const color = statusColor[status] ?? '#64748b'
  return (
    <span
      className="text-xs font-mono px-2 py-0.5 rounded-md"
      style={{ background: `${color}15`, color, border: `1px solid ${color}25` }}
    >
      {status}
    </span>
  )
}

export function InitiativeListPage() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['initiatives'],
    queryFn: () => api.get('/initiatives').then(r => r.data),
  })

  const create = useMutation({
    mutationFn: (body: { title: string; description: string }) => api.post('/initiatives', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['initiatives'] })
      setOpen(false)
      setTitle('')
      setDescription('')
    },
  })

  const items: Array<{ id: string; title: string; description: string; status: string; createdAt: string }> =
    data?.content ?? (Array.isArray(data) ? data : [])

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
        className="flex items-start justify-between mb-6"
      >
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Briefcase className="w-5 h-5" style={{ color: '#22d3ee' }} />
            <h1 className="page-header">Initiatives</h1>
          </div>
          <p className="text-sm text-slate-500 font-mono">{items.length} total · Business delivery programs</p>
        </div>
        <button className="btn-primary flex items-center gap-2" onClick={() => setOpen(true)}>
          <Plus className="w-4 h-4" />
          New Initiative
        </button>
      </motion.div>

      {/* Create modal */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: 'rgba(2,6,23,0.8)', backdropFilter: 'blur(8px)' }}
            onClick={() => setOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="glass-panel rounded-2xl p-6 w-full max-w-md"
              style={{ boxShadow: '0 0 40px rgba(34,211,238,0.06), 0 25px 50px rgba(0,0,0,0.5)' }}
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-semibold text-slate-100">Create Initiative</h2>
                <button
                  onClick={() => setOpen(false)}
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="label-xs">Title</label>
                  <input
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="Initiative title"
                    className="w-full h-10 rounded-lg px-3 text-sm text-slate-200 placeholder-slate-600 outline-none transition-all duration-200"
                    style={{
                      background: 'rgba(15,23,42,0.8)',
                      border: '1px solid rgba(255,255,255,0.08)',
                    }}
                    onFocus={e => { e.currentTarget.style.borderColor = 'rgba(34,211,238,0.4)' }}
                    onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
                    autoFocus
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="label-xs">Description</label>
                  <textarea
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="What is this initiative about?"
                    rows={3}
                    className="w-full rounded-lg px-3 py-2.5 text-sm text-slate-200 placeholder-slate-600 outline-none resize-none transition-all duration-200"
                    style={{
                      background: 'rgba(15,23,42,0.8)',
                      border: '1px solid rgba(255,255,255,0.08)',
                    }}
                    onFocus={e => { e.currentTarget.style.borderColor = 'rgba(34,211,238,0.4)' }}
                    onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
                  />
                </div>
              </div>

              <div className="flex gap-2 mt-5">
                <button className="btn-outline flex-1" onClick={() => setOpen(false)}>Cancel</button>
                <button
                  className="btn-primary flex-1 flex items-center justify-center gap-2"
                  onClick={() => create.mutate({ title, description })}
                  disabled={!title || create.isPending}
                >
                  {create.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Creating…
                    </>
                  ) : 'Create'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Initiative list */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton h-16 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((initiative, i) => (
            <motion.div
              key={initiative.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.25, delay: i * 0.05 }}
            >
              <Link
                to={`/initiatives/${initiative.id}`}
                className="block glass-card rounded-xl p-4 hover:bg-white/[0.03] transition-all duration-200 group"
                style={{ border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div
                      className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center mt-0.5"
                      style={{ background: 'rgba(34,211,238,0.1)', border: '1px solid rgba(34,211,238,0.15)' }}
                    >
                      <Briefcase className="w-3.5 h-3.5" style={{ color: '#22d3ee' }} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-200 group-hover:text-white transition-colors truncate">
                        {initiative.title}
                      </p>
                      {initiative.description && (
                        <p className="text-xs text-slate-500 mt-0.5 truncate">{initiative.description}</p>
                      )}
                      <p className="text-xs text-slate-600 font-mono mt-1">
                        {new Date(initiative.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <StatusBadge status={initiative.status} />
                </div>
              </Link>
            </motion.div>
          ))}

          {items.length === 0 && (
            <div className="glass-panel rounded-xl py-16 text-center">
              <Briefcase className="w-10 h-10 text-slate-700 mx-auto mb-3" />
              <p className="text-slate-500 text-sm">No initiatives yet</p>
              <p className="text-slate-600 text-xs mt-1">Create one to start a business delivery program</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
