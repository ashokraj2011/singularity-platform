import type { LucideIcon } from 'lucide-react'

interface StatCardProps {
  label: string
  value: string | number
  icon: LucideIcon
  iconBg?: string
  iconColor?: string
}

export function StatCard({
  label,
  value,
  icon: Icon,
  iconBg = '#e6f4ed',
  iconColor = '#00843D',
}: StatCardProps) {
  return (
    <div
      className="bg-white rounded-xl p-5 flex flex-col gap-3"
      style={{
        border: '1px solid #E2E8F0',
        boxShadow: '0 1px 3px rgba(10,34,64,0.06)',
      }}
    >
      <div className="flex items-center justify-between">
        <p
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: '#94a3b8' }}
        >
          {label}
        </p>
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ background: iconBg }}
        >
          <Icon className="w-4 h-4" style={{ color: iconColor }} />
        </div>
      </div>
      <p
        className="text-3xl font-bold leading-none"
        style={{ color: '#0A2240' }}
      >
        {value}
      </p>
    </div>
  )
}
