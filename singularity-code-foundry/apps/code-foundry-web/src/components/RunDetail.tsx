/**
 * M42.6 — Run detail (tabbed) view.
 *
 * Tabs:
 *   Overview     run header, counts strip, spec/IR hashes, brownfield
 *                impact summary (when mode=BROWNFIELD).
 *   Files        artifact tree + read-only file viewer (Markdown
 *                renderer reused via the artifact reader pattern).
 *   Gaps         CodegenGap rows with severity + region anchor.
 *   LLM Tasks    LlmPatchTask list, click → task pane with dispatch /
 *                apply-patch affordance and a diff viewer.
 *   Receipt      Pretty-print the receipt JSON. The header also shows
 *                a copyable receiptHash.
 */
import { useEffect, useState } from 'react'
import { api, type RunDetail as RunDetailT } from '../lib/api'
import { OverviewTab } from './tabs/OverviewTab'
import { FilesTab } from './tabs/FilesTab'
import { GapsTab } from './tabs/GapsTab'
import { TasksTab } from './tabs/TasksTab'
import { ReceiptTab } from './tabs/ReceiptTab'

type TabId = 'overview' | 'files' | 'gaps' | 'tasks' | 'receipt'

interface Props {
  runId: string
  onChanged: () => void
}

export function RunDetail({ runId, onChanged }: Props) {
  const [run, setRun] = useState<RunDetailT | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabId>('overview')
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    setRun(null)
    setError(null)
    api.getRun(runId)
      .then(r => { if (!cancelled) setRun(r) })
      .catch(err => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [runId, version])

  if (error) return <div className="empty">Error: {error}</div>
  if (!run) return <div className="empty">Loading run…</div>

  const refresh = () => { setVersion(v => v + 1); onChanged() }

  return (
    <>
      <header className="run-header">
        <div className="row-1">
          <span className={`mode-pill ${run.mode.toLowerCase()}`}>{run.mode}</span>
          <span>{run.specName ?? run.specId.slice(0, 8)}</span>
          <span style={{ color: 'var(--text-dim)' }}>@{run.specVersion ?? '—'}</span>
          <span className={`status-pill ${classify(run.status)}`}>{run.status}</span>
        </div>
        <div className="hashes">
          <span>runId: <code>{run.id}</code></span>
          {run.spec?.specHash && <span>specHash: <code>{short(run.spec.specHash)}</code></span>}
          {run.spec?.irHash && <span>irHash: <code>{short(run.spec.irHash)}</code></span>}
          {run.receipt?.receiptHash && <span>receiptHash: <code>{short(run.receipt.receiptHash)}</code></span>}
          {run.changePlan?.planHash && <span>planHash: <code>{short(run.changePlan.planHash)}</code></span>}
        </div>
      </header>
      <div className="tabs">
        {(['overview', 'files', 'gaps', 'tasks', 'receipt'] as const).map(t => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {labelFor(t)}
            {t === 'gaps' && run.counts.openGaps > 0 ? ` (${run.counts.openGaps})` : null}
            {t === 'tasks' && run.counts.openLlmTasks > 0 ? ` (${run.counts.openLlmTasks})` : null}
          </button>
        ))}
      </div>
      <div className="tab-body">
        <div className="counts">
          <span><strong>{run.counts.artifacts}</strong> artifacts</span>
          <span><strong>{run.counts.gaps}</strong> gaps ({run.counts.openGaps} open)</span>
          <span><strong>{run.counts.llmTasks}</strong> LLM tasks ({run.counts.openLlmTasks} open)</span>
        </div>
        {tab === 'overview' && <OverviewTab run={run} />}
        {tab === 'files' && <FilesTab runId={run.id} />}
        {tab === 'gaps' && <GapsTab runId={run.id} />}
        {tab === 'tasks' && <TasksTab runId={run.id} onChanged={refresh} />}
        {tab === 'receipt' && <ReceiptTab runId={run.id} />}
      </div>
    </>
  )
}

function classify(status: string): 'good' | 'bad' | 'warn' | '' {
  if (['COMPLETED', 'CERTIFIED', 'VERIFIED', 'PATCHED'].includes(status)) return 'good'
  if (['FAILED'].includes(status)) return 'bad'
  if (['GAPS_DETECTED', 'STARTED', 'GENERATED'].includes(status)) return 'warn'
  return ''
}

function short(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 14)}…${hash.slice(-4)}` : hash
}

function labelFor(t: TabId): string {
  switch (t) {
    case 'overview': return 'Overview'
    case 'files':    return 'Files'
    case 'gaps':     return 'Gaps'
    case 'tasks':    return 'LLM Tasks'
    case 'receipt':  return 'Receipt'
  }
}
