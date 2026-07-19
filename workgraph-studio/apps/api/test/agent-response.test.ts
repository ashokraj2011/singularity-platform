import { describe, expect, it } from 'vitest'
import { parseAgentTurn, responseContract } from '../src/modules/synthesis/agent-response'

/**
 * Synthesis Agents — response parsing. Agents PROPOSE via items; parsing is tolerant so a
 * non-JSON / malformed answer degrades to a plain, item-less message (never an accidental
 * mutation).
 */
describe('parseAgentTurn', () => {
  it('parses a fenced JSON turn with proposal items', () => {
    const raw = 'Sure.\n```json\n{"message":"Drafted the intro","proposalItems":[{"kind":"ADD_DOC_BLOCK","diff":{"documentId":"d1"}}],"citations":["s1"]}\n```'
    const p = parseAgentTurn(raw)
    expect(p.message).toBe('Drafted the intro')
    expect(p.proposalItems).toHaveLength(1)
    expect(p.proposalItems[0]?.kind).toBe('ADD_DOC_BLOCK')
    expect(p.citations).toEqual(['s1'])
  })
  it('parses a bare JSON object', () => {
    const p = parseAgentTurn('{"message":"hi","proposalItems":[]}')
    expect(p.message).toBe('hi')
    expect(p.proposalItems).toEqual([])
  })
  it('treats non-JSON output as a plain answer — never an accidental mutation', () => {
    const p = parseAgentTurn('Just answering your question, no changes.')
    expect(p.message).toBe('Just answering your question, no changes.')
    expect(p.proposalItems).toEqual([])
  })
  it('drops a turn with malformed items (falls back to an item-less answer)', () => {
    const p = parseAgentTurn('{"message":"x","proposalItems":[{"noKind":true}]}')
    expect(p.proposalItems).toEqual([])
  })
})

describe('responseContract', () => {
  it('names the allowed verbs and forbids claiming application', () => {
    const c = responseContract(['EDIT_DOC_BLOCK', 'ADD_DOC_BLOCK'])
    expect(c).toContain('EDIT_DOC_BLOCK')
    expect(c).toMatch(/never/i)
  })
})
