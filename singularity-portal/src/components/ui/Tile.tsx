import { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>
}

export function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: string
  value: ReactNode
  hint?: string
  className?: string
}) {
  return (
    <div
      className={cn('rounded-lg px-3 py-2', className)}
      style={{ background: '#F0F4F8', border: '1px solid #E2E8F0' }}
    >
      <div className="text-[10px] uppercase tracking-widest font-semibold" style={{ color: '#64748b' }}>
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums" style={{ color: '#0A2240' }}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px]" style={{ color: '#64748b' }}>{hint}</div>}
    </div>
  )
}

export function ListRow({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <div
      className="flex items-center justify-between py-2 last:border-0"
      style={{ borderBottom: '1px solid #F1F5F9' }}
    >
      <div className="min-w-0 flex-1 truncate text-sm" style={{ color: '#0A2240' }}>{left}</div>
      {right && <div className="ml-3 text-xs" style={{ color: '#64748b' }}>{right}</div>}
    </div>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      className="rounded-md px-3 py-6 text-center text-xs"
      style={{ background: '#F8FAFC', color: '#64748b' }}
    >
      {children}
    </div>
  )
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div
      className="rounded-md px-3 py-2 text-xs"
      style={{ background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca' }}
    >
      {message}
    </div>
  )
}

export function LoadingDots() {
  return (
    <div className="flex items-center gap-1 px-1 py-2">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:-0.3s]" style={{ background: '#00843D' }} />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full [animation-delay:-0.15s]" style={{ background: '#00843D' }} />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full" style={{ background: '#00843D' }} />
    </div>
  )
}
