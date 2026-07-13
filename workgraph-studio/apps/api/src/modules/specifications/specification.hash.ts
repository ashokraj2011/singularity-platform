import { hashPayload } from '../../lib/snapshot'
import type { SpecificationPackageBody } from './specification.schemas'

/**
 * Canonical content hash of a specification's MEANINGFUL content — the requirements,
 * acceptance criteria, test obligations, contracts, sources, etc. — but NOT its version
 * number, status, or timestamps. So the same spec body hashes identically regardless of
 * key order or which draft revision produced it, and an implementation submission can be
 * checked against the exact approved content. Reuses the shared order-independent hasher.
 */
export function specificationContentHash(body: SpecificationPackageBody): string {
  const canonical = {
    summary: body.summary,
    glossary: body.glossary,
    sources: body.sources,
    requirements: body.requirements,
    acceptanceCriteria: body.acceptanceCriteria,
    testObligations: body.testObligations,
    contracts: body.contracts,
    risks: body.risks,
    outOfScope: body.outOfScope,
    openQuestions: body.openQuestions,
    reconciliationPolicy: body.reconciliationPolicy,
  }
  return `sha256:${hashPayload(canonical)}`
}
