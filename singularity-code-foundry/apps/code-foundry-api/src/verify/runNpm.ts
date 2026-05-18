/**
 * M42.3 — Express verification runner.
 *
 * `npm install --silent --no-audit --no-fund` then `npm test`.
 * Two-step so install errors are distinguishable from test failures.
 */
import { runCommand, tail } from './runCommand.js'
import { parseNodeBuild, unknownFromTail } from './parseBuild.js'
import type { VerificationCheck, VerificationResult, VerificationStatus } from './types.js'

export async function runNpm(projectDir: string): Promise<VerificationResult> {
  const checks: VerificationCheck[] = []
  let totalMs = 0

  const install = await runCommand(
    'npm',
    ['install', '--silent', '--no-audit', '--no-fund'],
    { cwd: projectDir, timeoutMs: 5 * 60_000 },
  )
  totalMs += install.durationMs
  if (!install.available) {
    return {
      status: 'SKIPPED',
      toolchain: 'npm',
      durationMs: totalMs,
      checks: [],
      skippedReason: 'npm not on PATH.',
    }
  }
  checks.push({
    name: 'npm install',
    status: install.exitCode === 0 ? 'PASSED' : 'FAILED',
    message: install.exitCode === 0 ? 'Dependencies installed.' : `npm install exit ${install.exitCode}.`,
    findings: install.exitCode === 0 ? [] : unknownFromTail(install.stderr || install.stdout),
  })

  let status: VerificationStatus = install.exitCode === 0 ? 'PASSED' : 'FAILED'
  let stdoutTail = install.stdout
  let stderrTail = install.stderr

  if (install.exitCode === 0) {
    const test = await runCommand('npm', ['test', '--silent'], { cwd: projectDir, timeoutMs: 5 * 60_000 })
    totalMs += test.durationMs
    const findings = parseNodeBuild(test.stdout + '\n' + test.stderr)
    const passed = test.exitCode === 0
    checks.push({
      name: 'npm test',
      status: passed ? 'PASSED' : 'FAILED',
      message: passed ? 'Jest run passed.' : `npm test exit ${test.exitCode}.`,
      findings: passed ? [] : (findings.length > 0 ? findings : unknownFromTail(test.stderr || test.stdout)),
    })
    status = passed ? 'PASSED' : 'FAILED'
    stdoutTail = test.stdout
    stderrTail = test.stderr
  }

  return {
    status,
    toolchain: 'npm',
    durationMs: totalMs,
    checks,
    stdoutTail: tail(stdoutTail),
    stderrTail: tail(stderrTail),
  }
}
