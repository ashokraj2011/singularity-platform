import { describe, it, expect } from 'vitest'
import { executeTestPlan, runReconciliationJob, type RunnerExec, type RunnerJob, type CommandOutcome } from '../src/reconciliation-runner/runner.core'

const job = (over: Partial<RunnerJob> = {}): RunnerJob => ({
  id: 'job-1',
  reconciliationRunId: 'run-1',
  repository: 'org/repo',
  baseCommitSha: 'base',
  headCommitSha: 'head',
  testPlan: [
    { obligationId: 'T-1', requirementIds: ['REQ-1'], command: 'run-a' },
    { obligationId: 'T-2', requirementIds: ['REQ-2'], command: 'run-b' },
  ],
  ...over,
})

// Fake exec: canned command outcomes by command string; records checkout/cleanup calls.
function fakeExec(outcomes: Record<string, CommandOutcome>, opts: { defaultCommand?: string; throwOn?: string } = {}) {
  const calls = { checkout: 0, cleanup: 0, commands: [] as string[] }
  const exec: RunnerExec = {
    defaultCommand: opts.defaultCommand,
    async checkout() { calls.checkout++; return { cwd: '/tmp/x', cleanup: async () => { calls.cleanup++ } } },
    async runCommand(command: string) {
      calls.commands.push(command)
      if (opts.throwOn && command === opts.throwOn) throw new Error('spawn failed')
      return outcomes[command] ?? { code: 0, output: '' }
    },
  }
  return { exec, calls }
}

describe('executeTestPlan', () => {
  it('maps exit 0 to PASS and non-zero to FAIL, carrying requirement ids', async () => {
    const { exec } = fakeExec({ 'run-a': { code: 0, output: 'ok' }, 'run-b': { code: 1, output: 'boom' } })
    const results = await executeTestPlan(job().testPlan, '/tmp/x', exec)
    expect(results.find((r) => r.obligationId === 'T-1')).toMatchObject({ status: 'PASS', requirementIds: ['REQ-1'] })
    expect(results.find((r) => r.obligationId === 'T-2')).toMatchObject({ status: 'FAIL', requirementIds: ['REQ-2'] })
  })

  it('SKIPS an obligation with no command and no default (never inflates a pass)', async () => {
    const { exec, calls } = fakeExec({})
    const results = await executeTestPlan([{ obligationId: 'T-9', requirementIds: ['REQ-9'] }], '/tmp/x', exec)
    expect(results[0].status).toBe('SKIPPED')
    expect(calls.commands).toHaveLength(0)
  })

  it('falls back to the default command when an obligation declares none', async () => {
    const { exec, calls } = fakeExec({ 'npm test': { code: 0, output: '' } }, { defaultCommand: 'npm test' })
    const results = await executeTestPlan([{ obligationId: 'T-9', requirementIds: ['REQ-9'] }], '/tmp/x', exec)
    expect(results[0].status).toBe('PASS')
    expect(calls.commands).toEqual(['npm test'])
  })

  it('records a launch failure as a FAIL, not a thrown job', async () => {
    const { exec } = fakeExec({}, { throwOn: 'run-a' })
    const results = await executeTestPlan([{ obligationId: 'T-1', requirementIds: ['REQ-1'], command: 'run-a' }], '/tmp/x', exec)
    expect(results[0].status).toBe('FAIL')
    expect(results[0].output).toContain('spawn failed')
  })
})

describe('runReconciliationJob', () => {
  it('checks out, runs the plan, and always cleans up the workspace', async () => {
    const { exec, calls } = fakeExec({ 'run-a': { code: 0, output: '' }, 'run-b': { code: 0, output: '' } })
    const results = await runReconciliationJob(job(), exec)
    expect(results).toHaveLength(2)
    expect(calls.checkout).toBe(1)
    expect(calls.cleanup).toBe(1)
  })
})
