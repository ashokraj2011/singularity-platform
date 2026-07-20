import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  specificationPackageBodySchema,
  specificationRequirementSchema,
  requirementObligationSchema,
} from '../src/modules/specifications/specification.schemas'
import { specificationContentHash } from '../src/modules/specifications/specification.hash'
import { validateSpecificationBody } from '../src/modules/specifications/specification.validator'

// Fixture text is pinned to match the body the pre-change digests below were captured from — do not
// reword it without re-capturing those digests against the schema as it stood before `obligations`.
const STATEMENT = 'The system must do a thing.'

const body = (over: Record<string, unknown> = {}) => specificationPackageBodySchema.parse({
  summary: 'demo',
  requirements: [{ id: 'REQ-1', statement: STATEMENT, priority: 'MUST' }],
  contracts: [{ id: 'C-1', kind: 'OPENAPI' }],
  ...over,
})

describe('obligations are additive to the specification package', () => {
  it('does not appear on a requirement that declares none', () => {
    const parsed = body()
    // The key must be ABSENT, not present-and-empty: the content hash canonicalizes over the keys
    // that are present, so an injected `obligations: []` would re-hash every frozen version.
    expect('obligations' in parsed.requirements[0]).toBe(false)
    expect(Object.keys(parsed.requirements[0]).sort()).toEqual([
      'acceptanceCriterionIds', 'id', 'objectiveRefs', 'priority', 'risk',
      'sourceIds', 'statement', 'testObligationIds', 'type',
    ])
  })

  /**
   * HASH STABILITY — the property that makes this adoptable.
   *
   * These two digests were captured by running the hasher against the schema BEFORE `obligations`
   * existed. They are pinned literals on purpose: if a future edit gives `obligations` (or any other
   * new field) a zod default, the injected key changes the canonical form and these break loudly —
   * which is the signal that every APPROVED, frozen SpecificationVersion in the database just had
   * its content hash invalidated.
   */
  it('leaves the content hash of a package that declares no obligations byte-identical', () => {
    expect(specificationContentHash(specificationPackageBodySchema.parse({})))
      .toBe('sha256:cc6bb132cc6aad199c12cb280c2eaea76ff48ef5493e2d9c783bf03442a9e9c7')
    expect(specificationContentHash(body()))
      .toBe('sha256:3a1de5b791f1cdf134c896d7d212d0135106dba89246da623c8718cbc651ff9e')
  })

  it('demonstrates why the field is .optional() and not .default([]) — a default WOULD re-hash', () => {
    // The counterfactual, so the reasoning behind the schema choice is executable rather than a
    // comment. Same body, same hasher; the only difference is a defaulted vs an omitted key.
    const withDefault = specificationRequirementSchema
      .extend({ demoField: z.array(requirementObligationSchema).default([]) })
      .parse({ id: 'REQ-1', statement: STATEMENT, priority: 'MUST' })
    const withOptional = specificationRequirementSchema
      .extend({ demoField: z.array(requirementObligationSchema).optional() })
      .parse({ id: 'REQ-1', statement: STATEMENT, priority: 'MUST' })

    expect('demoField' in withDefault).toBe(true)   // default injects the key…
    expect('demoField' in withOptional).toBe(false) // …optional does not.

    // Substitute the requirement directly rather than re-parsing the package: the package schema
    // strips keys it does not know, which would erase the very difference under test.
    const hashOf = (r: unknown) => specificationContentHash({ ...body(), requirements: [r] } as never)
    expect(hashOf(withOptional)).toBe(specificationContentHash(body()))
    expect(hashOf(withDefault)).not.toBe(specificationContentHash(body()))
  })

  it('changes the hash only for a package that actually uses obligations', () => {
    const withObligations = body({
      requirements: [{
        id: 'REQ-1',
        statement: 'The system must scope reads by tenant.',
        priority: 'MUST',
        obligations: [{ id: 'OBL-1', kind: 'SYMBOL', path: 'src/tenant-scope.ts', symbol: 'resolveTenantScope' }],
      }],
    })
    expect(specificationContentHash(withObligations)).not.toBe(specificationContentHash(body()))
  })

  it('round-trips both obligation kinds through the schema', () => {
    const parsed = body({
      requirements: [{
        id: 'REQ-1',
        statement: 'The system must scope reads by tenant.',
        priority: 'MUST',
        obligations: [
          { id: 'OBL-1', kind: 'SYMBOL', path: 'src/tenant-scope.ts', symbol: 'resolveTenantScope', symbolKind: 'function' },
          { id: 'OBL-2', kind: 'CONTRACT', contractId: 'C-1', path: 'openapi.yaml', operations: ['GET /tenants'] },
        ],
      }],
    })
    expect(parsed.requirements[0].obligations).toHaveLength(2)
    expect(parsed.requirements[0].obligations![0].kind).toBe('SYMBOL')
    expect(parsed.requirements[0].obligations![1].kind).toBe('CONTRACT')
  })

  it('rejects an unknown obligation kind rather than silently dropping it', () => {
    const r = specificationPackageBodySchema.safeParse({
      requirements: [{ id: 'REQ-1', statement: 'x', obligations: [{ id: 'OBL-1', kind: 'MADE_UP' }] }],
    })
    expect(r.success).toBe(false)
  })
})

describe('validateSpecificationBody — obligation checks', () => {
  it('emits no obligation checks at all for a specification that declares none', () => {
    const checks = validateSpecificationBody(body()).checks.map((c) => c.id)
    expect(checks.filter((id) => id.startsWith('obligation-'))).toEqual([])
  })

  it('flags an obligation referencing a contract the package does not declare', () => {
    const result = validateSpecificationBody(body({
      requirements: [{
        id: 'REQ-1', statement: 'x', priority: 'SHOULD',
        obligations: [{ id: 'OBL-1', kind: 'CONTRACT', contractId: 'MISSING' }],
      }],
    }))
    const check = result.checks.find((c) => c.id === 'obligation-contract-refs-valid')!
    expect(check.passed).toBe(false)
    expect(check.severity).toBe('error')
    expect(result.passed).toBe(false)
  })

  it('flags duplicate obligation ids', () => {
    const result = validateSpecificationBody(body({
      requirements: [{
        id: 'REQ-1', statement: 'x', priority: 'SHOULD',
        obligations: [
          { id: 'OBL-1', kind: 'CONTRACT', contractId: 'C-1' },
          { id: 'OBL-1', kind: 'SYMBOL', path: 'a.ts', symbol: 'b' },
        ],
      }],
    }))
    expect(result.checks.find((c) => c.id === 'obligation-ids-unique')!.passed).toBe(false)
  })

  it('passes a well-formed obligation set', () => {
    const result = validateSpecificationBody(body({
      requirements: [{
        id: 'REQ-1', statement: 'x', priority: 'SHOULD',
        obligations: [{ id: 'OBL-1', kind: 'CONTRACT', contractId: 'C-1' }],
      }],
    }))
    expect(result.checks.find((c) => c.id === 'obligation-contract-refs-valid')!.passed).toBe(true)
    expect(result.checks.find((c) => c.id === 'obligation-ids-unique')!.passed).toBe(true)
  })
})
