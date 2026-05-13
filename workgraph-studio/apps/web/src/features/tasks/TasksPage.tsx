import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { CheckSquare, Clock, Loader2 } from 'lucide-react'
import { api } from '../../lib/api'

type Task = { id: string; title: string; status: string; priority: number; dueAt?: string }

const statusColor: Record<string, string> = {
  OPEN: '#f59e0b',
  IN_PROGRESS: '#22d3ee',
  COMPLETED: '#10b981',
  CANCELLED: '#64748b',
}

export function TasksPage() {
  const qc = useQueryClient()

  const { data: tasks, isLoading } = useQuery({
    queryKey: ['tasks', 'my-work'],
    queryFn: () => api.get('/tasks/my-work').then(r => r.data),
    refetchInterval: 10_000,
  })

  const claim = useMutation({
    mutationFn: (id: string) => api.post(`/tasks/${id}/claim`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  })

  const complete = useMutation({
    mutationFn: (id: string) => api.post(`/tasks/${id}/complete`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  })

  const taskList: Task[] = tasks?.content ?? (Array.isArray(tasks) ? tasks : [])

  return (
    <div className="p-6 max-w-3xl">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <CheckSquare className="w-5 h-5" style={{ color: '#22d3ee' }} />
          <h1 className="page-header">Inbox</h1>
        </div>
        <p className="text-sm text-slate-500 font-mono">{taskList.length} tasks · {taskList.filter(t => t.status === 'OPEN').length} open</p>
      </motion.div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-16 rounded-xl" />)}
        </div>
      ) : (
        <div className="space-y-2">
          {taskList.map((task, i) => {
            const color = statusColor[task.status] ?? '#64748b'
            return (
              <motion.div
                key={task.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25, delay: i * 0.04 }}
                className="glass-card rounded-xl p-4"
                style={{ border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <div className="flex items-center gap-3">
                  <div className="w-1 h-10 rounded-full shrink-0" style={{ background: color }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-200 truncate">{task.title}</p>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span
                        className="text-xs font-mono px-1.5 py-0.5 rounded"
                        style={{ background: `${color}15`, color, border: `1px solid ${color}20` }}
                      >
                        {task.status}
                      </span>
                      {task.dueAt && (
                        <span className="flex items-center gap-1 text-xs text-slate-600">
                          <Clock className="w-3 h-3" />
                          {new Date(task.dueAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {task.status === 'OPEN' && (
                      <button
                        className="btn-outline text-xs px-3 py-1.5"
                        onClick={() => claim.mutate(task.id)}
                        disabled={claim.isPending}
                      >
                        {claim.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Claim'}
                      </button>
                    )}
                    {task.status === 'IN_PROGRESS' && (
                      <button
                        className="btn-primary text-xs px-3 py-1.5"
                        onClick={() => complete.mutate(task.id)}
                        disabled={complete.isPending}
                      >
                        {complete.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Complete'}
                      </button>
                    )}
                  </div>
                </div>
              </motion.div>
            )
          })}
          {taskList.length === 0 && (
            <div className="glass-panel rounded-xl py-16 text-center">
              <CheckSquare className="w-10 h-10 text-slate-700 mx-auto mb-3" />
              <p className="text-slate-500 text-sm">No tasks assigned to you</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
