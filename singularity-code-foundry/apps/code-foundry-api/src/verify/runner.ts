/**
 * M42.3 — Top-level dispatch for verification.
 *
 * Picks a per-stack runner based on the IR's framework. Each runner
 * already returns SKIPPED when its toolchain isn't available so the
 * caller can persist + surface the reason without special-casing it
 * here.
 */
import type { ApplicationIr } from '../ir/types.js'
import { runMvn } from './runMvn.js'
import { runPytest } from './runPytest.js'
import { runNpm } from './runNpm.js'
import type { VerificationResult } from './types.js'

export async function runVerification(ir: ApplicationIr, projectDir: string): Promise<VerificationResult> {
  switch (ir.application.framework) {
    case 'spring-boot': return runMvn(projectDir)
    case 'fastapi':     return runPytest(projectDir)
    case 'express':     return runNpm(projectDir)
    default:
      return {
        status: 'SKIPPED',
        toolchain: 'noop',
        durationMs: 0,
        checks: [],
        skippedReason: `No verifier registered for framework=${ir.application.framework}`,
      }
  }
}
