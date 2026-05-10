import { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn('rounded-xl bg-white shadow-sm', className)}
      style={{ border: '1px solid #E2E8F0' }}
    >
      {children}
    </div>
  )
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
}) {
  return (
    <div
      className="flex items-start justify-between px-5 py-4"
      style={{ borderBottom: '1px solid #F1F5F9' }}
    >
      <div>
        <div className="text-sm font-semibold" style={{ color: '#0A2240' }}>{title}</div>
        {subtitle && <div className="mt-0.5 text-xs" style={{ color: '#64748b' }}>{subtitle}</div>}
      </div>
      {action}
    </div>
  )
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-5 py-4', className)}>{children}</div>
}
