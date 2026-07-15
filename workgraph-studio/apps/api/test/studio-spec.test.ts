import { describe, it, expect } from 'vitest'
import { projectSpecPackageSchema, projectAnalysisSchema, projectDecisionSchema, projectRequirementSchema } from '../src/modules/studio/studio-spec.schemas'
import { patchProjectSpecSchema } from '../src/modules/studio/studio-projects.router'
import { summaryCounts } from '../src/modules/studio/studio-recon.service'

describe('project spec package', () => {
  it('parses an empty package into fully-shaped defaults', () => {
    expect(projectSpecPackageSchema.parse({})).toEqual({
      analysis: { problem: '', goals: [], stakeholders: [], assumptions: [], constraints: [] },
      requirements: [],
      decisions: [],
    })
  })

  it('defaults a requirement priority to SHOULD and acceptanceCriteria to []', () => {
    const r = projectRequirementSchema.parse({ id: 'REQ-1', statement: 'Refunds settle in 3 days' })
    expect(r.priority).toBe('SHOULD')
    expect(r.acceptanceCriteria).toEqual([])
    expect(projectRequirementSchema.safeParse({ id: 'REQ-2', statement: '' }).success).toBe(false)
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
    expect(patchProjectSpecSchema.safeParse({ section: 'requirements', value: [], expectedRevision: 2 }).success).toBe(true)
    expect(patchProjectSpecSchema.safeParse({ section: 'decisions', value: [], expectedRevision: 3 }).success).toBe(true)
  })
  it('rejects an unknown section or a missing revision', () => {
    expect(patchProjectSpecSchema.safeParse({ section: 'summary', value: {}, expectedRevision: 1 }).success).toBe(false)
    expect(patchProjectSpecSchema.safeParse({ section: 'analysis', value: {} }).success).toBe(false)
  })
})

describe('summaryCounts', () => {
  it('extracts pass/partial/fail, defaulting non-numbers to 0', () => {
    expect(summaryCounts({ pass: 8, partial: 1, fail: 0 })).toEqual({ pass: 8, partial: 1, fail: 0 })
    expect(summaryCounts({ pass: 3 })).toEqual({ pass: 3, partial: 0, fail: 0 })
    expect(summaryCounts(null)).toEqual({ pass: 0, partial: 0, fail: 0 })
    expect(summaryCounts({ pass: 'x' })).toEqual({ pass: 0, partial: 0, fail: 0 })
  })
})
