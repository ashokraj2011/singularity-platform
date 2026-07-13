/**
 * Reconciliation runner — the pure core (spec §15, "Layer 2"). The dependency-injected logic that
 * turns a claimed ReconciliationJob into a set of test results, kept free of git / child_process /
 * network so it is unit-testable. The wiring (real git checkout, shell exec, HTTP client, poll
 * loop) lives in runner.ts.
 */

export interface TestPlanEntry {
  obligationId: string
  requirementIds: string[]
  description?: string
  command?: string
}

export interface RunnerJob {
  id: string
  reconciliationRunId: string
  repository: string
  baseCommitSha: string
  headCommitSha: string
  testPlan: TestPlanEntry[]
  claimToken?: string | null
}

export interface TestResult {
  obligationId?: string
  requirementIds?: string[]
  status: 'PASS' | 'FAIL' | 'SKIPPED'
  output?: string
}

export interface CommandOutcome {
  code: number
  output: string
}

export interface CheckoutHandle {
  cwd: string
  cleanup: () => Promise<void>
}

/** The side-effectful operations the core delegates — real ones in runner.ts, fakes in tests. */
export interface RunnerExec {
  checkout(job: RunnerJob): Promise<CheckoutHandle>
  runCommand(command: string, cwd: string): Promise<CommandOutcome>
  /** fallback test command for an obligation that declares none. */
  defaultCommand?: string
}

const MAX_OUTPUT = 4000

export function truncate(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n… (${s.length - max} more chars truncated)`
}

/**
 * Run each plan entry's command in the checked-out repo and map the exit code to a verdict signal:
 * exit 0 → PASS, non-zero → FAIL. An obligation with no command (and no default) is SKIPPED rather
 * than silently passed — the dynamic layer treats SKIPPED as "not executed", so it never inflates
 * a verdict.
 */
export async function executeTestPlan(plan: TestPlanEntry[], cwd: string, exec: RunnerExec): Promise<TestResult[]> {
  const results: TestResult[] = []
  for (const entry of plan) {
    const command = entry.command ?? exec.defaultCommand
    if (!command) {
      results.push({ obligationId: entry.obligationId, requirementIds: entry.requirementIds, status: 'SKIPPED', output: 'No command declared for this obligation and no default command configured.' })
      continue
    }
    try {
      const outcome = await exec.runCommand(command, cwd)
      results.push({
        obligationId: entry.obligationId,
        requirementIds: entry.requirementIds,
        status: outcome.code === 0 ? 'PASS' : 'FAIL',
        output: truncate(outcome.output ?? ''),
      })
    } catch (err) {
      // Command could not be launched (bad binary, timeout kill) → treat as a failed test, not a
      // job failure: the other obligations should still run and report.
      results.push({ obligationId: entry.obligationId, requirementIds: entry.requirementIds, status: 'FAIL', output: truncate(err instanceof Error ? err.message : String(err)) })
    }
  }
  return results
}

/** Check out the submission's head commit, run the whole plan, and always clean up the workspace. */
export async function runReconciliationJob(job: RunnerJob, exec: RunnerExec): Promise<TestResult[]> {
  const handle = await exec.checkout(job)
  try {
    return await executeTestPlan(job.testPlan ?? [], handle.cwd, exec)
  } finally {
    await handle.cleanup().catch(() => {})
  }
}
