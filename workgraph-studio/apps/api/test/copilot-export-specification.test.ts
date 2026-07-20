/**
 * The exported Copilot workflow must carry the design specification.
 *
 * A developer exports a run, leaves the platform, builds off-platform, and pushes. When they
 * return, `validateSubmissionManifest` measures the submission against the spec — and that
 * check keys off two values the developer can only learn from this file:
 *
 *   • `specificationHash` — a mismatch REJECTS the submission (`spec-hash-matches`).
 *   • `claims[].requirementId` — an id outside the handoff scope REJECTS it as dangling
 *     (`claims-reference-in-scope`).
 *
 * So these assertions are about a wire contract, not cosmetics: requirement ids must survive
 * YAML emission byte-exact, and the hash must be the same one the validator will compare.
 *
 * The YAML is PARSED here rather than string-matched — a block that merely "contains" an id
 * but nests it wrongly would satisfy a substring check and still be useless to the reader.
 *
 * `buildCopilotWorkflowExport` and `narrowSpecificationForExport` are both pure, so this
 * needs no Postgres, no context-fabric and no network.
 */
import { describe, it, expect } from 'vitest'
import YAML from 'yaml'
import { buildCopilotWorkflowExport } from '../src/modules/workflow/instances.router'
import { narrowSpecificationForExport } from '../src/modules/workflow/runtime/copilot-export-spec'

// A package body with three requirements, of which the handoff scopes two. Ids deliberately
// contain the characters a naive emitter mangles (`:` and `-`), and one statement carries a
// colon, a quote and a newline — all YAML structure characters.
const PACKAGE = {
  summary: 'Checkout hardening',
  requirements: [
    {
      id: 'REQ-1: auth',
      type: 'SECURITY',
      statement: 'The endpoint MUST reject unauthenticated callers.\nReturn 401, not 403: the distinction matters.',
      rationale: 'Anonymous writes were possible.',
      priority: 'MUST',
      risk: 'CRITICAL',
      acceptanceCriterionIds: ['AC-1'],
      testObligationIds: ['TO-1'],
    },
    {
      id: 'REQ-2',
      type: 'FUNCTIONAL',
      statement: 'The cart total MUST include tax.',
      priority: 'MUST',
      risk: 'MEDIUM',
      acceptanceCriterionIds: ['AC-2'],
      testObligationIds: ['TO-2'],
    },
    {
      id: 'REQ-3-out-of-scope',
      type: 'PERFORMANCE',
      statement: 'Checkout SHOULD complete within 200ms.',
      priority: 'SHOULD',
      risk: 'LOW',
      acceptanceCriterionIds: ['AC-3'],
      testObligationIds: ['TO-3'],
    },
  ],
  acceptanceCriteria: [
    { id: 'AC-1', requirementIds: ['REQ-1: auth'], given: ['an anonymous caller'], when: ['they POST /cart'], then: ['the response is 401'] },
    { id: 'AC-2', requirementIds: ['REQ-2'], given: ['a cart with one item'], when: ['the total is computed'], then: ['tax is included'] },
    { id: 'AC-3', requirementIds: ['REQ-3-out-of-scope'], given: ['a warm cache'], when: ['checkout runs'], then: ['it finishes under 200ms'] },
  ],
  testObligations: [
    { id: 'TO-1', verifies: ['REQ-1: auth'], kind: 'security', description: 'Prove the 401 path.', requiredEvidence: ['TEST'], minimumCases: ['anonymous caller is rejected'] },
    { id: 'TO-2', verifies: ['REQ-2'], kind: 'behavior', description: 'Prove tax maths.', requiredEvidence: ['TEST', 'DOC'], minimumCases: ['zero-rated item', 'standard-rated item'] },
    { id: 'TO-3', verifies: ['REQ-3-out-of-scope'], kind: 'performance', description: 'Prove the latency budget.', requiredEvidence: ['BENCHMARK'], minimumCases: ['p95 under 200ms'] },
  ],
  reconciliationPolicy: { profile: 'STRICT', requiredEvidence: ['TEST'], forbiddenPaths: ['infra/**'] },
}

const IN_SCOPE = ['REQ-1: auth', 'REQ-2']

function narrow(over: Partial<Parameters<typeof narrowSpecificationForExport>[0]> = {}) {
  return narrowSpecificationForExport({
    versionId: 'spec-version-7',
    version: 7,
    status: 'APPROVED',
    contentHash: 'sha256:abc123',
    packageBody: PACKAGE,
    scopeRequirementIds: IN_SCOPE,
    scopeSource: 'handoffGeneration',
    ...over,
  })
}

function stage() {
  return {
    key: 'DEVELOP',
    nodeId: 'node-dev',
    label: 'Implement the change',
    nodeType: 'AGENT_TASK',
    role: 'developer',
    prompt: 'Harden checkout.',
    reads: [],
    produces: [],
  }
}

function build(extras: Parameters<typeof buildCopilotWorkflowExport>[2] = {}) {
  return buildCopilotWorkflowExport(
    { id: 'run-1', name: 'SDLC run', context: { workBranch: 'wi/ABC-1' } },
    { stages: [stage()], repo: 'https://github.com/acme/app.git', story: 'Harden checkout', workCode: 'ABC-1' },
    extras,
  )
}

function exportedSpec(extras: Parameters<typeof buildCopilotWorkflowExport>[2] = {}) {
  const { yaml } = build(extras)
  // A real parse: proves the block is well-formed YAML in the right place, not just present.
  const doc = YAML.parse(yaml) as Record<string, any>
  return { yaml, doc, spec: doc.specification }
}

describe('the exported copilot workflow carries the design specification', () => {
  it('emits the join key a returning submission has to prove itself with', () => {
    const { spec } = exportedSpec({ specification: narrow().specification })

    // Without both of these a submission cannot be matched to what it was built against.
    expect(spec.versionId).toBe('spec-version-7')
    expect(spec.contentHash).toBe('sha256:abc123')
    expect(spec.version).toBe(7)
    expect(spec.status).toBe('APPROVED')
  })

  it('keeps requirement ids byte-exact through YAML emission', () => {
    const { spec } = exportedSpec({ specification: narrow().specification })

    // These are THE contract: a later submission claims these strings verbatim, so an id
    // that YAML mangled (the colon in `REQ-1: auth` is the trap) would be unclaimable.
    expect(spec.requirements.map((r: any) => r.id)).toEqual(['REQ-1: auth', 'REQ-2'])
    expect(spec.scope.requirementIds).toEqual(['REQ-1: auth', 'REQ-2'])
  })

  it('emits only the in-scope requirements, not the whole package', () => {
    const { spec, yaml } = exportedSpec({ specification: narrow().specification })

    expect(spec.requirements).toHaveLength(2)
    expect(spec.requirements.map((r: any) => r.id)).not.toContain('REQ-3-out-of-scope')
    // Out-of-scope content must not leak anywhere in the document — a developer reading it
    // would otherwise build something the reconciliation never asked for.
    expect(yaml).not.toContain('REQ-3-out-of-scope')
    expect(yaml).not.toContain('Checkout SHOULD complete within 200ms')
    expect(spec.scope.declared).toBe(true)
    expect(spec.scope.source).toBe('handoffGeneration')
  })

  it('carries acceptance criteria and test obligations for the scoped requirements only', () => {
    const { spec } = exportedSpec({ specification: narrow().specification })

    expect(spec.acceptanceCriteria.map((c: any) => c.id)).toEqual(['AC-1', 'AC-2'])
    expect(spec.acceptanceCriteria[0].given).toEqual(['an anonymous caller'])
    expect(spec.acceptanceCriteria[0].when).toEqual(['they POST /cart'])
    expect(spec.acceptanceCriteria[0].then).toEqual(['the response is 401'])

    expect(spec.testObligations.map((t: any) => t.id)).toEqual(['TO-1', 'TO-2'])
    const to2 = spec.testObligations.find((t: any) => t.id === 'TO-2')
    expect(to2.requiredEvidence).toEqual(['TEST', 'DOC'])
    expect(to2.minimumCases).toEqual(['zero-rated item', 'standard-rated item'])
  })

  it('preserves a multi-line statement containing YAML structure characters', () => {
    const { spec } = exportedSpec({ specification: narrow().specification })
    // Colon + newline + the word ordering all intact after a genuine round-trip.
    expect(spec.requirements[0].statement).toBe(
      'The endpoint MUST reject unauthenticated callers.\nReturn 401, not 403: the distinction matters.',
    )
    expect(spec.requirements[0].rationale).toBe('Anonymous writes were possible.')
    expect(spec.requirements[0].priority).toBe('MUST')
    expect(spec.requirements[0].risk).toBe('CRITICAL')
  })

  it('carries the reconciliation policy the work will actually be judged by', () => {
    const { spec } = exportedSpec({ specification: narrow().specification })
    expect(spec.reconciliationPolicy.source).toBe('specification')
    expect(spec.reconciliationPolicy.policy.profile).toBe('STRICT')
    expect(spec.reconciliationPolicy.policy.forbiddenPaths).toEqual(['infra/**'])
  })

  it("prefers the handoff's reconciliation policy over the specification's", () => {
    // reconciliations.service evaluates the handoff/target policy, not the package's, so the
    // export must show the one that will actually be applied.
    const { specification } = narrow({ handoffReconciliationPolicy: { profile: 'LENIENT', requiredEvidence: [] } })
    const { spec } = exportedSpec({ specification })
    expect(spec.reconciliationPolicy.source).toBe('handoff')
    expect(spec.reconciliationPolicy.policy.profile).toBe('LENIENT')
  })

  it('tells the reader how to use the block', () => {
    const { yaml } = build({ specification: narrow().specification })
    expect(yaml).toContain('echo this back as submission specificationHash')
  })
})

describe('an export with no bound specification still works', () => {
  it('emits a valid document with a warning instead of failing', () => {
    // The degrade case: a run whose work item has no spec must still hand off. An export
    // that 500s because a spec is missing is worse than one without a spec.
    const warning = 'Work Item ABC-1 has no specification bound, so the export carries no specification block.'
    const { doc, yaml } = exportedSpec({ specification: null, specificationWarnings: [warning] })

    expect(doc.specification).toBeNull()
    expect(doc.specificationWarnings).toEqual([warning])
    // The rest of the handoff is intact — this is still a runnable export.
    expect(doc.stages).toHaveLength(1)
    expect(doc.repository.branch).toBe('wi/ABC-1')
    expect(yaml).toContain('A submission cannot be spec-validated on return.')
  })

  it('emits an empty warning list rather than malformed YAML when nothing was reported', () => {
    const { doc } = exportedSpec({})
    expect(doc.specification).toBeNull()
    expect(doc.specificationWarnings).toEqual([])
  })
})

describe('narrowSpecificationForExport', () => {
  it('treats an undeclared scope as "every requirement", matching the reconciliation engine', () => {
    // reconciliation.engine: "an explicit handoff scope wins; otherwise every requirement is
    // in scope". The export must not disagree with the thing that will grade the work.
    const { specification } = narrow({ scopeRequirementIds: [], scopeSource: 'none' })
    expect(specification!.scopeDeclared).toBe(false)
    expect(specification!.requirements).toHaveLength(3)
    expect(specification!.warnings).toContainEqual(
      expect.stringContaining('No requirement subset was declared'),
    )
  })

  it('warns when the handoff scopes a requirement the specification does not define', () => {
    const { specification } = narrow({ scopeRequirementIds: ['REQ-2', 'REQ-GHOST'] })
    expect(specification!.requirements.map(r => r.id)).toEqual(['REQ-2'])
    expect(specification!.warnings).toContainEqual(expect.stringContaining('REQ-GHOST'))
  })

  it('warns when there is no content hash to prove the submission against', () => {
    const { specification } = narrow({ contentHash: null })
    expect(specification!.contentHash).toBeNull()
    expect(specification!.warnings).toContainEqual(expect.stringContaining('cannot prove which specification'))
  })

  it('degrades to no block when the stored package is malformed', () => {
    const { specification, warnings } = narrow({ packageBody: { requirements: 'not-an-array' } })
    expect(specification).toBeNull()
    expect(warnings).toContainEqual(expect.stringContaining('malformed'))
  })

  it('links criteria and obligations that only point back at the requirement', () => {
    // One direction of the link is enough — a spec that wired only `verifies` still exports
    // a complete slice.
    const { specification } = narrowSpecificationForExport({
      versionId: 'v1',
      version: 1,
      status: 'APPROVED',
      contentHash: 'sha256:x',
      packageBody: {
        requirements: [{ id: 'R1', statement: 'Do the thing.', priority: 'MUST' }],
        acceptanceCriteria: [{ id: 'AC-back', requirementIds: ['R1'], given: [], when: [], then: ['it happens'] }],
        testObligations: [{ id: 'TO-back', verifies: ['R1'], requiredEvidence: ['TEST'], minimumCases: [] }],
      },
      scopeRequirementIds: ['R1'],
      scopeSource: 'handoffGeneration',
    })
    expect(specification!.requirements[0].acceptanceCriterionIds).toEqual([])
    expect(specification!.acceptanceCriteria.map(c => c.id)).toEqual(['AC-back'])
    expect(specification!.testObligations.map(t => t.id)).toEqual(['TO-back'])
  })
})
