import { useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { api } from '../../../lib/api'
import { cardStyle, mutedText, sectionTitle, badgeStyle } from './workspaceStyles'

/**
 * Work Item overview dashboard — a spec→reconciliation pipeline at a glance. Additive: mounted at
 * the top of the Overview tab above the existing detail sections. Each stage card reflects live
 * status (best-effort, reusing the tab queries) and deep-links into its studio. Plus a compact
 * activity timeline from the Work Item events.
 */

type StudioTab = 'specification' | 'submissions' | 'reconciliation' | 'nextstage'
interface WorkItemLike { workCode?: string; title?: string; status: string; urgency?: string | null; dueAt?: string | null; targets?: any[]; events?: any[] }

const GREEN = 'var(--color-success)', AMBER = 'var(--color-warning)', RED = 'var(--color-danger)', GRAY = 'var(--color-outline)'

export function OverviewDashboard({ workItemId, workItem, onOpenTab }: { workItemId: string; workItem: WorkItemLike; onOpenTab: (tab: StudioTab) => void }) {
  const specQ = useQuery<any>({ queryKey: ['spec-versions', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/specifications`).then((r) => r.data) })
  const handoffQ = useQuery<any>({ queryKey: ['handoff', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/development-target`).then((r) => r.data) })
  const subsQ = useQuery<any>({ queryKey: ['submissions', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/submissions`).then((r) => r.data) })
  const reconQ = useQuery<any>({ queryKey: ['reconciliations', workItemId], queryFn: () => api.get(`/work-items/${workItemId}/reconciliations`).then((r) => r.data) })

  const specItems: any[] = specQ.data?.items ?? []
  const activeVersionId = specQ.data?.activeVersionId ?? null
  const activeSpec = specItems.find((v) => v.id === activeVersionId)
  const spec = activeSpec ? { label: `Approved v${activeSpec.version}`, tone: GREEN } : specItems.length ? { label: `${specItems.length} draft${specItems.length > 1 ? 's' : ''}`, tone: AMBER } : { label: 'None', tone: GRAY }

  const target = handoffQ.data?.target ?? null
  const handoff = target ? { label: target.status, tone: target.status === 'PUBLISHED' ? GREEN : AMBER } : { label: 'Not set', tone: GRAY }

  const subs: any[] = subsQ.data?.items ?? []
  const submissions = subs.length ? { label: `${subs.length} attempt${subs.length > 1 ? 's' : ''}`, tone: subs[0]?.status === 'REJECTED' ? RED : GREEN } : { label: 'None', tone: GRAY }

  const runs: any[] = reconQ.data?.items ?? []
  const latest = runs[0]
  const recon = latest ? { label: latest.status, tone: latest.status === 'PASSED' ? GREEN : latest.status === 'FAILED' || latest.status === 'ERROR' ? RED : AMBER } : { label: 'None', tone: GRAY }

  // Completion fan-out: surface the next-stage work items spawned when this item finalized.
  const spawnEvent = (workItem.events ?? []).find((e) => e.eventType === 'NEXT_STAGE_SPAWNED')
  const spawnFailedEvent = (workItem.events ?? []).find((e) => e.eventType === 'NEXT_STAGE_SPAWN_FAILED')
  const spawnedItems: any[] = spawnEvent?.payload?.workItems ?? []

  // Completion gate: reconciliation is the finalizer. The work item auto-completes only when the
  // latest run PASSED; a non-PASSED run holds (or reopens) it. Mirrors the server-side gate.
  const completion = workItem.status === 'COMPLETED'
    ? { label: spawnedItems.length ? `Completed · ${spawnedItems.length} spawned` : 'Completed', tone: GREEN }
    : latest && latest.status === 'PASSED'
      ? { label: 'Finalizing…', tone: AMBER }
      : latest
        ? { label: 'Blocked', tone: AMBER }
        : { label: 'Pending', tone: GRAY }

  const events: any[] = (workItem.events ?? []).slice(0, 6)

  return (
    <>
      <section style={{ ...cardStyle, background: 'linear-gradient(180deg, var(--color-surface-bright), var(--color-surface-low))' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.4, color: 'var(--color-primary)' }}>WORK ITEM</div>
            <h2 style={{ margin: '2px 0 4px', fontSize: 18, color: 'var(--color-on-surface)' }}>{workItem.title || workItem.workCode}</h2>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
              <span style={badgeStyle('run', workItem.status === 'COMPLETED' ? 'PASSED' : workItem.status === 'IN_PROGRESS' ? 'RUNNING' : 'PENDING')}>{workItem.status}</span>
              {workItem.urgency && <span style={mutedText}>urgency: {workItem.urgency}</span>}
              {workItem.dueAt && <span style={mutedText}>due {new Date(workItem.dueAt).toLocaleDateString()}</span>}
              <span style={mutedText}>{(workItem.targets ?? []).length} target(s)</span>
            </div>
          </div>
        </div>

        {/* Pipeline */}
        <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'stretch', flexWrap: 'wrap' }}>
          <StageCard label="Specification" status={spec.label} tone={spec.tone} onClick={() => onOpenTab('specification')} />
          <Arrow />
          <StageCard label="Handoff" status={handoff.label} tone={handoff.tone} onClick={() => onOpenTab('submissions')} />
          <Arrow />
          <StageCard label="Submissions" status={submissions.label} tone={submissions.tone} onClick={() => onOpenTab('submissions')} />
          <Arrow />
          <StageCard label="Reconciliation" status={recon.label} tone={recon.tone} onClick={() => onOpenTab('reconciliation')} />
          <Arrow />
          <StageCard label="Completion" status={completion.label} tone={completion.tone} onClick={() => onOpenTab('nextstage')} />
        </div>
      </section>

      {(spawnedItems.length > 0 || spawnFailedEvent) && (
        <section style={cardStyle}>
          <h4 style={{ ...sectionTitle, fontSize: 13 }}>Next-stage work items</h4>
          {spawnedItems.length > 0 ? (
            <>
              <p style={{ ...mutedText, marginBottom: 8 }}>Spawned on finalize from the attached Work Program — each runs via its workflow.</p>
              <div style={{ display: 'grid', gap: 6 }}>
                {spawnedItems.map((it) => (
                  <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--color-on-surface)' }}>
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: GREEN }} />
                    <strong>{it.workCode}</strong>
                    {it.stepKey && <span style={mutedText}>· {it.stepKey}</span>}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p style={{ ...mutedText, color: RED }}>Next-stage spawn failed: {spawnFailedEvent?.payload?.error ?? 'unknown error'}</p>
          )}
        </section>
      )}

      {events.length > 0 && (
        <section style={cardStyle}>
          <h4 style={{ ...sectionTitle, fontSize: 13 }}>Recent activity</h4>
          <div style={{ display: 'grid', gap: 0 }}>
            {events.map((e, i) => (
              <div key={e.id ?? i} style={{ display: 'grid', gridTemplateColumns: '18px 1fr', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 999, background: 'var(--color-primary)', border: '2px solid var(--color-surface-bright)' }} />
                  {i < events.length - 1 && <span style={{ width: 2, flex: 1, minHeight: 18, background: 'var(--color-outline-variant)' }} />}
                </div>
                <div style={{ paddingBottom: 12 }}>
                  <span style={{ fontSize: 12, color: 'var(--color-on-surface)', fontWeight: 600 }}>{e.eventType}</span>
                  {e.createdAt && <span style={{ ...mutedText, marginLeft: 8 }}>{new Date(e.createdAt).toLocaleString()}</span>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  )
}

function StageCard({ label, status, tone, onClick }: { label: string; status: string; tone: string; onClick: () => void }) {
  const style: CSSProperties = { flex: '1 1 130px', minWidth: 120, textAlign: 'left', padding: '10px 12px', borderRadius: 12, cursor: 'pointer', border: '1px solid var(--color-outline-variant)', background: 'var(--color-surface-bright)' }
  return (
    <button onClick={onClick} style={style}>
      <div style={{ ...mutedText, fontWeight: 700, marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: tone }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-on-surface)' }}>{status}</span>
      </div>
    </button>
  )
}

function Arrow() {
  return <div style={{ display: 'flex', alignItems: 'center', color: 'var(--color-outline)', fontSize: 16 }}>→</div>
}
