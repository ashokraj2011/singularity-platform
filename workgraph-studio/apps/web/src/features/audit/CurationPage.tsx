/**
 * Operator curation page (task #111, M74 Phase 2C follow-up).
 *
 * The eval gate refuses to score against an unreviewed example —
 * operators must hand-confirm each candidate before it enters the
 * dataset's effective test set. Before this page existed they did
 * that by hand-rolling curl PATCHes; this page makes it a one-click
 * action.
 *
 * Flow:
 *   1. Pick a dataset from the left rail.
 *   2. The right pane lists its unreviewed examples (server returns
 *      a small partial-index-backed page, default 50).
 *   3. Per example: see input + actual + expected, optionally edit
 *      expected, write a note, click "Mark reviewed". The mutation
 *      hits /api/engine/dataset-examples/:id (the workgraph-api
 *      proxy that fronts audit-gov's engine route — never call
 *      audit-gov from the browser directly because the service
 *      token would have to ship with the bundle).
 *
 * What this page deliberately does NOT do:
 *   • Bulk approve. The whole point of the gate is per-example human
 *     judgement; batch approval would defeat the curation contract.
 *   • Re-open a reviewed example. The PATCH endpoint cannot un-set
 *     reviewed_at (audit-gov comment is explicit about this) — if an
 *     operator made a wrong call, the right answer is to drop the
 *     example and re-add it via the dataset builder.
 *   • Show a diff between actual and expected. Renders side-by-side
 *     instead — the operator can compare visually. A real diff would
 *     need a json-diff lib for the typical {expected, actual} jsonb
 *     payload; deferred until operators ask for it.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { ClipboardCheck, AlertCircle, CheckCircle2 } from 'lucide-react'
import { api } from '../../lib/api'

interface Dataset {
  id: string
  name: string
  description?: string | null
  capability_id?: string | null
  issue_id?: string | null
  created_at: string
}

interface UnreviewedExample {
  id: string
  trace_id?: string | null
  input: unknown
  expected_output: unknown
  actual_output: unknown
  metadata: Record<string, unknown> | null
  created_at: string
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return '(none)'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function CurationPage() {
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null)

  const datasetsQuery = useQuery<{ count: number; items: Dataset[] }>({
    queryKey: ['engine', 'datasets'],
    queryFn: () => api.get('/engine/datasets').then((r) => r.data),
    // Datasets change rarely; no auto-refresh.
  })

  const datasets = datasetsQuery.data?.items ?? []

  return (
    <div className="p-6 max-w-6xl">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <ClipboardCheck className="w-5 h-5" style={{ color: '#22d3ee' }} />
          <h1 className="page-header">Eval Curation</h1>
        </div>
        <p className="text-sm text-slate-500 font-mono">
          {datasets.length} datasets · review candidate examples before they enter the gate
        </p>
      </motion.div>

      <div className="grid grid-cols-[260px_1fr] gap-4">
        <DatasetList
          datasets={datasets}
          isLoading={datasetsQuery.isLoading}
          selectedId={selectedDatasetId}
          onSelect={setSelectedDatasetId}
        />
        {selectedDatasetId ? (
          <ExamplePane datasetId={selectedDatasetId} />
        ) : (
          <EmptyState />
        )}
      </div>
    </div>
  )
}

// ── Left rail ─────────────────────────────────────────────────────────────

function DatasetList(props: {
  datasets: Dataset[]
  isLoading: boolean
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  if (props.isLoading) {
    return (
      <div className="space-y-1.5">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skeleton h-12 rounded-xl" />
        ))}
      </div>
    )
  }
  if (props.datasets.length === 0) {
    return (
      <div className="glass-card rounded-xl p-4 text-center">
        <AlertCircle className="w-8 h-8 text-slate-700 mx-auto mb-2" />
        <p className="text-xs text-slate-500">No datasets yet. They get created automatically when an engine issue is promoted to a benchmark.</p>
      </div>
    )
  }
  return (
    <div className="glass-card rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
      {props.datasets.map((d, i) => {
        const selected = d.id === props.selectedId
        return (
          <button
            key={d.id}
            onClick={() => props.onSelect(d.id)}
            className="w-full text-left px-4 py-3 hover:bg-white/[0.03] transition-colors"
            style={{
              borderBottom: i < props.datasets.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
              background: selected ? 'rgba(34,211,238,0.08)' : 'transparent',
            }}
          >
            <div className="text-sm font-medium text-slate-200 truncate">{d.name}</div>
            <div className="text-[10px] font-mono text-slate-500 truncate mt-0.5">
              {d.capability_id ? `cap:${d.capability_id.slice(0, 8)}` : 'no capability'}
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ── Right pane ────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="glass-card rounded-xl p-12 flex flex-col items-center justify-center text-center" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
      <ClipboardCheck className="w-10 h-10 text-slate-700 mb-3" />
      <p className="text-sm text-slate-500">Pick a dataset on the left to start reviewing candidate examples.</p>
    </div>
  )
}

function ExamplePane(props: { datasetId: string }) {
  const queryClient = useQueryClient()

  const examplesQuery = useQuery<{ count: number; items: UnreviewedExample[] }>({
    queryKey: ['engine', 'unreviewed', props.datasetId],
    queryFn: () =>
      api.get(`/engine/datasets/${props.datasetId}/unreviewed-examples`).then((r) => r.data),
    refetchOnWindowFocus: false,
  })

  const examples = examplesQuery.data?.items ?? []

  const reviewMut = useMutation({
    mutationFn: async (vars: {
      id: string
      reviewNotes: string
      expectedOverride?: unknown
    }) => {
      const body: Record<string, unknown> = {}
      if (vars.reviewNotes.trim()) body.review_notes = vars.reviewNotes.trim()
      if (vars.expectedOverride !== undefined) body.expected_output = vars.expectedOverride
      const res = await api.patch(`/engine/dataset-examples/${vars.id}`, body)
      return res.data
    },
    onSuccess: () => {
      // Invalidate the unreviewed list so the row drops off; the
      // user sees the queue shrink as they work.
      queryClient.invalidateQueries({ queryKey: ['engine', 'unreviewed', props.datasetId] })
    },
  })

  if (examplesQuery.isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="skeleton h-32 rounded-xl" />
        ))}
      </div>
    )
  }

  if (examples.length === 0) {
    return (
      <div className="glass-card rounded-xl p-12 flex flex-col items-center justify-center text-center" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
        <CheckCircle2 className="w-10 h-10 text-emerald-400/60 mb-3" />
        <p className="text-sm text-slate-300">All caught up — no unreviewed examples in this dataset.</p>
        <p className="text-[11px] font-mono text-slate-500 mt-2">New candidates show up here automatically as runs complete.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="text-xs font-mono text-slate-500">
        {examples.length} unreviewed · oldest first
      </div>
      {examples.map((ex) => (
        <ExampleCard
          key={ex.id}
          example={ex}
          onReview={(reviewNotes, expectedOverride) =>
            reviewMut.mutate({ id: ex.id, reviewNotes, expectedOverride })
          }
          isPending={reviewMut.isPending && reviewMut.variables?.id === ex.id}
        />
      ))}
    </div>
  )
}

function ExampleCard(props: {
  example: UnreviewedExample
  onReview: (reviewNotes: string, expectedOverride?: unknown) => void
  isPending: boolean
}) {
  const { example } = props
  const [notes, setNotes] = useState('')
  const [editingExpected, setEditingExpected] = useState(false)
  const [expectedDraft, setExpectedDraft] = useState(formatJson(example.expected_output))
  const [parseError, setParseError] = useState<string | null>(null)

  function submitReview() {
    let expectedOverride: unknown
    if (editingExpected) {
      // Parse the draft as JSON before sending. The original may not
      // have been a string (could be a structured object) — the
      // textarea always carries pretty-printed JSON.
      try {
        expectedOverride = JSON.parse(expectedDraft)
        setParseError(null)
      } catch (err) {
        setParseError((err as Error).message)
        return
      }
    }
    props.onReview(notes, expectedOverride)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className="glass-card rounded-xl p-4"
      style={{ border: '1px solid rgba(255,255,255,0.06)' }}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-[10px] text-slate-500">
          {example.id.slice(0, 8)}… · {new Date(example.created_at).toLocaleString()}
        </span>
        {example.trace_id && (
          <span className="font-mono text-[10px] text-slate-600">
            trace:{example.trace_id.slice(0, 12)}…
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3">
        <CompactJsonPane label="Input"    value={example.input} />
        <CompactJsonPane label="Actual"   value={example.actual_output} />
        <CompactJsonPane
          label="Expected"
          value={example.expected_output}
          editable
          editing={editingExpected}
          draft={expectedDraft}
          onToggleEdit={() => setEditingExpected((v) => !v)}
          onDraftChange={(v) => {
            setExpectedDraft(v)
            setParseError(null)
          }}
        />
      </div>

      {parseError && (
        <div className="mb-3 px-3 py-2 rounded-lg text-[11px] font-mono text-red-300 bg-red-950/40 border border-red-900/40">
          expected_output must be valid JSON: {parseError}
        </div>
      )}

      <div className="flex items-start gap-3">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Review notes (optional, e.g. why expected was edited)"
          className="flex-1 min-h-[42px] max-h-[120px] resize-y px-3 py-2 rounded-lg text-xs bg-black/30 text-slate-200 border border-white/[0.06] focus:outline-none focus:border-cyan-500/40"
        />
        <button
          onClick={submitReview}
          disabled={props.isPending}
          className="shrink-0 px-4 py-2 rounded-lg text-xs font-medium transition-colors"
          style={{
            background: props.isPending ? 'rgba(34,211,238,0.15)' : 'rgba(34,211,238,0.25)',
            color: '#22d3ee',
            border: '1px solid rgba(34,211,238,0.35)',
            cursor: props.isPending ? 'wait' : 'pointer',
          }}
        >
          {props.isPending ? 'Saving…' : 'Mark reviewed'}
        </button>
      </div>
    </motion.div>
  )
}

function CompactJsonPane(props: {
  label: string
  value: unknown
  editable?: boolean
  editing?: boolean
  draft?: string
  onToggleEdit?: () => void
  onDraftChange?: (v: string) => void
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-mono uppercase tracking-wide text-slate-500">{props.label}</span>
        {props.editable && (
          <button
            onClick={props.onToggleEdit}
            className="text-[10px] text-cyan-400/70 hover:text-cyan-400"
          >
            {props.editing ? 'cancel' : 'edit'}
          </button>
        )}
      </div>
      {props.editable && props.editing ? (
        <textarea
          value={props.draft ?? ''}
          onChange={(e) => props.onDraftChange?.(e.target.value)}
          className="min-h-[140px] resize-y px-2 py-2 rounded-lg text-[10px] font-mono leading-snug bg-black/40 text-slate-200 border border-cyan-700/30 focus:outline-none focus:border-cyan-500/60"
        />
      ) : (
        <pre className="min-h-[140px] max-h-[280px] overflow-auto px-2 py-2 rounded-lg text-[10px] font-mono leading-snug bg-black/30 text-slate-400 border border-white/[0.04]">
          {formatJson(props.value)}
        </pre>
      )}
    </div>
  )
}
