import { describe, expect, it } from 'vitest'
import {
  capabilityImpactTask,
  parseCapabilityImpactResult,
} from '../src/modules/studio/studio-impact-assessment'

describe('capability impact assessment contract', () => {
  it('extracts and validates a structured result from an agent response', () => {
    const result = parseCapabilityImpactResult(`Result follows:\n${JSON.stringify({
      summary: 'Billing must add idempotent settlement events.',
      recommendations: ['Version the settlement event schema.'],
      risks: [{ title: 'Duplicate charge', severity: 'HIGH', mitigation: 'Use an idempotency key.' }],
      dependencies: ['Identity capability must expose account ownership.'],
      suggestedClaims: [{
        statement: 'Ninety percent of payment retries are safe to automate.',
        claimType: 'OPERATIONAL',
        confidence: 0.55,
        rationale: 'The current sample is small.',
      }],
    })}`)
    expect(result.risks[0].severity).toBe('HIGH')
    expect(result.suggestedClaims[0].confidence).toBe(0.55)
  })

  it('rejects invalid risk and claim values rather than persisting loose JSON', () => {
    expect(() => parseCapabilityImpactResult(JSON.stringify({
      summary: 'Impact',
      recommendations: [],
      risks: [{ title: 'Bad', severity: 'UNKNOWN', mitigation: 'None' }],
      dependencies: [],
      suggestedClaims: [],
    }))).toThrow()
  })

  it('includes portfolio evidence and the reviewing capability in the task', () => {
    const task = JSON.parse(capabilityImpactTask({
      name: 'Unified billing',
      mission: 'Reduce failed payments',
      primaryCapabilityName: 'Commerce',
      capabilityName: 'Identity',
      businessValue: 5,
      deliveryRisk: 4,
      targetDate: new Date('2026-12-31T00:00:00.000Z'),
      successMetrics: ['Cut failures by 20%'],
    }))
    expect(task.initiative.reviewingCapability).toBe('Identity')
    expect(task.initiative.scores.businessValue).toBe(5)
    expect(task.initiative.successMetrics).toEqual(['Cut failures by 20%'])
  })
})
