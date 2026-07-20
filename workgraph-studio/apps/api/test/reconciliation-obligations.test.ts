import { describe, it, expect } from 'vitest'
import {
  evaluateObligations,
  type ObligationContext,
  type SymbolFactSource,
} from '../src/modules/reconciliations/reconciliation.obligations'
import { reconcile, type ReconciliationInput } from '../src/modules/reconciliations/reconciliation.engine'
import { applySemanticJudgments } from '../src/modules/reconciliations/reconciliation.semantic'
import type { RequirementObligation, SpecificationContract } from '../src/modules/specifications/specification.schemas'

const ctx = (over: Partial<ObligationContext> = {}): ObligationContext => ({
  contracts: [],
  changedFiles: [],
  symbolFacts: null,
  ...over,
})

const inventory = (over: Partial<SymbolFactSource> = {}): SymbolFactSource => ({
  provenance: 'MANIFEST',
  coveredPaths: ['src/tenant-scope.ts'],
  symbols: [{ path: 'src/tenant-scope.ts', symbol: 'resolveTenantScope', symbolKind: 'function' }],
  ...over,
})

const symbolObligation = (over: Record<string, unknown> = {}): RequirementObligation => ({
  id: 'OBL-1', kind: 'SYMBOL', path: 'src/tenant-scope.ts', symbol: 'resolveTenantScope', ...over,
} as RequirementObligation)

const contractObligation = (over: Record<string, unknown> = {}): RequirementObligation => ({
  id: 'OBL-1', kind: 'CONTRACT', contractId: 'C-1', ...over,
} as RequirementObligation)

const contract = (over: Record<string, unknown> = {}): SpecificationContract => ({
  id: 'C-1', kind: 'OPENAPI', ...over,
} as SpecificationContract)

const evalOne = (o: RequirementObligation, c: ObligationContext) =>
  evaluateObligations([{ id: 'REQ-1', obligations: [o] }], c)[0]

describe('evaluateObligations — SYMBOL', () => {
  it('PASSES when the inventory covers the path and holds the symbol', () => {
    const r = evalOne(symbolObligation(), ctx({ symbolFacts: inventory() }))
    expect(r.status).toBe('PASS')
    expect(r.provenance).toBe('MANIFEST')
  })

  it('matches the symbol kind when one is asserted', () => {
    expect(evalOne(symbolObligation({ symbolKind: 'function' }), ctx({ symbolFacts: inventory() })).status).toBe('PASS')
  })

  it('FAILS on a kind mismatch — the facts were available and they disagreed', () => {
    const r = evalOne(symbolObligation({ symbolKind: 'class' }), ctx({ symbolFacts: inventory() }))
    expect(r.status).toBe('FAIL')
    expect(r.detail).toContain('not a class')
  })

  it('FAILS when a covered file is indexed but does not declare the symbol', () => {
    const r = evalOne(symbolObligation({ symbol: 'nonExistent' }), ctx({ symbolFacts: inventory() }))
    expect(r.status).toBe('FAIL')
  })

  // ── unevaluatable ⇒ NOT_VERIFIED, never PASS and never FAIL ──────────────
  it('is NOT_VERIFIED when no symbol inventory is available at all', () => {
    const r = evalOne(symbolObligation(), ctx())
    expect(r.status).toBe('NOT_VERIFIED')
    expect(r.detail).toContain('No symbol inventory')
  })

  it('is NOT_VERIFIED when the inventory does not cover the asserted path', () => {
    const r = evalOne(symbolObligation({ path: 'src/elsewhere.ts', symbol: 'whatever' }), ctx({ symbolFacts: inventory() }))
    expect(r.status).toBe('NOT_VERIFIED')
    expect(r.detail).toContain('does not cover')
  })

  it('is NOT_VERIFIED when a kind is asserted but the inventory records none', () => {
    const noKind = inventory({ symbols: [{ path: 'src/tenant-scope.ts', symbol: 'resolveTenantScope' }] })
    expect(evalOne(symbolObligation({ symbolKind: 'function' }), ctx({ symbolFacts: noKind })).status).toBe('NOT_VERIFIED')
  })

  it('normalizes ./ and leading-slash path spellings on both sides', () => {
    const src = inventory({ coveredPaths: ['./src/tenant-scope.ts'], symbols: [{ path: '/src/tenant-scope.ts', symbol: 'resolveTenantScope' }] })
    expect(evalOne(symbolObligation(), ctx({ symbolFacts: src })).status).toBe('PASS')
  })
})

describe('evaluateObligations — CONTRACT', () => {
  const openapi = JSON.stringify({ openapi: '3.0.0', paths: { '/tenants': { get: {}, post: {} } } })

  it('PASSES when every declared operation is present in the contract', () => {
    const r = evalOne(contractObligation({ operations: ['GET /tenants', 'POST /tenants'] }), ctx({ contracts: [contract({ content: openapi })] }))
    expect(r.status).toBe('PASS')
  })

  it('parses YAML contract content as well as JSON', () => {
    const yaml = 'openapi: 3.0.0\npaths:\n  /tenants:\n    get: {}\n'
    expect(evalOne(contractObligation({ operations: ['GET /tenants'] }), ctx({ contracts: [contract({ content: yaml })] })).status).toBe('PASS')
  })

  it('FAILS when the contract does not declare an asserted operation', () => {
    const r = evalOne(contractObligation({ operations: ['DELETE /tenants'] }), ctx({ contracts: [contract({ content: openapi })] }))
    expect(r.status).toBe('FAIL')
    expect(r.detail).toContain('DELETE /tenants')
  })

  it('checks JSON_SCHEMA fields', () => {
    const schema = JSON.stringify({ type: 'object', properties: { tenantId: { type: 'string' } } })
    const c = ctx({ contracts: [contract({ kind: 'JSON_SCHEMA', content: schema })] })
    expect(evalOne(contractObligation({ fields: ['tenantId'] }), c).status).toBe('PASS')
    expect(evalOne(contractObligation({ fields: ['missingField'] }), c).status).toBe('FAIL')
  })

  it('FAILS when the contract artifact is absent from a non-empty change manifest', () => {
    const r = evalOne(contractObligation({ path: 'openapi.yaml' }), ctx({ contracts: [contract()], changedFiles: ['src/other.ts'] }))
    expect(r.status).toBe('FAIL')
    expect(r.detail).toContain('not in the submission')
  })

  it('PASSES the delivery check when the artifact is in the manifest', () => {
    expect(evalOne(contractObligation({ path: 'openapi.yaml' }), ctx({ contracts: [contract()], changedFiles: ['openapi.yaml'] })).status).toBe('PASS')
  })

  // ── unevaluatable ⇒ NOT_VERIFIED ─────────────────────────────────────────
  it('is NOT_VERIFIED when the referenced contract is not declared by the package', () => {
    const r = evalOne(contractObligation({ contractId: 'NOPE', operations: ['GET /x'] }), ctx({ contracts: [contract()] }))
    expect(r.status).toBe('NOT_VERIFIED')
    expect(r.detail).toContain('does not declare')
  })

  it('is NOT_VERIFIED when the contract carries no content to check', () => {
    expect(evalOne(contractObligation({ operations: ['GET /tenants'] }), ctx({ contracts: [contract()] })).status).toBe('NOT_VERIFIED')
  })

  it('is NOT_VERIFIED when the contract content does not parse', () => {
    const r = evalOne(contractObligation({ operations: ['GET /x'] }), ctx({ contracts: [contract({ content: '{ this is not: valid json or yaml ][' })] }))
    expect(r.status).toBe('NOT_VERIFIED')
  })

  it('is NOT_VERIFIED for a contract kind we have no parser for', () => {
    const r = evalOne(contractObligation({ operations: ['GET /x'] }), ctx({ contracts: [contract({ kind: 'PROTOBUF', content: 'message X {}' })] }))
    expect(r.status).toBe('NOT_VERIFIED')
    expect(r.detail).toContain('no parser')
  })

  it('is NOT_VERIFIED for a JSON_SCHEMA that is not a structurally valid schema', () => {
    const bad = JSON.stringify({ type: 'not-a-real-type', properties: { a: {} } })
    expect(evalOne(contractObligation({ fields: ['a'] }), ctx({ contracts: [contract({ kind: 'JSON_SCHEMA', content: bad })] })).status).toBe('NOT_VERIFIED')
  })

  it('is NOT_VERIFIED for the delivery check when there is no change manifest', () => {
    expect(evalOne(contractObligation({ path: 'openapi.yaml' }), ctx({ contracts: [contract()], changedFiles: [] })).status).toBe('NOT_VERIFIED')
  })

  it('lets an observed FAIL outrank an unevaluatable half of the same obligation', () => {
    // Content unparseable (NOT_VERIFIED) but the artifact is demonstrably missing (FAIL).
    const r = evalOne(
      contractObligation({ operations: ['GET /x'], path: 'openapi.yaml' }),
      ctx({ contracts: [contract({ content: 'not:parseable: [' })], changedFiles: ['src/other.ts'] }),
    )
    expect(r.status).toBe('FAIL')
  })
})

describe('evaluateObligations — requirements that declare none', () => {
  it('produces no results', () => {
    expect(evaluateObligations([{ id: 'REQ-1' }, { id: 'REQ-2', obligations: [] }], ctx())).toEqual([])
  })
})

// ── Engine integration ──────────────────────────────────────────────────────

const base = (over: Partial<ReconciliationInput> = {}): ReconciliationInput => ({
  requirements: [{ id: 'REQ-1', priority: 'MUST', testObligationIds: [] }],
  scopeRequirementIds: ['REQ-1'],
  requiredEvidence: [],
  diffValidation: {},
  claims: [{ requirementId: 'REQ-1', status: 'IMPLEMENTED', evidence: [{ kind: 'FILE', ref: 'src/a.ts' }] }],
  deviations: [],
  changedFiles: ['src/a.ts'],
  ...over,
})

const result = (status: 'PASS' | 'FAIL' | 'NOT_VERIFIED') => ([{
  requirementId: 'REQ-1', obligationId: 'OBL-1', kind: 'SYMBOL' as const, status, detail: 'detail',
}])

describe('reconcile — obligation results in the verdict matrix', () => {
  it('is byte-identical to today for a specification that declares no obligations', () => {
    const withoutField = reconcile(base())
    const withEmpty = reconcile(base({ obligationResults: [] }))
    expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(withoutField))
    expect(withoutField.summary.obligations).toBeUndefined()
    expect(withoutField.verdicts[0].verdict).toBe('PASS')
    expect(withoutField.findings).toEqual([])
  })

  it('keeps a PASS when every obligation passes, and counts them', () => {
    const r = reconcile(base({ obligationResults: result('PASS') }))
    expect(r.verdicts[0].verdict).toBe('PASS')
    expect(r.status).toBe('PASSED')
    expect(r.summary.obligations).toEqual({ total: 1, pass: 1, fail: 0, notVerified: 0 })
  })

  it('FAILS the requirement on a failed obligation and records an ERROR finding', () => {
    const r = reconcile(base({ obligationResults: result('FAIL') }))
    expect(r.verdicts[0].verdict).toBe('FAIL')
    expect(r.status).toBe('FAILED') // MUST requirement
    expect(r.findings.some((f) => f.kind === 'obligation-failed' && f.severity === 'ERROR')).toBe(true)
  })

  it('reads an unsatisfiable obligation as NOT_VERIFIED rather than FAIL — it caps at PARTIAL', () => {
    const r = reconcile(base({ obligationResults: result('NOT_VERIFIED') }))
    expect(r.verdicts[0].verdict).toBe('PARTIAL')
    expect(r.verdicts[0].verdict).not.toBe('FAIL')
    expect(r.status).toBe('PARTIAL')
    expect(r.findings.some((f) => f.kind === 'obligation-not-verified' && f.severity === 'WARNING')).toBe(true)
    expect(r.summary.obligations).toEqual({ total: 1, pass: 0, fail: 0, notVerified: 1 })
  })

  it('never lets an unevaluatable obligation read as PASS', () => {
    expect(reconcile(base({ obligationResults: result('NOT_VERIFIED') })).verdicts[0].verdict).not.toBe('PASS')
  })

  it('lets a failed obligation outrank a self-declared PARTIAL claim', () => {
    const r = reconcile(base({
      claims: [{ requirementId: 'REQ-1', status: 'PARTIAL', evidence: [] }],
      obligationResults: result('FAIL'),
    }))
    expect(r.verdicts[0].verdict).toBe('FAIL')
  })

  it('does not evaluate obligations for a requirement the implementer marked NOT_APPLICABLE', () => {
    const r = reconcile(base({
      claims: [{ requirementId: 'REQ-1', status: 'NOT_APPLICABLE', evidence: [] }],
      obligationResults: result('FAIL'),
    }))
    expect(r.verdicts[0].verdict).toBe('NOT_APPLICABLE')
  })
})

describe('semantic overlay keeps its discipline over obligation-driven verdicts', () => {
  it('cannot overturn a structural FAIL caused by a failed obligation', () => {
    const structural = reconcile(base({ obligationResults: result('FAIL') }))
    const overlaid = applySemanticJudgments(
      structural.verdicts.map((v) => ({ ...v, verdict: v.verdict as string })),
      [{ requirementId: 'REQ-1', judgment: 'SATISFIED', rationale: 'the model likes it' }],
    )
    expect(overlaid.verdicts[0].verdict).toBe('FAIL')
    expect(overlaid.status).toBe('FAILED')
  })
})
