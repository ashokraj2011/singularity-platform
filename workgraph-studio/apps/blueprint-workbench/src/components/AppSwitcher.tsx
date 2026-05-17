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
    { id: 'operations', label: 'Operations', href: import.meta.env.VITE_LINK_OPERATIONS_PORTAL ?? localUrl(5180, '/operations'), description: 'Health, setup, audit', icon: ServerCog },
    { id: 'agent-studio', label: 'Agent Studio', href: import.meta.env.VITE_LINK_AGENT_ADMIN ?? localUrl(3000), description: 'Agents, tools, capabilities', icon: Bot },
    { id: 'workflow', label: 'Workflow Manager', href: import.meta.env.VITE_LINK_WORKGRAPH_DESIGNER ?? localUrl(5174), description: 'Runs, WorkItems, approvals', icon: Workflow },
    { id: 'workbench', label: 'Blueprint Workbench', href: import.meta.env.VITE_LINK_BLUEPRINT_WORKBENCH ?? localUrl(5176, '/?ui=neo'), description: 'Guided delivery cockpit', icon: Wrench },
    { id: 'iam', label: 'Identity & Access', href: import.meta.env.VITE_LINK_IAM_ADMIN ?? localUrl(5175), description: 'Users, teams, roles', icon: ShieldCheck },
  ], [])
}

export function AppSwitcher({ currentApp = 'workbench' }: { currentApp?: string }) {
  const links = useAppLinks()
  const [open, setOpen] = useState(false)
  const current = links.find(item => item.id === currentApp) ?? links[0]

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
  }

  return (
    <div className="app-switcher" onBlur={onBlur}>
      <button
        type="button"
        className="secondary-action compact-action"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Switch Singularity app"
      >
        <Grid3X3 size={15} />
        {current.label}
      </button>
      {open && (
        <div className="app-switcher-menu" role="menu">
          <p>Singularity Apps</p>
          {links.map(item => {
            const Icon = item.icon
            const active = item.id === currentApp
            return (
              <a key={item.id} href={item.href} role="menuitem" className={active ? 'active' : ''}>
                <Icon size={16} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
                <ExternalLink size={13} />
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}
