/**
 * M42.3 — Per-stack verification result shape.
 *
 * The verifier produces a structured result that's persisted to
 * codegen_verifications and consumed by the M42.6 UI. Keeping the
 * shape narrow + JSON-serialisable.
 */

export type CheckStatus = 'PASSED' | 'FAILED' | 'SKIPPED' | 'WARNING'

export type VerificationStatus = 'PASSED' | 'FAILED' | 'SKIPPED' | 'PARTIAL'

export interface VerificationCheck {
  name: string
  status: CheckStatus
  /** One-line summary surfaced in the UI / CLI. */
  message: string
  /** Optional structured findings — compile errors, failed tests, etc. */
  findings?: VerificationFinding[]
}

export interface VerificationFinding {
  kind: 'compile_error' | 'test_failure' | 'lint_error' | 'unknown'
  filePath?: string
  line?: number
  message: string
}

export interface VerificationResult {
  status: VerificationStatus
  toolchain: 'maven' | 'pytest' | 'npm' | 'noop'
  durationMs: number
  checks: VerificationCheck[]
  /** Captured stdout/stderr tails for debugging. */
  stdoutTail?: string
  stderrTail?: string
  /** When SKIPPED, why. */
  skippedReason?: string
}
