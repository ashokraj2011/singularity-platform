/**
 * M42.3 — FastAPI verification runner.
 *
 * Tries pytest first; falls back to python -m pytest. SKIPPED when
 * neither is on PATH.
 */
import { runCommand, tail } from './runCommand.js'
import { parsePythonBuild, unknownFromTail } from './parseBuild.js'
import type { VerificationResult } from './types.js'

export async function runPytest(projectDir: string): Promise<VerificationResult> {
  let r = await runCommand('pytest', ['-q'], { cwd: projectDir, timeoutMs: 5 * 60_000 })
  if (!r.available) {
    r = await runCommand('python3', ['-m', 'pytest', '-q'], { cwd: projectDir, timeoutMs: 5 * 60_000 })
  }
  if (!r.available) {
    return {
      status: 'SKIPPED',
      toolchain: 'pytest',
      durationMs: r.durationMs,
      checks: [],
      skippedReason: 'pytest and python3 are both unavailable in this container. Run from a host with Python 3.11 + pytest.',
    }
  }
  const findings = parsePythonBuild(r.stdout + '\n' + r.stderr)
  const passed = r.exitCode === 0
  return {
    status: passed ? 'PASSED' : 'FAILED',
    toolchain: 'pytest',
    durationMs: r.durationMs,
    checks: [
      {
        name: 'pytest -q',
        status: passed ? 'PASSED' : 'FAILED',
        message: passed ? 'Pytest run passed.' : `Pytest exited with ${r.exitCode}.`,
        findings: passed ? [] : (findings.length > 0 ? findings : unknownFromTail(r.stderr || r.stdout)),
      },
    ],
    stdoutTail: tail(r.stdout),
    stderrTail: tail(r.stderr),
  }
}
