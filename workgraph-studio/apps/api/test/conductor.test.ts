import { describe, expect, it } from 'vitest'
import { classifyConductorTurn } from '../src/modules/synthesis/conductor.service'

describe('synthesis conductor routing', () => {
  it('routes questions to the facilitator without guessing a mutation', () => {
    expect(classifyConductorTurn('Why are enterprise users abandoning onboarding?')).toMatchObject({
      route: 'QUESTION', phase: 'QUESTION', agentRole: 'FACILITATOR',
    })
  })

  it('routes evidence language to the evidence curator', () => {
    expect(classifyConductorTurn('Compare the source documents and validate this claim.')).toMatchObject({
      route: 'EVIDENCE', phase: 'EVIDENCE', agentRole: 'EVIDENCE_CURATOR',
    })
  })

  it('routes specification language to the requirements editor', () => {
    expect(classifyConductorTurn('Turn this into acceptance criteria for the API.')).toMatchObject({
      route: 'SPECIFY', phase: 'SPECIFY', agentRole: 'REQUIREMENTS_EDITOR',
    })
  })

  it('routes delivery language to generation while keeping the governed editor', () => {
    expect(classifyConductorTurn('Break this into work items and generate the delivery plan.')).toMatchObject({
      route: 'GENERATE', phase: 'GENERATE', agentRole: 'REQUIREMENTS_EDITOR',
    })
  })

  it('defaults framing language to the facilitator', () => {
    expect(classifyConductorTurn('We need a calmer checkout experience for new customers.')).toMatchObject({
      route: 'CONVERSATION', phase: 'FRAME', agentRole: 'FACILITATOR',
    })
  })
})
