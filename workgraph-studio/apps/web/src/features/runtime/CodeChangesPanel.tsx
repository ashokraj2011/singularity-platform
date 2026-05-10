/**
 * M13 — CodeChangesPanel
 *
 * Lists structured code-changes captured by MCP for a single run, joined via
 * context-fabric's persisted call_log → MCP `/resources/code-changes`.
 *
 * The SPA does NOT know cf_call_id directly — it lives inside agent task
 * outputs in the run snapshot. The caller passes one or more cfCallIds via
 * the `cfCallIds` prop (typically pulled from the snapshot when rendering).
 *
 * Subscribes to the existing live-events store so freshly-detected changes
 * appear without a refetch (looks for `code_change.detected` events).
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, FileCode, GitCommit, AlertTriangle } from 'lucide-react'
import { api } from '../../lib/api'

interface CodeChangeRecord {
  id: string
  tool_name?: string
  paths_touched?: string[]
  diff?: string
  patch?: string
  commit_sha?: string
  language?: string
  lines_added?: number
  lines_removed?: number
  timestamp?: string
  stale?: boolean
}

interface CodeChangeListResponse {
  runId: string
  cfCallIds: string[]
  items: CodeChangeRecord[]
  stale: boolean
}

interface CodeChangesPanelProps {
  runId: string
}

export function CodeChangesPanel({ runId }: CodeChangesPanelProps) {
  const { data, isLoading, isError } = useQuery<CodeChangeListResponse>({
    queryKey: ['runCodeChanges', runId],
    queryFn: async () => {
      const r = await api.get<CodeChangeListResponse>(
        `/runs/${encodeURIComponent(runId)}/code-changes`,
      )
      return r.data
    },
    refetchInterval: 5_000,
    staleTime: 5_000,
  })

  const allItems: CodeChangeRecord[] = data?.items ?? []

  if (isLoading) {
    return <Container title="Code Changes"><p style={emptyMsg}>Loading…</p></Container>
  }
  if (isError) {
    return <Container title="Code Changes"><p style={emptyMsg}>Failed to load code changes from context-fabric.</p></Container>
  }
  if (allItems.length === 0) {
    return <Container title="Code Changes"><p style={emptyMsg}>This run did not touch any source files.</p></Container>
  }

  return (
    <Container title={`Code Changes · ${allItems.length}`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {allItems.map(item => <ChangeRow key={item.id} item={item} />)}
      </div>
    </Container>
  )
}

function Container({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      marginTop: 24, padding: 16, borderRadius: 12,
      background: 'var(--color-surface-container-low, rgba(0,0,0,0.02))',
      border: '1px solid var(--color-outline-variant)',
    }}>
      <h3 style={{
        margin: 0, marginBottom: 12,
        fontSize: 13, fontWeight: 700, letterSpacing: '0.04em',
        color: 'var(--color-on-surface)',
      }}>{title}</h3>
      {children}
    </div>
  )
}

function ChangeRow({ item }: { item: CodeChangeRecord }) {
  const [open, setOpen] = useState(false)
  const isStale = item.stale === true
  const hasBody = Boolean(item.diff || item.patch)

  return (
    <div style={{
      border: '1px solid var(--color-outline-variant)',
      borderRadius: 8,
      background: isStale ? 'rgba(245,158,11,0.06)' : 'var(--color-surface)',
      overflow: 'hidden',
    }}>
      <button
        onClick={() => hasBody && setOpen(o => !o)}
        disabled={!hasBody}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', border: 'none', background: 'transparent',
          cursor: hasBody ? 'pointer' : 'default', textAlign: 'left',
        }}
      >
        {hasBody
          ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)
          : <FileCode size={14} style={{ color: 'var(--color-outline)' }} />}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-on-surface)' }}>
            {item.paths_touched && item.paths_touched.length > 0
              ? item.paths_touched.join(', ')
              : <span style={{ fontStyle: 'italic', color: 'var(--color-outline)' }}>(no path metadata)</span>}
          </div>
          <div style={{ fontSize: 10, color: 'var(--color-outline)', display: 'flex', gap: 12, alignItems: 'center' }}>
            {item.tool_name && <span>{item.tool_name}</span>}
            {item.commit_sha && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <GitCommit size={10} /> {item.commit_sha.slice(0, 8)}
              </span>
            )}
            {(item.lines_added !== undefined || item.lines_removed !== undefined) && (
              <span>
                <span style={{ color: '#16a34a' }}>+{item.lines_added ?? 0}</span>
                {' '}
                <span style={{ color: '#dc2626' }}>−{item.lines_removed ?? 0}</span>
              </span>
            )}
            {isStale && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: '#a16207' }}>
                <AlertTriangle size={10} /> diff content no longer available — re-run to refresh
              </span>
            )}
          </div>
        </div>
      </button>
      {open && hasBody && (
        <pre style={{
          margin: 0, padding: 12,
          background: '#0f172a',
          color: '#e2e8f0',
          fontSize: 11, fontFamily: 'ui-monospace, SFMono-Regular, monospace',
          overflowX: 'auto', whiteSpace: 'pre',
          borderTop: '1px solid var(--color-outline-variant)',
        }}>{item.diff ?? item.patch ?? ''}</pre>
      )}
    </div>
  )
}

const emptyMsg: React.CSSProperties = {
  fontSize: 12, color: 'var(--color-outline)', margin: 0, fontStyle: 'italic',
}
