import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { History, Workflow, ArrowRight } from 'lucide-react'
import { api } from '../../lib/api'

type InboxKind = 'task' | 'approval' | 'consumable'

type InboxItem = {
  kind:               InboxKind
  id:                 string
  title:              string
  workflowName?:      string | null
  nodeLabel?:         string | null
  status:             string
  updatedAt:          string
}

type InboxResponse = {
  done: InboxItem[]
}

const KIND_COLOR: Record<InboxKind, string> = {
  task:       '#22c55e',
  approval:   '#f59e0b',
  consumable: '#10b981',
}

const KIND_LABEL: Record<InboxKind, string> = {
  task:       'Task',
  approval:   'Approval',
  consumable: 'Deliverable',
}

export function HistoryPage() {
  const navigate = useNavigate()
  const { data, isLoading } = useQuery<InboxResponse>({
    queryKey: ['runtime-inbox'],   // share cache with InboxPage
    queryFn:  () => api.get('/runtime/inbox').then(r => r.data),
  })

  const list = data?.done ?? []

  return (
    <div style={{ padding: 24, maxWidth: 880, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: 'rgba(99,102,241,0.10)', border: '1px solid rgba(99,102,241,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6366f1',
        }}>
          <History size={18} />
        </div>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-on-surface)', margin: 0, letterSpacing: '-0.01em' }}>
            History
          </h1>
          <p style={{ fontSize: 12, color: 'var(--color-outline)', margin: 0 }}>
            Tasks, approvals, and deliverables you completed in the last 30 days.
          </p>
        </div>
      </div>

      {isLoading ? (
        <p style={{ fontSize: 13, color: 'var(--color-outline)' }}>Loading…</p>
      ) : list.length === 0 ? (
        <div style={{
          padding: '48px 16px', textAlign: 'center',
          borderRadius: 12, border: '1px dashed var(--color-outline-variant)', background: '#fafafa',
        }}>
          <History size={32} style={{ color: 'var(--color-outline)', opacity: 0.5, marginBottom: 8 }} />
          <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-on-surface)', marginBottom: 4 }}>
            No completed work yet
          </p>
          <p style={{ fontSize: 12, color: 'var(--color-outline)' }}>
            Items you finish will appear here.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {list.map(item => {
            const color = KIND_COLOR[item.kind]
            return (
              <button
                key={`${item.kind}:${item.id}`}
                onClick={() => navigate(`/runtime/work/${item.kind}/${item.id}`)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '11px 14px', borderRadius: 9,
                  background: '#fff', border: '1px solid var(--color-outline-variant)',
                  cursor: 'pointer', textAlign: 'left',
                }}
              >
                <div style={{
                  width: 26, height: 26, borderRadius: 7,
                  background: `${color}15`, border: `1px solid ${color}30`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color, flexShrink: 0,
                }}>
                  <Workflow size={12} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-on-surface)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {item.title}
                    </span>
                    <span style={{
                      fontSize: 9, fontWeight: 700, color,
                      background: `${color}10`, padding: '1px 5px', borderRadius: 3,
                      letterSpacing: '0.08em', textTransform: 'uppercase',
                    }}>
                      {KIND_LABEL[item.kind]}
                    </span>
                  </div>
                  <p style={{ fontSize: 10, color: 'var(--color-outline)', marginTop: 2 }}>
                    {item.workflowName && <>{item.workflowName}{item.nodeLabel ? ` · ${item.nodeLabel}` : ''} · </>}
                    {new Date(item.updatedAt).toLocaleString()}
                    {' · '}<span style={{ fontFamily: 'monospace' }}>{item.status}</span>
                  </p>
                </div>
                <ArrowRight size={12} style={{ color: 'var(--color-outline)', flexShrink: 0 }} />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
