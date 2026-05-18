/**
 * M42.3 — Spring Boot verification runner.
 *
 * Shells out to `mvn -q -B test`. If mvn isn't on PATH (the dev
 * container doesn't ship a JDK + Maven on purpose — keeps the image
 * small), the runner returns SKIPPED with a clear reason. M42.6 will
 * spin up a separate "verifier" sidecar with the toolchain pre-baked
 * when production deployments need automated verify on every run.
 */
import { runCommand, tail } from './runCommand.js'
import { parseJavaBuild, unknownFromTail } from './parseBuild.js'
import type { VerificationResult } from './types.js'

export async function runMvn(projectDir: string): Promise<VerificationResult> {
  const r = await runCommand('mvn', ['-q', '-B', 'test'], { cwd: projectDir, timeoutMs: 5 * 60_000 })
  if (!r.available) {
    return {
      status: 'SKIPPED',
      toolchain: 'maven',
      durationMs: r.durationMs,
      checks: [],
      skippedReason: 'mvn not on PATH in this container. Run from a host with a JDK + Maven installed, or use the verifier sidecar.',
    }
  }
  const findings = parseJavaBuild(r.stdout + '\n' + r.stderr)
  const passed = r.exitCode === 0
  return {
    status: passed ? 'PASSED' : 'FAILED',
    toolchain: 'maven',
    durationMs: r.durationMs,
    checks: [
      {
        name: 'mvn test',
        status: passed ? 'PASSED' : 'FAILED',
        message: passed ? 'Maven test phase passed.' : `Maven test phase failed (exit ${r.exitCode}).`,
        findings: passed ? [] : (findings.length > 0 ? findings : unknownFromTail(r.stderr || r.stdout)),
      },
    ],
    stdoutTail: tail(r.stdout),
    stderrTail: tail(r.stderr),
  }
}
