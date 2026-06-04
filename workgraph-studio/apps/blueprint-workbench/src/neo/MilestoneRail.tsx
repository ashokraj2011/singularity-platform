/**
 * Milestones (P5) — the outer-loop rail.
 *
 * For a milestonesMode run, this renders the ordered milestone series (M1 → M2
 * → …) above the per-stage LoopRail. The active milestone is highlighted; the
 * existing LoopRail keeps showing the stages of whatever milestone is current
 * (its attempts are milestone-scoped server-side). When the active milestone is
 * green, a boundary "Advance →" affordance lets the operator move the cursor
 * explicitly (the per-stage verdict path also auto-advances; this is the
 * deterministic, auditable button).
 *
 * Renders nothing for non-milestone sessions (session.milestone undefined or
 * disabled, or no plan ingested yet) so it's invisible to legacy runs.
 *
 * Status pips mirror LoopRail: ✓ completed · ● active · ○ pending · ⃠ skipped.
 */
import { useMemo } from 'react'
import type { BlueprintSession, Milestone, MilestoneStatus } from '../api'

function statusGlyph(s: MilestoneStatus): string {
  switch (s) {
    case 'COMPLETED': return '✓'
    case 'ACTIVE': return '●'
    case 'SKIPPED': return '⃠'
    default: return '○'
  }
}

/** Mirror of the server's classifyMilestoneStages: the per-milestone band is
 *  the first DEVELOPER stage through the last stage before the aggregation tail
 *  (first DEVOPS stage, else the terminal stage). Used only to compute whether
 *  the active milestone is green so the Advance button can enable. */
function perMilestoneStageKeys(session: BlueprintSession): string[] {
  const stages = session.loopDefinition?.stages ?? []
  const role = (r?: string) => (r ?? '').toUpperCase()
  const firstDev = stages.findIndex(s => role(s.agentRole).includes('DEVELOP'))
  if (firstDev < 0) return []
  let aggStart = stages.findIndex((s, i) => i > firstDev && role(s.agentRole).includes('DEVOPS'))
  if (aggStart < 0) {
    const term = stages.findIndex((s, i) => i > firstDev && s.terminal === true)
    aggStart = term >= 0 ? term : stages.length
  }
  return stages.slice(firstDev, aggStart).map(s => s.key)
}

function isMilestoneGreen(session: BlueprintSession, milestoneId: string): boolean {
  const keys = perMilestoneStageKeys(session)
  if (keys.length === 0) return false
  const stages = session.loopDefinition?.stages ?? []
  return keys.every(stageKey => {
    const stage = stages.find(s => s.key === stageKey)
    if (stage && (stage as { required?: boolean }).required === false) return true
    const tagged = (session.stageAttempts ?? []).filter(a => a.stageKey === stageKey && a.milestoneId === milestoneId)
    const latest = tagged.at(-1)
    return latest?.verdict === 'PASS' || latest?.verdict === 'ACCEPTED_WITH_RISK'
  })
}

export function MilestoneRail({
  session,
  onAdvance,
  advancing,
}: {
  session: BlueprintSession
  /** POSTs the advance; the parent calls api.advanceMilestone + refreshes. */
  onAdvance?: (milestoneId: string) => void
  /** Disable the button while a request is in flight. */
  advancing?: boolean
}) {
  const ms = session.milestone
  const plan: Milestone[] = ms?.plan ?? []

  const { commitCountById, activeId, completedCount } = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const h of ms?.history ?? []) counts[h.milestoneId] = h.commitShas.length
    return {
      commitCountById: counts,
      activeId: ms?.currentMilestoneId ?? null,
      completedCount: plan.filter(m => m.status === 'COMPLETED' || m.status === 'SKIPPED').length,
    }
  }, [ms?.history, ms?.currentMilestoneId, plan])

  if (!ms?.enabled || plan.length === 0) return null

  const activeIdx = plan.findIndex(m => m.id === activeId)
  const nextMilestone = activeIdx >= 0 ? plan.slice(activeIdx + 1).find(m => m.status === 'PENDING') : undefined
  const activeGreen = activeId ? isMilestoneGreen(session, activeId) : false

  return (
    <section className="neo-milestone-rail" aria-label="Milestones">
      <header className="ms-header">
        <span className="ms-title">Milestones</span>
        <span className="ms-progress">{completedCount} of {plan.length} done</span>
      </header>
      <ol className="ms-list">
        {plan.map((m, i) => {
          const isActive = m.id === activeId
          const commits = commitCountById[m.id] ?? 0
          return (
            <li
              key={m.id}
              className={`ms-row ${m.status.toLowerCase()} ${isActive ? 'active' : ''}`}
              title={`${m.subGoal}\n\nAcceptance:\n${m.acceptanceCriteria.map(c => `• ${c}`).join('\n')}`}
            >
              <span className="ms-pip" aria-hidden>{statusGlyph(m.status)}</span>
              <span className="ms-body">
                <strong className="ms-id">{m.id}</strong>
                <span className="ms-name">{m.title}</span>
                <small className="ms-meta">
                  {m.status.toLowerCase()}
                  {m.acceptanceCriteria.length ? ` · ${m.acceptanceCriteria.length} criteria` : ''}
                  {commits ? ` · ${commits} commit${commits === 1 ? '' : 's'}` : ''}
                  {m.dependsOn.length ? ` · needs ${m.dependsOn.join(', ')}` : ''}
                </small>
              </span>
              {isActive && (
                <span className="ms-boundary">
                  {onAdvance && (
                    <button
                      type="button"
                      className="ms-advance"
                      disabled={!activeGreen || advancing}
                      title={
                        !activeGreen
                          ? 'Complete (accept) every stage of this milestone before advancing'
                          : nextMilestone
                            ? `Advance to ${nextMilestone.id}`
                            : 'Last milestone — finalize the run to certify & push'
                      }
                      onClick={() => onAdvance(m.id)}
                    >
                      {nextMilestone ? `Advance to ${nextMilestone.id} →` : 'All milestones done →'}
                    </button>
                  )}
                </span>
              )}
              {i < plan.length - 1 && <span className="ms-connector" aria-hidden />}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
