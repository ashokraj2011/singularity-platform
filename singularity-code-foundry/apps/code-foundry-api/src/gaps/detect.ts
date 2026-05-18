/**
 * M42.3 — Gap detector.
 *
 * Composes:
 *   1. Static file scanners (TODO / mustache / placeholder / region)
 *   2. (Optional) verification-result enrichment — turn compile/test
 *      failures into structured COMPILE_ERROR / TEST_FAILURE gaps.
 *
 * Returns DetectedGap[]; persistence is the caller's job (the REST
 * route writes them via prisma.codegenGap.createMany).
 */
import { scanProject } from './scanFiles.js'
import type { DetectedGap } from './types.js'
import type { VerificationResult } from '../verify/types.js'

export interface DetectInput {
  projectDir: string
  /** Optional — when supplied, build failures become structured gaps. */
  verification?: VerificationResult
}

export function detectGaps(input: DetectInput): DetectedGap[] {
  const out: DetectedGap[] = []
  out.push(...scanProject(input.projectDir))
  if (input.verification && input.verification.status === 'FAILED') {
    for (const check of input.verification.checks) {
      for (const finding of check.findings ?? []) {
        out.push({
          type: finding.kind === 'compile_error' ? 'COMPILE_ERROR' :
                finding.kind === 'test_failure'  ? 'TEST_FAILURE'  :
                'COMPILE_ERROR',  // unknown defaults to compile_error severity
          severity: finding.kind === 'test_failure' ? 'medium' : 'high',
          filePath: finding.filePath,
          description: `${check.name}: ${finding.message}`,
          recommendedResolution: 'Inspect the build output tail in the verification result; fix or send to the LLM patch task.',
          llmEligible: finding.kind === 'compile_error' || finding.kind === 'test_failure',
        })
      }
    }
  }
  return dedup(out)
}

function dedup(gaps: DetectedGap[]): DetectedGap[] {
  const seen = new Set<string>()
  const out: DetectedGap[] = []
  for (const g of gaps) {
    const key = `${g.type}::${g.filePath ?? ''}::${g.regionId ?? ''}::${g.description}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(g)
  }
  return out
}
