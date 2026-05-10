import type { LucideIcon } from 'lucide-react'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div
        className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
        style={{ background: '#F0F4F8', border: '1px solid #E2E8F0' }}
      >
        <Icon className="w-6 h-6" style={{ color: '#94a3b8' }} />
      </div>
      <p className="text-sm font-semibold" style={{ color: '#0A2240' }}>{title}</p>
      {description && (
        <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
