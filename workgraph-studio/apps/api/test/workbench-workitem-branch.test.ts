/**
 * Regression test for workbenchWorkitemBranch — the stage-INDEPENDENT shared
 * worktree branch used by every repo-touching stage of a workbench governed run.
 *
 * The bug this guards against: an unbound workbench session (no _workItem in the
 * workflow context) used to get a per-stage branch (`sg/<id>/<stage>/<attempt>`)
 * for the developer stage and *no* branch for review stages — so SECURITY/QA
 * resolved to the shared base /workspace instead of the developer's worktree and
 * reported "cannot verify implementation without diff". The fix: a single
 * branch that depends ONLY on the run identity (WorkItem code, else workflow
 * instance id, else session id) and is therefore identical across stages.
 */
import { describe, it, expect } from 'vitest'
import { workbenchWorkitemBranch } from '../src/modules/blueprint/blueprint.router'

describe('workbenchWorkitemBranch', () => {
  const session = { id: 'sess-123', workflowInstanceId: '0e1b360e-609c-4cee-b702-7fb81189a728' }

  it('uses the bound WorkItem code when present (wi/<code>)', () => {
    expect(workbenchWorkitemBranch(session, { workItemCode: 'WRK-984' })).toBe('wi/WRK-984')
  })

  it('falls back to the workflow instance id when no WorkItem is bound', () => {
    expect(workbenchWorkitemBranch(session, {})).toBe('wi/0e1b360e-609c-4cee-b702-7fb81189a728')
    expect(workbenchWorkitemBranch(session, null)).toBe('wi/0e1b360e-609c-4cee-b702-7fb81189a728')
    expect(workbenchWorkitemBranch(session, { workItemCode: null })).toBe('wi/0e1b360e-609c-4cee-b702-7fb81189a728')
  })

  it('falls back to the session id when neither WorkItem nor instance id exists', () => {
    expect(workbenchWorkitemBranch({ id: 'sess-123' }, {})).toBe('wi/blueprint-sess-123')
    expect(workbenchWorkitemBranch({ id: 'sess-123', workflowInstanceId: '   ' }, {})).toBe('wi/blueprint-sess-123')
  })

  it('is STAGE-INDEPENDENT — identical for the same run regardless of caller context', () => {
    // The signature takes no stage/attempt, so every stage of a run gets the
    // same branch (and therefore the same per-workitem worktree). This is the
    // core property that lets review stages see the developer's commits.
    const a = workbenchWorkitemBranch(session, { workItemCode: 'WRK-1' })
    const b = workbenchWorkitemBranch(session, { workItemCode: 'WRK-1' })
    expect(a).toBe(b)
  })

  it('sanitizes unsafe characters and caps length', () => {
    const out = workbenchWorkitemBranch(session, { workItemCode: 'feat/login bug#1!' })
    expect(out.startsWith('wi/')).toBe(true)
    expect(out).not.toMatch(/[^a-zA-Z0-9._/-]/)
    expect(out.length).toBeLessThanOrEqual(180)
  })
})
