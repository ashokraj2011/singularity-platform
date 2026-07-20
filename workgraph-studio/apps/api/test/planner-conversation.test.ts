/**
 * Planner ← conversation memory.
 *
 * WHAT CHANGED. The planner used to flatten its entire chat transcript into the
 * task string on every turn — uncapped — and then re-send that whole string a
 * second time on a parse-failure retry. It now sends only the user's latest
 * message and lets context-fabric supply the prior turns.
 *
 * Two properties are being pinned here, and the second is the subtle one:
 *
 *   1. The task is the user's words and nothing else. `transcript()` is gone.
 *
 *   2. Standing context (capabilities, repo grounding, documents, goal, current
 *      roadmap) moved OUT of the task and INTO the system prompt. That is not
 *      cosmetic: CF persists the task verbatim as the user's conversation turn
 *      and does not persist system prompts. Leaving the blob in the task would
 *      write a stale roadmap JSON into the conversation and replay it to the
 *      model next turn as though the user had typed it.
 *
 * Wire-shape invariants use the source-inspection style already established in
 * context-fabric-service-auth.contract.test.ts — `converse()` needs a live CF
 * and a DB, so its call shape is asserted against the source rather than by
 * standing up both.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  converseContext,
  latestUserMessage,
  type AssignableCapability,
  type Milestone,
} from '../src/modules/planner/planner.service'

function plannerSource(): string {
  return readFileSync(
    path.resolve(__dirname, '..', 'src/modules/planner/planner.service.ts'),
    'utf8',
  )
}

const CAPS: AssignableCapability[] = [
  { id: 'cap-home', name: 'Payments' },
  { id: 'cap-child', name: 'Ledger' },
]

const PLAN: Milestone[] = [
  {
    id: 'M1',
    title: 'Foundation',
    summary: '',
    tasks: [{
      title: 'Add the ledger table',
      description: 'Create it with an index on account id',
      category: 'DATABASE',
      capabilityId: 'cap-child',
      priority: 'HIGH',
      effortDays: 2,
      aiSuggested: false,
    }],
  },
]

describe('latestUserMessage', () => {
  it('returns the last thing the user actually said', () => {
    expect(latestUserMessage([
      { role: 'user', content: 'build me a payments system' },
      { role: 'assistant', content: 'here is a roadmap' },
      { role: 'user', content: 'split milestone 2' },
    ])).toBe('split milestone 2')
  })

  it('ignores assistant turns even when they are last', () => {
    expect(latestUserMessage([
      { role: 'user', content: 'the real question' },
      { role: 'assistant', content: 'a long answer' },
    ])).toBe('the real question')
  })

  it('skips blank user turns rather than returning empty', () => {
    expect(latestUserMessage([
      { role: 'user', content: 'the real question' },
      { role: 'user', content: '   ' },
    ])).toBe('the real question')
  })

  it('returns empty for an empty or assistant-only transcript', () => {
    expect(latestUserMessage([])).toBe('')
    expect(latestUserMessage([{ role: 'assistant', content: 'hello' }])).toBe('')
  })

  it('does NOT concatenate the transcript — that is the whole point', () => {
    const out = latestUserMessage([
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'second message' },
    ])
    expect(out).toBe('second message')
    expect(out).not.toContain('first message')
    expect(out).not.toContain('first reply')
  })
})

describe('converseContext', () => {
  it('carries the standing context the model needs every turn', () => {
    const out = converseContext('build me a payments system', PLAN, CAPS, 'cap-home')
    expect(out).toContain('cap-home')
    expect(out).toContain('Payments')
    expect(out).toContain('HOME capability id: cap-home')
    expect(out).toContain('GOAL')
    expect(out).toContain('build me a payments system')
    expect(out).toContain('Add the ledger table')
  })

  it('says so explicitly when there is no roadmap yet', () => {
    expect(converseContext('a goal', [], CAPS, 'cap-home')).toContain('(none yet)')
  })

  it('omits the GOAL block when there is no goal', () => {
    expect(converseContext('   ', [], CAPS, 'cap-home')).not.toContain('GOAL (')
  })

  it('includes attached documents as authoritative context', () => {
    const out = converseContext('a goal', [], CAPS, 'cap-home', [
      { title: 'PRD', content: 'the product must support refunds' },
    ])
    expect(out).toContain('PRD')
    expect(out).toContain('refunds')
  })

  it('contains no conversation block — history is CF\'s job now', () => {
    const out = converseContext('a goal', PLAN, CAPS, 'cap-home')
    expect(out).not.toContain('CONVERSATION:')
  })
})

describe('planner → context-fabric wire shape', () => {
  it('deleted transcript(), the uncapped transcript flattener', () => {
    const src = plannerSource()
    expect(src).not.toContain('function transcript(')
    expect(src).not.toContain('transcript(messages)')
  })

  it('sends only the latest user message as the task', () => {
    expect(plannerSource()).toContain('task: latestUserMessage(input.messages)')
  })

  it('puts standing context in the system prompt, where CF will not persist it', () => {
    const src = plannerSource()
    expect(src).toContain('converseContext(goal, currentPlan, caps, home, input.documents)')
    // The standing context must be composed into system_prompt, never the task.
    expect(src).toMatch(/system_prompt: \[plannerSystemPrompt\(maxItems\), converseContext\(/)
  })

  it('passes planner_session_id so the turn resolves to a conversation', () => {
    // Without this CF's planner rule finds no scope id and deliberately returns
    // "no conversation" rather than pooling every planner chat under one key.
    expect(plannerSource()).toContain('planner_session_id: sessionId')
  })

  it('keeps the critic OUT of the planner conversation', () => {
    const src = plannerSource()
    // The critic's own prompt claims independence ("You did NOT create it").
    // That is only true if it cannot see the chat that produced the plan.
    expect(src).toContain('const criticRunCtx =')
    expect(src).not.toMatch(/criticRunCtx[\s\S]{0,200}planner_session_id/)
    expect(src).toContain('run_context: criticRunCtx')
  })

  it('shrinks the parse-failure retry to the correction alone', () => {
    const src = plannerSource()
    expect(src).toContain('task: `Your previous answer FAILED validation: ${parsed.error}')
    // The old retry re-sent the entire turn a second time.
    expect(src).not.toMatch(/task: converseTask\([\s\S]{0,120}FAILED validation/)
  })
})

describe('compose declares the planner surface', () => {
  it('lists planner in CF_CONVERSATION_SURFACES', () => {
    // Load-bearing: the planner no longer carries its own history, so dropping
    // it from the allowlist makes it stateless rather than reverting it.
    const compose = readFileSync(
      path.resolve(__dirname, '..', '..', '..', '..', 'docker-compose.yml'),
      'utf8',
    )
    // The assignment, not the comment block that explains it.
    const line = compose
      .split('\n')
      .find((l) => l.trim().startsWith('CF_CONVERSATION_SURFACES:'))
    expect(line).toBeDefined()
    expect(line).toContain('planner')
  })
})
