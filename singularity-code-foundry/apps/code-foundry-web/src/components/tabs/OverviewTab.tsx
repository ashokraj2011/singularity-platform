/**
 * M42.6 — Overview tab. Spec hashes, template + generator versions,
 * output path, and (for brownfield) the change plan summary.
 */
import { useEffect, useState } from 'react'
import { api, type RunDetail } from '../../lib/api'

export function OverviewTab({ run }: { run: RunDetail }) {
  return (
    <>
      <div className="panel">
        <h2>Run</h2>
        <table>
          <tbody>
            <tr><th>Generator</th><td>{run.generatorVersion}</td></tr>
            <tr><th>Template</th><td>{run.templateVersion}</td></tr>
            <tr><th>Started</th><td>{run.startedAt}</td></tr>
            <tr><th>Completed</th><td>{run.completedAt ?? '—'}</td></tr>
            <tr><th>Output path</th><td><code>{run.outputPath ?? '—'}</code></td></tr>
            {run.spec?.specHash && <tr><th>Spec hash</th><td><code>{run.spec.specHash}</code></td></tr>}
            {run.spec?.irHash && <tr><th>IR hash</th><td><code>{run.spec.irHash}</code></td></tr>}
            {run.receipt?.receiptHash && <tr><th>Receipt hash</th><td><code>{run.receipt.receiptHash}</code></td></tr>}
          </tbody>
        </table>
      </div>
      {run.mode === 'BROWNFIELD' && run.changePlan ? (
        <BrownfieldPanel run={run} />
      ) : null}
    </>
  )
}

function BrownfieldPanel({ run }: { run: RunDetail }) {
  const [planMeta, setPlanMeta] = useState<{ status: string; planHash: string; appliedAt: string | null; createdAt: string } | null>(null)
  useEffect(() => {
    if (!run.changePlan?.repoModelId) return
    let cancelled = false
    api.listChangePlans(run.changePlan.repoModelId)
      .then(r => {
        if (cancelled) return
        const row = r.items.find(i => i.id === run.changePlan?.id)
        if (row) setPlanMeta({ status: row.status, planHash: row.planHash, appliedAt: row.appliedAt, createdAt: row.createdAt })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [run.changePlan?.id, run.changePlan?.repoModelId])

  return (
    <div className="panel">
      <h2>Brownfield Change Plan</h2>
      <table>
        <tbody>
          <tr><th>Plan id</th><td><code>{run.changePlan?.id}</code></td></tr>
          <tr><th>Plan hash</th><td><code>{run.changePlan?.planHash}</code></td></tr>
          <tr><th>Status</th><td>{planMeta?.status ?? run.changePlan?.status}</td></tr>
          <tr><th>Repo model</th><td><code>{run.changePlan?.repoModelId}</code></td></tr>
          {planMeta?.appliedAt && <tr><th>Applied at</th><td>{planMeta.appliedAt}</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
