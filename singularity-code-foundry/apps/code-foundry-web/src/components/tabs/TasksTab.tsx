/**
 * M42.6 — LLM Patch Tasks tab + approve/reject panel.
 *
 *   - Lists all CodegenLlmPatchTask rows for the run.
 *   - Selecting a task opens a side pane with task metadata, the
 *     dispatch affordance, a diff text area, and the apply-patch
 *     button.
 *   - Dispatch calls /llm-tasks/:id/dispatch which routes through
 *     prompt-composer. The returned diff prefills the text area;
 *     the operator can edit it before applying.
 *   - Apply-patch returns either GUARD_PASSED (panel turns green +
 *     refreshes the run) or GUARD_REJECTED (panel turns red and shows
 *     the stage + reason).
 */
import { useEffect, useMemo, useState } from 'react'
import ReactDiffViewer from 'react-diff-viewer-continued'
import { api, type LlmTaskRow } from '../../lib/api'

interface Props {
  runId: string
  onChanged: () => void
}

interface ApplyResult {
  status: 'GUARD_PASSED' | 'GUARD_REJECTED'
  stage?: string
  reason?: string
  appliedFiles?: Array<{ path: string; beforeHash: string; afterHash: string }>
}

export function TasksTab({ runId, onChanged }: Props) {
  const [tasks, setTasks] = useState<LlmTaskRow[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    api.listLlmTasks(runId)
      .then(r => {
        if (cancelled) return
        setTasks(r.items)
        if (r.items.length > 0 && !activeId) setActiveId(r.items[0].id)
      })
      .catch(e => { if (!cancelled) setErr(e.message) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, refreshKey])

  const active = useMemo(
    () => tasks?.find(t => t.id === activeId) ?? null,
    [tasks, activeId],
  )

  if (err) return <div className="empty">{err}</div>
  if (!tasks) return <div className="empty">Loading tasks…</div>
  if (tasks.length === 0) return <div className="empty">No LLM patch tasks for this run.</div>

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16 }}>
      <div className="panel" style={{ padding: 0 }}>
        <h2 style={{ padding: '12px 16px 0' }}>Tasks</h2>
        <table>
          <tbody>
            {tasks.map(t => (
              <tr
                key={t.id}
                className="clickable"
                onClick={() => setActiveId(t.id)}
                style={activeId === t.id ? { background: 'var(--accent-soft)' } : undefined}
              >
                <td>
                  <div style={{ fontSize: 12 }}>{t.taskType}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                    {t.targetFile.split('/').pop()} • {t.regionId}
                  </div>
                </td>
                <td><span className={`status-pill ${taskClass(t.status)}`}>{t.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {active && (
        <TaskPane
          task={active}
          onApplied={() => {
            setRefreshKey(k => k + 1)
            onChanged()
          }}
        />
      )}
    </div>
  )
}

function TaskPane({ task, onApplied }: { task: LlmTaskRow; onApplied: () => void }) {
  const [diff, setDiff] = useState<string>('')
  const [dispatchErr, setDispatchErr] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null)
  const [busy, setBusy] = useState<'dispatch' | 'apply' | null>(null)

  async function onDispatch() {
    setBusy('dispatch')
    setDispatchErr(null)
    try {
      const r = await api.dispatchTask(task.id)
      if (r.status === 'OK' && r.diff) setDiff(r.diff)
      else if (r.error) setDispatchErr(`${r.status}: ${r.error}`)
      else setDispatchErr(`${r.status}: no diff returned.`)
    } catch (err) {
      setDispatchErr((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function onApply() {
    if (!diff.trim()) return
    setBusy('apply')
    setApplyResult(null)
    try {
      const r = await api.applyPatch(task.id, diff)
      setApplyResult(r)
      if (r.status === 'GUARD_PASSED') onApplied()
    } catch (err) {
      setApplyResult({ status: 'GUARD_REJECTED', stage: 'transport', reason: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const meta = task.metadata as Record<string, unknown> | null
  const isResolved = task.status === 'GUARD_PASSED'

  return (
    <div className="panel" style={{ overflow: 'hidden' }}>
      <h2>Task</h2>
      <table>
        <tbody>
          <tr><th>Type</th><td><code>{task.taskType}</code></td></tr>
          <tr><th>Status</th><td><span className={`status-pill ${taskClass(task.status)}`}>{task.status}</span></td></tr>
          <tr><th>Target file</th><td><code>{task.targetFile}</code></td></tr>
          {task.targetClass && <tr><th>Class</th><td><code>{task.targetClass}</code></td></tr>}
          {task.targetMethod && <tr><th>Method</th><td><code>{task.targetMethod}</code></td></tr>}
          <tr><th>Region</th><td>{task.regionId}</td></tr>
          <tr><th>Allowed</th><td><code>{JSON.stringify(task.allowedChanges)}</code></td></tr>
          <tr><th>Forbidden</th><td><code>{JSON.stringify(task.forbiddenChanges)}</code></td></tr>
        </tbody>
      </table>
      {meta && Object.keys(meta).length > 0 ? (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-dim)' }}>Metadata</summary>
          <pre style={{ marginTop: 8, padding: 10, background: 'var(--code-bg)', borderRadius: 4, overflow: 'auto', maxHeight: 200 }}>
            {JSON.stringify(meta, null, 2)}
          </pre>
        </details>
      ) : null}

      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <button onClick={onDispatch} disabled={busy !== null || isResolved}>
          {busy === 'dispatch' ? 'Dispatching…' : 'Dispatch (LLM)'}
        </button>
        <button className="primary" onClick={onApply} disabled={busy !== null || !diff.trim() || isResolved}>
          {busy === 'apply' ? 'Applying…' : 'Apply patch'}
        </button>
      </div>

      {dispatchErr && <div className="banner warn" style={{ marginTop: 12 }}>Dispatch: {dispatchErr}</div>}
      {applyResult && applyResult.status === 'GUARD_PASSED' && (
        <div className="banner good" style={{ marginTop: 12 }}>
          ✓ Patch accepted. {applyResult.appliedFiles?.length ?? 0} file(s) written.
        </div>
      )}
      {applyResult && applyResult.status === 'GUARD_REJECTED' && (
        <div className="banner bad" style={{ marginTop: 12 }}>
          ✗ Patch Guard rejected at <code>{applyResult.stage}</code>: {applyResult.reason}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 6 }}>Unified diff</div>
        <textarea
          rows={10}
          value={diff}
          onChange={(e) => setDiff(e.target.value)}
          disabled={isResolved}
          placeholder="Paste a unified diff here, or click Dispatch (LLM) to fetch one."
          style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
        />
        {diff.trim() && (
          <div className="diff-wrap">
            <ReactDiffViewer
              oldValue={extractOld(diff)}
              newValue={extractNew(diff)}
              splitView={false}
              useDarkTheme
              hideLineNumbers
            />
          </div>
        )}
      </div>
    </div>
  )
}

function taskClass(status: LlmTaskRow['status']): 'good' | 'bad' | 'warn' | '' {
  if (status === 'GUARD_PASSED') return 'good'
  if (status === 'GUARD_REJECTED' || status === 'FAILED') return 'bad'
  if (status === 'PENDING' || status === 'DISPATCHED') return 'warn'
  return ''
}

// Very rough split — the React diff viewer wants old/new strings to
// render side-by-side. We approximate by stripping the +/- prefixes
// and showing the unified body as both sides; the textarea still has
// the canonical text and that's what gets POSTed to apply-patch.
function extractOld(diff: string): string {
  return diff.split(/\r?\n/).filter(l => !l.startsWith('+++') && !l.startsWith('+'))
    .map(l => l.startsWith('-') && !l.startsWith('---') ? l.slice(1) : l).join('\n')
}
function extractNew(diff: string): string {
  return diff.split(/\r?\n/).filter(l => !l.startsWith('---') && !l.startsWith('-'))
    .map(l => l.startsWith('+') && !l.startsWith('+++') ? l.slice(1) : l).join('\n')
}
