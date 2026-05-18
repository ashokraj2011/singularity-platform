/**
 * M42.6 — Approval UI shell.
 *
 * Single-operator, single-run cockpit. Left rail: runs list with filter
 * by greenfield/brownfield/all. Right pane: run detail with tabs for
 * Overview, Files, Gaps, LLM Tasks, Receipt. Brownfield tab adds a
 * "Change Plan" view alongside Files.
 *
 * State is intentionally local — no router, no global store; refresh
 * just re-fetches. Multi-tenancy / presence / lock is out of scope for
 * V1 (M43+).
 */
import { useEffect, useState } from 'react'
import { api, type RunSummary } from './lib/api'
import { RunList } from './components/RunList'
import { RunDetail } from './components/RunDetail'

export function App() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'ALL' | 'GREENFIELD' | 'BROWNFIELD'>('ALL')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setRuns(null)
    api.listRuns({ take: 50, mode: filter === 'ALL' ? undefined : filter })
      .then((r) => { if (!cancelled) { setRuns(r.items); setError(null) } })
      .catch((err) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [filter, refreshKey])

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <img src="/foundry-mark.svg" alt="" width={24} height={24} />
          <h1>Code Foundry</h1>
          <button
            onClick={() => setRefreshKey(k => k + 1)}
            style={{ marginLeft: 'auto', padding: '3px 9px', fontSize: 11 }}
            title="Reload runs"
          >
            ↻
          </button>
        </header>
        <div className="filters">
          {(['ALL', 'GREENFIELD', 'BROWNFIELD'] as const).map(f => (
            <button
              key={f}
              className={filter === f ? 'active' : ''}
              onClick={() => setFilter(f)}
            >
              {f.toLowerCase()}
            </button>
          ))}
        </div>
        <RunList
          runs={runs}
          error={error}
          selectedId={selectedRunId}
          onSelect={setSelectedRunId}
        />
      </aside>
      <main className="detail">
        {selectedRunId ? (
          <RunDetail
            runId={selectedRunId}
            onChanged={() => setRefreshKey(k => k + 1)}
          />
        ) : (
          <div className="empty" style={{ paddingTop: 80 }}>
            Pick a run from the left to inspect it.
          </div>
        )}
      </main>
    </div>
  )
}
