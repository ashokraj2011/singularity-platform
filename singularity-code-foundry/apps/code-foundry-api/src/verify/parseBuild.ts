/**
 * M42.3 — Common build-output parsers.
 *
 * Each per-stack runner forwards stdout/stderr through these helpers
 * to turn raw text into structured VerificationFinding[] rows. The
 * regexes are conservative; misses fall back to a single `unknown`
 * finding so the operator at least sees the tail.
 */
import type { VerificationFinding } from './types.js'

const JAVAC_ERR = /^(.+\.java):(\d+):\s*(error|symbol|cannot find symbol):\s*(.+)$/gm
const PYTEST_FAIL = /^FAILED\s+([^\s:]+)(?:::([^\s]+))?\s*-\s*(.+)$/gm
const TS_TSC = /^([^()]+)\((\d+),\d+\):\s*error\s+TS\d+:\s*(.+)$/gm
const JEST_FAIL = /^●\s+(.+?)\s+›\s+(.+)$/gm

export function parseJavaBuild(out: string): VerificationFinding[] {
  const findings: VerificationFinding[] = []
  for (const m of out.matchAll(JAVAC_ERR)) {
    findings.push({
      kind: 'compile_error',
      filePath: m[1],
      line: Number(m[2]),
      message: `${m[3]}: ${m[4]}`,
    })
  }
  return findings
}

export function parsePythonBuild(out: string): VerificationFinding[] {
  const findings: VerificationFinding[] = []
  for (const m of out.matchAll(PYTEST_FAIL)) {
    findings.push({
      kind: 'test_failure',
      filePath: m[1],
      message: m[2] ? `${m[2]}: ${m[3]}` : m[3],
    })
  }
  // Catch SyntaxError / ImportError at module load.
  const synMatch = /(?:File "([^"]+)", line (\d+)[\s\S]*?(?:SyntaxError|ImportError|ModuleNotFoundError):\s*(.+))/m.exec(out)
  if (synMatch) {
    findings.push({
      kind: 'compile_error',
      filePath: synMatch[1],
      line: Number(synMatch[2]),
      message: synMatch[3],
    })
  }
  return findings
}

export function parseNodeBuild(out: string): VerificationFinding[] {
  const findings: VerificationFinding[] = []
  for (const m of out.matchAll(TS_TSC)) {
    findings.push({
      kind: 'compile_error',
      filePath: m[1],
      line: Number(m[2]),
      message: m[3],
    })
  }
  for (const m of out.matchAll(JEST_FAIL)) {
    findings.push({
      kind: 'test_failure',
      filePath: m[1],
      message: m[2],
    })
  }
  return findings
}

/**
 * When all stack parsers come back empty but the build still failed,
 * we want SOMETHING actionable. Capture the last ~10 lines of stderr
 * as a single 'unknown' finding so the operator sees the tail in the
 * UI without paging through a huge log.
 */
export function unknownFromTail(tail: string): VerificationFinding[] {
  const lines = tail.split(/\r?\n/).filter(Boolean).slice(-10)
  if (lines.length === 0) return []
  return [{ kind: 'unknown', message: lines.join('\n') }]
}
