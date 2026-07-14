import { describe, it, expect } from 'vitest'
import { projectSpecPackageSchema, projectAnalysisSchema, projectDecisionSchema } from '../src/modules/studio/studio-spec.schemas'
import { patchProjectSpecSchema } from '../src/modules/studio/studio-projects.router'

describe('project spec package', () => {
  it('parses an empty package into fully-shaped defaults', () => {
    expect(projectSpecPackageSchema.parse({})).toEqual({
      analysis: { problem: '', goals: [], stakeholders: [], assumptions: [], constraints: [] },
      decisions: [],
    })
  })

  it('keeps provided analysis and drops nothing valid', () => {
    const parsed = projectAnalysisSchema.parse({ problem: 'Fails too often', goals: [{ text: 'Cut failure %', metric: 'fail<0.5%' }] })
    expect(parsed.problem).toBe('Fails too often')
    expect(parsed.goals[0]).toEqual({ text: 'Cut failure %', metric: 'fail<0.5%' })
    expect(parsed.stakeholders).toEqual([])
  })

  it('rejects a goal with empty text', () => {
    expect(projectAnalysisSchema.safeParse({ goals: [{ text: '' }] }).success).toBe(false)
  })

  it('defaults a decision status to PROPOSED', () => {
    expect(projectDecisionSchema.parse({ id: 'ADR-1', title: 'Dedup key store', decision: 'Shared ledger' }).status).toBe('PROPOSED')
  })
})

describe('patchProjectSpecSchema', () => {
  it('accepts a known section with an expectedRevision', () => {
    expect(patchProjectSpecSchema.safeParse({ section: 'analysis', value: {}, expectedRevision: 1 }).success).toBe(true)
    expect(patchProjectSpecSchema.safeParse({ section: 'decisions', value: [], expectedRevision: 3 }).success).toBe(true)
  })
  it('rejects an unknown section or a missing revision', () => {
    expect(patchProjectSpecSchema.safeParse({ section: 'requirements', value: {}, expectedRevision: 1 }).success).toBe(false)
    expect(patchProjectSpecSchema.safeParse({ section: 'analysis', value: {} }).success).toBe(false)
  })
})
