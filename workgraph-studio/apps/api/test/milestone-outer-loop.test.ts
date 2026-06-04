/**
 * Milestones (P1–P3) — the in-session outer loop.
 *
 * Pins the pure decomposition + outer-loop helpers so the cursor advance, the
 * per-milestone stage classification, and the green-gates can't silently drift:
 *   • classifyMilestoneStages — session / per-milestone / aggregation bands.
 *   • parseMilestonePlan + applyMilestonePlan — decomposition → cursor.
 *   • advanceMilestone — complete current, move cursor (or null at the end),
 *     capture per-stage accepted attempt ids into history.
 *   • isMilestoneGreen / allMilestonesGreen — gate predicates, milestone-scoped.
 *   • nextAdvanceableMilestone — dependsOn-aware ordering.
 */
import { describe, expect, it } from 'vitest'

import {
  advanceMilestone,
  allMilestonesGreen,
  applyMilestonePlan,
  classifyMilestoneStages,
  isMilestoneGreen,
  nextAdvanceableMilestone,
  parseMilestonePlan,
} from '../src/modules/blueprint/blueprint.router'

type LoopDef = Parameters<typeof classifyMilestoneStages>[0]
type State = Parameters<typeof advanceMilestone>[0]

// The canonical SDLC loop: intake → plan → design(ARCHITECT) → develop →
// security → qa → release(DEVOPS) → cert(QA, terminal).
const SDLC_STAGES = [
  { key: 'intake', label: 'Intake', agentRole: 'PRODUCT', next: 'plan' },
  { key: 'plan', label: 'Plan', agentRole: 'ARCHITECT', next: 'design' },
  { key: 'design', label: 'Design', agentRole: 'ARCHITECT', next: 'develop' },
  { key: 'develop', label: 'Develop', agentRole: 'DEVELOPER', next: 'security' },
  { key: 'security', label: 'Security', agentRole: 'SECURITY', next: 'qa' },
  { key: 'qa', label: 'QA', agentRole: 'QA', next: 'release' },
  { key: 'release', label: 'Release', agentRole: 'DEVOPS', next: 'cert' },
  { key: 'cert', label: 'Cert', agentRole: 'QA', next: null, terminal: true },
]

const loopDef = (stages: unknown[] = SDLC_STAGES): LoopDef =>
  ({ version: 1, name: 'sdlc', stages, maxLoopsPerStage: 3, maxTotalSendBacks: 6 }) as unknown as LoopDef

const attempt = (stageKey: string, milestoneId: string | undefined, verdict: string, n = 1) =>
  ({
    id: `${stageKey}-${milestoneId ?? 'x'}-${n}`,
    stageKey,
    milestoneId,
    stageLabel: stageKey,
    agentRole: 'X',
    attemptNumber: n,
    status: verdict === 'PASS' ? 'PASSED' : verdict,
    startedAt: '2026-01-01T00:00:00.000Z',
    verdict,
  })

const milestone = (id: string, status: string, dependsOn: string[] = []) =>
  ({ id, title: `T-${id}`, subGoal: `do ${id}`, acceptanceCriteria: ['ac'], dependsOn, status })

const state = (over: Record<string, unknown>): State =>
  ({
    loopDefinition: loopDef(),
    stageAttempts: [],
    ...over,
  }) as unknown as State

// ── classifyMilestoneStages ───────────────────────────────────────────────
describe('classifyMilestoneStages', () => {
  it('splits the SDLC loop into per-milestone (develop→qa) and aggregation (release→cert)', () => {
    const c = classifyMilestoneStages(loopDef())
    expect(c.perMilestone).toEqual(['develop', 'security', 'qa'])
    expect(c.aggregation).toEqual(['release', 'cert'])
    expect(c.firstPerMilestone).toBe('develop')
    expect(c.lastPerMilestone).toBe('qa')
    expect(c.firstAggregation).toBe('release')
  })

  it('does NOT mis-detect DEVOPS as the first developer stage', () => {
    // DEVOPS contains "DEV" but not "DEVELOP" — the develop stage must win.
    const c = classifyMilestoneStages(loopDef())
    expect(c.firstPerMilestone).toBe('develop')
  })

  it('falls back to the terminal stage as the aggregation boundary when no DEVOPS stage exists', () => {
    const noDevops = SDLC_STAGES.filter(s => s.agentRole !== 'DEVOPS')
    const c = classifyMilestoneStages(loopDef(noDevops))
    // aggregation begins at the terminal cert stage; per-milestone = develop..qa
    expect(c.perMilestone).toEqual(['develop', 'security', 'qa'])
    expect(c.aggregation).toEqual(['cert'])
    expect(c.lastPerMilestone).toBe('qa')
  })

  it('returns empty bands when there is no developer stage', () => {
    const noDev = SDLC_STAGES.filter(s => s.agentRole !== 'DEVELOPER')
    const c = classifyMilestoneStages(loopDef(noDev))
    expect(c.perMilestone).toEqual([])
    expect(c.firstPerMilestone).toBeNull()
  })
})

// ── parse + apply ──────────────────────────────────────────────────────────
describe('parseMilestonePlan + applyMilestonePlan', () => {
  it('parses, topo-sorts, and marks the first milestone ACTIVE', () => {
    const plan = parseMilestonePlan(
      JSON.stringify({
        version: 1,
        milestones: [
          { id: 'M2', title: 'second', subGoal: 'build on M1', acceptanceCriteria: ['x'], dependsOn: ['M1'] },
          { id: 'M1', title: 'first', subGoal: 'foundation work', acceptanceCriteria: ['y'], dependsOn: [] },
        ],
      }),
    )
    expect(plan).not.toBeNull()
    expect(plan!.map(m => m.id)).toEqual(['M1', 'M2']) // topo-sorted

    const s = applyMilestonePlan(state({ milestone: { enabled: true, plan: [], currentMilestoneId: null, history: [] } }), plan!)
    expect(s.milestone!.currentMilestoneId).toBe('M1')
    expect(s.milestone!.plan[0].status).toBe('ACTIVE')
    expect(s.milestone!.plan[1].status).toBe('PENDING')
  })

  it('rejects cycles and self-references', () => {
    expect(parseMilestonePlan(JSON.stringify({ milestones: [
      { id: 'M1', title: 'a', subGoal: 'aaaaaaaa', acceptanceCriteria: ['x'], dependsOn: ['M2'] },
      { id: 'M2', title: 'b', subGoal: 'bbbbbbbb', acceptanceCriteria: ['y'], dependsOn: ['M1'] },
    ] }))).toBeNull()
    expect(parseMilestonePlan(JSON.stringify({ milestones: [
      { id: 'M1', title: 'a', subGoal: 'aaaaaaaa', acceptanceCriteria: ['x'], dependsOn: ['M1'] },
    ] }))).toBeNull()
  })

  it('tolerates a ```json fenced body', () => {
    const plan = parseMilestonePlan('```json\n{"milestones":[{"id":"M1","title":"first","subGoal":"aaaaaaaa","acceptanceCriteria":["x"],"dependsOn":[]}]}\n```')
    expect(plan?.map(m => m.id)).toEqual(['M1'])
  })
})

// ── nextAdvanceableMilestone ────────────────────────────────────────────────
describe('nextAdvanceableMilestone', () => {
  it('returns the next PENDING milestone whose deps are satisfied', () => {
    const ms = { enabled: true, currentMilestoneId: null, history: [], plan: [
      milestone('M1', 'COMPLETED'),
      milestone('M2', 'PENDING', ['M1']),
      milestone('M3', 'PENDING', ['M2']),
    ] }
    expect(nextAdvanceableMilestone(ms as never)?.id).toBe('M2')
  })

  it('skips a PENDING milestone whose dependency is not yet done', () => {
    const ms = { enabled: true, currentMilestoneId: null, history: [], plan: [
      milestone('M1', 'PENDING'),
      milestone('M2', 'PENDING', ['M3']), // dep M3 not done
      milestone('M3', 'PENDING'),
    ] }
    expect(nextAdvanceableMilestone(ms as never)?.id).toBe('M1')
  })
})

// ── advanceMilestone ────────────────────────────────────────────────────────
describe('advanceMilestone', () => {
  const greenM1 = [
    attempt('develop', 'M1', 'PASS'),
    attempt('security', 'M1', 'PASS'),
    attempt('qa', 'M1', 'ACCEPTED_WITH_RISK'),
  ]

  it('completes the active milestone, moves the cursor, and records history', () => {
    const s = state({
      stageAttempts: greenM1,
      milestone: { enabled: true, currentMilestoneId: 'M1', history: [], plan: [
        milestone('M1', 'ACTIVE'),
        milestone('M2', 'PENDING', ['M1']),
      ] },
    })
    const { milestone: next, advancedTo } = advanceMilestone(s)
    expect(advancedTo).toBe('M2')
    expect(next.currentMilestoneId).toBe('M2')
    expect(next.plan.find(m => m.id === 'M1')!.status).toBe('COMPLETED')
    expect(next.plan.find(m => m.id === 'M2')!.status).toBe('ACTIVE')
    expect(next.history).toHaveLength(1)
    expect(next.history[0].milestoneId).toBe('M1')
    // accepted attempt id captured for each per-milestone stage
    expect(next.history[0].finalAttemptIdsByStage).toEqual({
      develop: 'develop-M1-1',
      security: 'security-M1-1',
      qa: 'qa-M1-1',
    })
  })

  it('sets the cursor to null after the LAST milestone (enter aggregation)', () => {
    const s = state({
      stageAttempts: greenM1,
      milestone: { enabled: true, currentMilestoneId: 'M1', history: [], plan: [milestone('M1', 'ACTIVE')] },
    })
    const { milestone: next, advancedTo } = advanceMilestone(s)
    expect(advancedTo).toBeNull()
    expect(next.currentMilestoneId).toBeNull()
    expect(next.plan[0].status).toBe('COMPLETED')
    expect(allMilestonesGreen(state({ milestone: next }))).toBe(true)
  })
})

// ── green gates ─────────────────────────────────────────────────────────────
describe('isMilestoneGreen', () => {
  it('is green only when every per-milestone stage has a PASS tagged with that milestone', () => {
    const s = state({
      stageAttempts: [attempt('develop', 'M1', 'PASS'), attempt('security', 'M1', 'PASS'), attempt('qa', 'M1', 'PASS')],
      milestone: { enabled: true, currentMilestoneId: 'M1', history: [], plan: [milestone('M1', 'ACTIVE')] },
    })
    expect(isMilestoneGreen(s, 'M1')).toBe(true)
  })

  it('does NOT count a PRIOR milestone\'s attempt as the current milestone\'s green', () => {
    // qa only has an M1-tagged PASS; M2 has none → M2 is not green.
    const s = state({
      stageAttempts: [
        attempt('develop', 'M2', 'PASS'), attempt('security', 'M2', 'PASS'),
        attempt('qa', 'M1', 'PASS'), // prior milestone only
      ],
      milestone: { enabled: true, currentMilestoneId: 'M2', history: [], plan: [milestone('M1', 'COMPLETED'), milestone('M2', 'ACTIVE')] },
    })
    expect(isMilestoneGreen(s, 'M2')).toBe(false)
    expect(isMilestoneGreen(s, 'M1')).toBe(false) // M1 only has qa
  })
})

describe('allMilestonesGreen', () => {
  it('is true only when every milestone is COMPLETED/SKIPPED', () => {
    expect(allMilestonesGreen(state({ milestone: { enabled: true, currentMilestoneId: null, history: [], plan: [
      milestone('M1', 'COMPLETED'), milestone('M2', 'SKIPPED'),
    ] } }))).toBe(true)
    expect(allMilestonesGreen(state({ milestone: { enabled: true, currentMilestoneId: 'M2', history: [], plan: [
      milestone('M1', 'COMPLETED'), milestone('M2', 'ACTIVE'),
    ] } }))).toBe(false)
  })

  it('treats a non-milestone session as trivially green', () => {
    expect(allMilestonesGreen(state({ milestone: undefined }))).toBe(true)
  })
})
