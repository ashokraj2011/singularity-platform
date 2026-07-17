import {
  INTAKE_STAGES,
  assertCitedSentences,
  attentionBand,
  attentionCanAcknowledge,
  attentionPriority,
  nextIntakeStage,
  stageReadback,
  validateArtifactPile,
} from '../src/modules/experience/experience-core'

describe('Master Design v2 experience core', () => {
  it('ranks attention by stakes x uncertainty x urgency and keeps blockers first', () => {
    expect(attentionPriority(5, 4, 3)).toBe(60)
    expect(attentionBand({ blocking: true, stakes: 1, priority: 1 })).toBe('BLOCKING')
    expect(attentionBand({ decision: true, stakes: 1, priority: 1 })).toBe('DECIDE')
    expect(attentionBand({ stakes: 4, priority: 16 })).toBe('REVIEW')
    expect(attentionBand({ stakes: 1, priority: 2 })).toBe('DIGEST')
    expect(attentionCanAcknowledge('BLOCKING')).toBe(false)
    expect(attentionCanAcknowledge('DECIDE')).toBe(false)
    expect(attentionCanAcknowledge('REVIEW')).toBe(true)
    expect(attentionCanAcknowledge('DIGEST')).toBe(true)
  })

  it('runs the intake protocol in the declared order and gives a confidence readback', () => {
    expect(INTAKE_STAGES).toEqual(['PROBLEM', 'BELIEFS', 'SUCCESS', 'CONSTRAINTS', 'CONTEXT'])
    expect(nextIntakeStage('PROBLEM')).toBe('BELIEFS')
    expect(nextIntakeStage('CONTEXT')).toBeNull()
    expect(stageReadback('SUCCESS', 'Reduce settlement time to two days.', 0.8)).toContain('speaker confidence 80%')
  })

  it('keeps imported evidence at SOURCE_DOCUMENT and surfaces opposing claims as an open tension', () => {
    const result = validateArtifactPile([
      {
        id: 'a', filename: 'policy.md', kind: 'MARKDOWN', status: 'COMPLETED', contentHash: 'a',
        sourceSpans: [{ ref: 'sec:0', text: 'The service must retain audit records for seven years.' }],
        extractedClaims: [{ id: 'c1', kind: 'COMMITMENT', statement: 'The service must retain audit records for seven years', sourceRef: { artifactId: 'a', spanRef: 'sec:0' }, tier: 'SOURCE_DOCUMENT' }],
      },
      {
        id: 'b', filename: 'design.md', kind: 'MARKDOWN', status: 'COMPLETED', contentHash: 'b',
        sourceSpans: [{ ref: 'sec:0', text: 'The service must not retain audit records for seven years.' }],
        extractedClaims: [{ id: 'c2', kind: 'COMMITMENT', statement: 'The service must not retain audit records for seven years', sourceRef: { artifactId: 'b', spanRef: 'sec:0' }, tier: 'SOURCE_DOCUMENT' }],
      },
    ])
    expect(result.tensions).toHaveLength(1)
    expect(result.tensions[0]?.status).toBe('OPEN')
    expect(result.tensions[0]?.left.citationRef).toBe('a#sec:0')
    expect(result.tensions[0]?.right.citationRef).toBe('b#sec:0')
  })

  it('rejects uncited generated narratives', () => {
    expect(() => assertCitedSentences([{ text: 'Something moved.', citationRefs: [] }])).toThrow(/cite/i)
    expect(() => assertCitedSentences([{ text: 'Something moved.', citationRefs: ['event:1'] }])).not.toThrow()
  })
})
