/**
 * M42.6 — Receipt tab. Pretty-prints the receipt JSON. Greenfield
 * receipts anchor on (specHash, irHash, templateVersion,
 * generatorVersion); brownfield receipts anchor on (repoModelHash,
 * enhancementSpecHash, changePlanHash, patchHashes[]) per §25.16.
 */
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'

export function ReceiptTab({ runId }: { runId: string }) {
  const [receipt, setReceipt] = useState<{ receiptHash: string; receiptJson: Record<string, unknown>; createdAt: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.receipt(runId)
      .then(r => { if (!cancelled) setReceipt(r) })
      .catch(e => {
        if (!cancelled) setErr(e.message)
      })
    return () => { cancelled = true }
  }, [runId])

  if (err) {
    return (
      <div className="banner warn">
        {err === '404 Not Found' || /not found/i.test(err)
          ? 'No receipt has been written for this run yet. Receipts land after generation (greenfield) or apply (brownfield).'
          : err}
      </div>
    )
  }
  if (!receipt) return <div className="empty">Loading receipt…</div>

  return (
    <div className="panel">
      <h2>Receipt</h2>
      <div style={{ display: 'flex', gap: 14, marginBottom: 12, fontSize: 12, color: 'var(--text-dim)' }}>
        <span>receiptHash: <code>{receipt.receiptHash}</code></span>
        <span>written: {receipt.createdAt}</span>
        <button
          onClick={() => navigator.clipboard.writeText(receipt.receiptHash)}
          style={{ padding: '2px 8px', fontSize: 11 }}
        >Copy hash</button>
      </div>
      <pre style={{ background: 'var(--code-bg)', padding: 14, borderRadius: 4, overflow: 'auto', maxHeight: '60vh' }}>
        {JSON.stringify(receipt.receiptJson, null, 2)}
      </pre>
    </div>
  )
}
