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

export function AppSwitcher({ currentApp = 'workflow' }: { currentApp?: string }) {
  const links = useAppLinks()
  const [open, setOpen] = useState(false)
  const current = links.find(item => item.id === currentApp) ?? links[0]

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
  }

  return (
    <div style={{ position: 'relative' }} onBlur={onBlur}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Switch Singularity app"
        style={{
          height: 32,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          borderRadius: 10,
          border: '1px solid var(--color-outline-variant)',
          background: open ? 'var(--color-surface-container)' : 'transparent',
          color: 'var(--color-on-surface)',
          cursor: 'pointer',
          padding: '0 10px',
          fontSize: 12,
          fontWeight: 700,
          transition: 'all 0.15s',
        }}
      >
        <Grid3X3 size={14} style={{ color: 'var(--color-primary)' }} />
        <span>{current.label}</span>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            right: 0,
            top: 40,
            width: 300,
            zIndex: 80,
            border: '1px solid var(--color-outline-variant)',
            borderRadius: 14,
            background: '#fff',
            boxShadow: '0 18px 44px rgba(12,23,39,0.18)',
            padding: 8,
          }}
        >
          <div style={{ padding: '8px 10px 10px', fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.12em', color: 'var(--color-outline)' }}>
            Singularity Apps
          </div>
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
                  color: 'var(--color-on-surface)',
                  background: active ? 'rgba(0,132,61,0.10)' : 'transparent',
                  textDecoration: 'none',
                }}
              >
                <span style={{
                  width: 32,
                  height: 32,
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: 9,
                  background: active ? 'var(--color-primary)' : 'var(--color-surface-container)',
                  color: active ? '#fff' : 'var(--color-primary)',
                  flexShrink: 0,
                }}>
                  <Icon size={16} />
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 800 }}>{item.label}</span>
                  <span style={{ display: 'block', marginTop: 1, fontSize: 11, color: 'var(--color-outline)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item.description}
                  </span>
                </span>
                <ExternalLink size={13} style={{ color: 'var(--color-outline)' }} />
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}
