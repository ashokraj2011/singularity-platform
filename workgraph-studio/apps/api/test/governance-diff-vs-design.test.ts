import { describe, it, expect } from 'vitest'
import { evaluateDiffVsDesign } from '../src/modules/workflow/runtime/executors/governance/diffVsDesign'

describe('evaluateDiffVsDesign', () => {
  it('flags a missing diffValidation contract', () => {
    expect(evaluateDiffVsDesign({ pathsTouched: ['a.ts'] }, null).map(v => v.kind)).toEqual(['missing-contract'])
  })

  it('flags an empty diff', () => {
    expect(evaluateDiffVsDesign({ pathsTouched: [] }, {}).map(v => v.kind)).toEqual(['no-diff'])
  })

  it('flags a forbidden path', () => {
    const v = evaluateDiffVsDesign({ pathsTouched: ['src/app.ts', 'infra/prod.tf'] }, { forbiddenPaths: ['infra/*'] })
    expect(v.map(x => x.kind)).toContain('forbidden-path')
  })

  it('flags a missing required path pattern', () => {
    const v = evaluateDiffVsDesign({ pathsTouched: ['src/app.ts'] }, { requiredPathPatterns: ['docs/*'] })
    expect(v.map(x => x.kind)).toEqual(['missing-required-path'])
  })

  it('flags missing tests when required', () => {
    const v = evaluateDiffVsDesign({ pathsTouched: ['src/app.ts'] }, { requireTests: true })
    expect(v.map(x => x.kind)).toEqual(['missing-tests'])
  })

  it('passes when tests present and no forbidden/required violations', () => {
    const v = evaluateDiffVsDesign({ pathsTouched: ['src/app.ts', 'src/app.test.ts'] }, { requireTests: true, forbiddenPaths: ['infra/*'] })
    expect(v).toEqual([])
  })

  it('passes a satisfied required pattern', () => {
    const v = evaluateDiffVsDesign({ pathsTouched: ['docs/design.md', 'src/x.ts'] }, { requiredPathPatterns: ['docs/*'] })
    expect(v).toEqual([])
  })
})
