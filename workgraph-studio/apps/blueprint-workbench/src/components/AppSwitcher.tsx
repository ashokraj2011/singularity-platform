import { useMemo, useState } from 'react'
import type { FocusEvent } from 'react'
import { Bot, ExternalLink, Grid3X3, ServerCog, ShieldCheck, Workflow, Wrench, type LucideIcon } from 'lucide-react'
import { viteEnv } from '../vite-env-compat'

type AppLink = {
  id: string
  label: string
  href: string
  description: string
  icon: LucideIcon
}

// M100 P3 — same-origin path prefixes for cross-app nav under the edge gateway.
function useAppLinks(): AppLink[] {
  return useMemo(() => [
    { id: 'operations', label: 'Operations', href: viteEnv.VITE_LINK_OPERATIONS_PORTAL ?? '/operations', description: 'Health, setup, audit', icon: ServerCog },
    { id: 'agent-studio', label: 'Agent Studio', href: viteEnv.VITE_LINK_AGENT_ADMIN ?? '/agents', description: 'Agents, tools, capabilities', icon: Bot },
    { id: 'workflow', label: 'Workflow Manager', href: viteEnv.VITE_LINK_WORKGRAPH_DESIGNER ?? '/workflows/templates', description: 'Runs, WorkItems, approvals', icon: Workflow },
    { id: 'workbench', label: 'Blueprint Workbench', href: viteEnv.VITE_LINK_BLUEPRINT_WORKBENCH ?? '/workbench/?ui=neo', description: 'Guided delivery cockpit', icon: Wrench },
    { id: 'iam', label: 'Identity & Access', href: viteEnv.VITE_LINK_IAM_ADMIN ?? '/identity', description: 'Users, teams, roles', icon: ShieldCheck },
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
