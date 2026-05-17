import { useMemo, useState } from 'react'
import type { ComponentType, CSSProperties, FocusEvent } from 'react'
import { Bot, ExternalLink, Grid3X3, ServerCog, ShieldCheck, Workflow, Wrench } from 'lucide-react'

type AppLink = {
  id: string
  label: string
  href: string
  description: string
  icon: ComponentType<{ size?: number; style?: CSSProperties }>
}

function localUrl(port: number, path = '') {
  return `${window.location.protocol}//${window.location.hostname}:${port}${path}`
}

function useAppLinks(): AppLink[] {
  return useMemo(() => [
    { id: 'operations', label: 'Operations', href: import.meta.env.VITE_LINK_OPERATIONS_PORTAL ?? localUrl(5180, '/operations'), description: 'Health, setup, audit, readiness', icon: ServerCog },
    { id: 'agent-studio', label: 'Agent Studio', href: import.meta.env.VITE_LINK_AGENT_ADMIN ?? localUrl(3000), description: 'Agents, tools, capabilities', icon: Bot },
    { id: 'workflow', label: 'Workflow Manager', href: import.meta.env.VITE_LINK_WORKGRAPH_DESIGNER ?? localUrl(5174), description: 'Runs, WorkItems, approvals', icon: Workflow },
    { id: 'workbench', label: 'Blueprint Workbench', href: import.meta.env.VITE_LINK_BLUEPRINT_WORKBENCH ?? localUrl(5176, '/?ui=neo'), description: 'Guided delivery cockpit', icon: Wrench },
    { id: 'iam', label: 'Identity & Access', href: import.meta.env.VITE_LINK_IAM_ADMIN ?? localUrl(5175), description: 'Users, teams, roles', icon: ShieldCheck },
  ], [])
}

export function AppSwitcher({ currentApp = 'iam' }: { currentApp?: string }) {
  const links = useAppLinks()
  const [open, setOpen] = useState(false)
  const current = links.find(item => item.id === currentApp) ?? links[0]

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
        className="w-full"
        title="Switch Singularity app"
        style={{
          minHeight: 40,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          borderRadius: 12,
          border: '1px solid rgba(245,242,234,0.12)',
          background: open ? 'rgba(245,242,234,0.12)' : 'rgba(245,242,234,0.06)',
          color: '#F5F2EA',
          cursor: 'pointer',
          padding: '0 12px',
          fontSize: 13,
          fontWeight: 700,
        }}
      >
        <span className="flex items-center gap-2 min-w-0">
          <Grid3X3 size={15} style={{ color: '#00A651' }} />
          <span className="truncate">{current.label}</span>
        </span>
        <ExternalLink size={13} style={{ color: 'rgba(245,242,234,0.48)' }} />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            left: 12,
            right: 12,
            top: 58,
            zIndex: 80,
            border: '1px solid rgba(245,242,234,0.16)',
            borderRadius: 14,
            background: '#102f27',
            boxShadow: '0 18px 44px rgba(0,0,0,0.35)',
            padding: 8,
          }}
        >
          {links.map(item => {
            const Icon = item.icon
            const active = item.id === currentApp
            return (
              <a
                key={item.id}
                href={item.href}
                role="menuitem"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  borderRadius: 10,
                  padding: '10px',
                  color: '#F5F2EA',
                  background: active ? 'rgba(0,166,81,0.20)' : 'transparent',
                  textDecoration: 'none',
                }}
              >
                <Icon size={16} style={{ color: active ? '#00A651' : 'rgba(245,242,234,0.68)', flexShrink: 0 }} />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 800 }}>{item.label}</span>
                  <span style={{ display: 'block', marginTop: 1, fontSize: 11, color: 'rgba(245,242,234,0.48)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item.description}
                  </span>
                </span>
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}
