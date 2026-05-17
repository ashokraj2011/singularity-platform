import { useState } from 'react'
import type { ComponentType, CSSProperties, FocusEvent } from 'react'
import { Bot, ExternalLink, Grid3X3, ServerCog, ShieldCheck, Workflow, Wrench } from 'lucide-react'
import { env } from '@/lib/env'

type AppLink = {
  id: string
  label: string
  href: string
  description: string
  icon: ComponentType<{ size?: number; style?: CSSProperties }>
}

const appLinks: AppLink[] = [
  { id: 'operations', label: 'Operations', href: `${env.links.operationsPortal}/operations`, description: 'Health, setup, audit, readiness', icon: ServerCog },
  { id: 'agent-studio', label: 'Agent Studio', href: env.links.agentAdmin, description: 'Agents, tools, capabilities', icon: Bot },
  { id: 'workflow', label: 'Workflow Manager', href: env.links.workgraphDesigner, description: 'Runs, WorkItems, approvals', icon: Workflow },
  { id: 'workbench', label: 'Blueprint Workbench', href: `${env.links.blueprintWorkbench}/?ui=neo`, description: 'Guided delivery cockpit', icon: Wrench },
  { id: 'iam', label: 'Identity & Access', href: env.links.iamAdmin, description: 'Users, teams, roles', icon: ShieldCheck },
]

export function AppSwitcher({ currentApp = 'operations' }: { currentApp?: string }) {
  const [open, setOpen] = useState(false)
  const current = appLinks.find(item => item.id === currentApp) ?? appLinks[0]

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
  }

  return (
    <div className="px-3 pt-3" onBlur={onBlur} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex min-h-10 w-full items-center justify-between gap-2 rounded-xl border px-3 text-sm font-bold transition"
        style={{
          borderColor: 'rgba(245,242,234,0.12)',
          background: open ? 'rgba(245,242,234,0.12)' : 'rgba(245,242,234,0.06)',
          color: 'var(--brand-warm-white)',
        }}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Grid3X3 className="h-4 w-4 shrink-0" style={{ color: 'var(--brand-green-accent)' }} />
          <span className="truncate">{current.label}</span>
        </span>
        <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-50" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-3 right-3 top-[58px] z-50 rounded-2xl p-2 shadow-2xl"
          style={{ border: '1px solid rgba(245,242,234,0.16)', background: '#102f27' }}
        >
          {appLinks.map(item => {
            const Icon = item.icon
            const active = item.id === currentApp
            return (
              <a
                key={item.id}
                href={item.href}
                role="menuitem"
                className="flex items-center gap-2.5 rounded-xl p-2.5 no-underline"
                style={{
                  color: 'var(--brand-warm-white)',
                  background: active ? 'rgba(0,166,81,0.20)' : 'transparent',
                }}
              >
                <Icon size={16} style={{ color: active ? 'var(--brand-green-accent)' : 'rgba(245,242,234,0.68)', flexShrink: 0 }} />
                <span className="min-w-0">
                  <span className="block text-[13px] font-extrabold">{item.label}</span>
                  <span className="mt-0.5 block truncate text-[11px]" style={{ color: 'rgba(245,242,234,0.48)' }}>{item.description}</span>
                </span>
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}
