/**
 * Run a Workflow — end-user catalog page.
 *
 * Lists every workflow the user can see, with a single "Run" action per row.
 * Stripped-down read-only view of the Workflow Designer list (which lives
 * under Administration). Clicking Run pushes the user straight into the
 * browser-runtime player, skipping any design / archive / metadata UI.
 */

import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Play, Search, Workflow as WorkflowIcon } from 'lucide-react'
import { api } from '../../lib/api'

type Workflow = {
  id:             string
  name:           string
  description?:   string
  status?:        string
  capabilityId?:  string | null
  archivedAt?:    string | null
  variables?:     Array<{ key: string; label?: string; type?: string; defaultValue?: unknown; scope?: string; description?: string }>
}

export function RunWorkflowPage() {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')

  const { data: workflowsData, isLoading } = useQuery({
    queryKey: ['run-workflows'],
    queryFn:  () => api.get('/workflow-templates').then(r => r.data),
    staleTime: 30_000,
  })
  const workflows: Workflow[] = useMemo(() => {
    const raw = Array.isArray(workflowsData)
      ? workflowsData
      : Array.isArray(workflowsData?.content) ? workflowsData.content : []
    return raw.filter((w: Workflow) => !w.archivedAt && w.status !== 'ARCHIVED')
  }, [workflowsData])

  const filtered = useMemo(() => {
    if (!search.trim()) return workflows
    const q = search.toLowerCase()
    return workflows.filter(w =>
      w.name.toLowerCase().includes(q) ||
      (w.description ?? '').toLowerCase().includes(q),
    )
  }, [workflows, search])

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: 'rgba(0,132,61,0.10)', border: '1px solid rgba(0,132,61,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-primary)',
        }}>
          <Play size={18} />
        </div>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-on-surface)', margin: 0, letterSpacing: '-0.01em' }}>
            Run a Workflow
          </h1>
          <p style={{ fontSize: 12, color: 'var(--color-outline)', margin: 0 }}>
            Pick a workflow and start a run. Designs and edits live under Administration.
          </p>
        </div>
      </div>

      <div style={{ position: 'relative', margin: '18px 0' }}>
        <Search size={13} style={{ position: 'absolute', top: '50%', left: 12, transform: 'translateY(-50%)', color: 'var(--color-outline)' }} />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search workflows by name or description…"
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '10px 12px 10px 34px', borderRadius: 10,
            border: '1px solid var(--color-outline-variant)', background: '#fff',
            fontSize: 13, outline: 'none',
          }}
        />
      </div>

      {isLoading ? (
        <p style={{ fontSize: 13, color: 'var(--color-outline)' }}>Loading workflows…</p>
      ) : filtered.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
          {filtered.map(w => (
            <WorkflowCard
              key={w.id}
              workflow={w}
              onRun={() => {
                // Pre-fill the browser-mode start URL.  The player itself
                // bootstraps the run state from the workflow definition.
                const params = new URLSearchParams({
                  workflowId: w.id,
                  name: `${w.name} · ${formatStamp(new Date())}`,
                })
                navigate(`/play/new?${params.toString()}`)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function WorkflowCard({ workflow, onRun }: { workflow: Workflow; onRun: () => void }) {
  return (
    <div style={{
      padding: '14px 16px', borderRadius: 12,
      background: '#fff', border: '1px solid var(--color-outline-variant)',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8, flexShrink: 0,
          background: 'rgba(0,132,61,0.08)', border: '1px solid rgba(0,132,61,0.18)',
          color: 'var(--color-primary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <WorkflowIcon size={14} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 style={{
            fontSize: 14, fontWeight: 700, color: 'var(--color-on-surface)',
            margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {workflow.name}
          </h3>
          {workflow.description && (
            <p style={{
              fontSize: 11, color: 'var(--color-outline)', margin: '4px 0 0',
              overflow: 'hidden', textOverflow: 'ellipsis',
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            }}>
              {workflow.description}
            </p>
          )}
        </div>
      </div>

      <button
        onClick={onRun}
        style={{
          alignSelf: 'flex-start',
          padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
          background: 'var(--color-primary)', color: '#fff',
          fontSize: 12, fontWeight: 700,
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}
      >
        <Play size={11} /> Run
      </button>
    </div>
  )
}

function EmptyState() {
  return (
    <div style={{
      padding: '40px 16px', textAlign: 'center',
      borderRadius: 12, border: '1px dashed var(--color-outline-variant)',
      background: 'rgba(0,0,0,0.02)',
    }}>
      <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-on-surface)', margin: 0 }}>
        No workflows are available to run.
      </p>
      <p style={{ fontSize: 11, color: 'var(--color-outline)', margin: '6px 0 0' }}>
        Ask an administrator to publish a workflow you can run.
      </p>
    </div>
  )
}

function formatStamp(d: Date) {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
