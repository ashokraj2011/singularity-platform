/**
 * Unit tests for the Studio Board Moments pure core (PR-2). DB-free / model-free —
 * exercises the deterministic detectors, the narration citation rule, JSON
 * extraction, and the 72h auto-confirm, which are the load-bearing quality
 * mechanism ("never let the LLM decide something happened").
 */
import { describe, it, expect } from 'vitest'
import {
  detectKills, detectBursts, detectStalls, detectConsensusFlips, detectPhases, detectIngestions, detectMoments,
  parseNarrative, extractJson, effectiveMomentStatus, MOMENT_AUTOCONFIRM_MS,
  type DetectorEvent,
} from '../src/modules/studio/board-moments'

let seq = 0
const ev = (eventType: string, over: Partial<DetectorEvent> = {}): DetectorEvent => ({
  eventSeq: over.eventSeq ?? ++seq, eventType, objectIds: over.objectIds ?? [], payload: over.payload ?? {},
  actorId: over.actorId ?? 'u1', createdAt: over.createdAt ?? 0,
})

describe('detectKills', () => {
  it('fires on OBJECT_DELETED and edit-kill', () => {
    const out = detectMomentsKills([
      ev('OBJECT_CREATED', { objectIds: ['a'] }),
      ev('OBJECT_DELETED', { objectIds: ['a'] }),
      ev('OBJECT_EDITED', { objectIds: ['b'], payload: { kind: 'kill' } }),
    ])
    expect(out).toHaveLength(2)
    expect(out.every((m) => m.kind === 'DECISION' && m.detectorKey === 'KILL')).toBe(true)
  })
  function detectMomentsKills(e: DetectorEvent[]) { return detectKills(e) }
})

describe('detectBursts', () => {
  it('fires when >= minCount creates land inside 5 min', () => {
    const base = 1_000_000
    const events = [0, 30, 60, 90, 120].map((s, i) => ev('OBJECT_CREATED', { objectIds: [`o${i}`], createdAt: base + s * 1000 }))
    const out = detectBursts(events, 5)
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('BURST')
    expect(out[0]!.signal.count).toBe(5)
  })
  it('does NOT fire when creates are spread past the window', () => {
    const events = [0, 200, 400, 600, 800].map((s, i) => ev('OBJECT_CREATED', { objectIds: [`o${i}`], createdAt: s * 1000 }))
    expect(detectBursts(events, 5)).toHaveLength(0)
  })
})

describe('detectStalls', () => {
  it('flags a gap far larger than the median', () => {
    // gaps: 1s,1s,1s, then a 100s gap
    const t = [0, 1, 2, 3, 103].map((s) => s * 1000)
    const events = t.map((createdAt, i) => ev('OBJECT_EDITED', { objectIds: ['a'], createdAt, eventSeq: i + 1 }))
    const out = detectStalls(events, 3)
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('STALL')
  })
  it('stays quiet on steady activity', () => {
    const events = [0, 1, 2, 3, 4].map((s, i) => ev('OBJECT_EDITED', { createdAt: s * 1000, eventSeq: i + 1 }))
    expect(detectStalls(events, 3)).toHaveLength(0)
  })
})

describe('detectConsensusFlips', () => {
  it('fires when the leader changes after >= 3 votes', () => {
    const votes = [
      ev('VOTE_CAST', { payload: { target: 'A' } }),
      ev('VOTE_CAST', { payload: { target: 'A' } }),
      ev('VOTE_CAST', { payload: { target: 'B' } }),
      ev('VOTE_CAST', { payload: { target: 'B' } }),
      ev('VOTE_CAST', { payload: { target: 'B' } }),
    ]
    const out = detectConsensusFlips(votes)
    expect(out).toHaveLength(1)
    expect(out[0]!.signal).toMatchObject({ from: 'A', to: 'B' })
  })
  it('does not fire before 3 votes', () => {
    const votes = [ev('VOTE_CAST', { payload: { target: 'A' } }), ev('VOTE_CAST', { payload: { target: 'B' } })]
    expect(detectConsensusFlips(votes)).toHaveLength(0)
  })
})

describe('detectPhases + detectIngestions', () => {
  it('picks up ritual boundaries and completed ingestions', () => {
    expect(detectPhases([ev('RITUAL_PHASE_STARTED', { payload: { phase: 'divergence' } })])).toHaveLength(1)
    const ing = detectIngestions([ev('INGESTION_COMPLETED', { payload: { artifactId: 'art1' } })])
    expect(ing[0]!.kind).toBe('SOURCE_ADDED')
  })
})

describe('detectMoments (aggregate)', () => {
  it('returns detections sorted by start seq', () => {
    const out = detectMoments([
      ev('OBJECT_DELETED', { objectIds: ['a'], eventSeq: 10 }),
      ev('RITUAL_PHASE_ENDED', { eventSeq: 2 }),
    ])
    expect(out.map((m) => m.eventSeqStart)).toEqual([2, 10])
  })
})

describe('narration citation rule', () => {
  const good = {
    title: 'Vendor option killed',
    narrative: 'Smita killed the vendor region citing residency, two minutes after the licence-cost challenge.',
    causalChain: [{ assertion: 'Smita killed the vendor region', eventRefs: ['ev-4812'], claimRefs: ['claim-418'] }],
    confidence: 0.8,
  }
  it('accepts a fully-cited narrative', () => {
    const parsed = parseNarrative(good)
    expect(parsed.title).toBe('Vendor option killed')
    expect(parsed.causalChain[0]!.claimRefs).toEqual(['claim-418'])
  })
  it('REJECTS an assertion with no event refs (the whole point)', () => {
    const bad = { ...good, causalChain: [{ assertion: 'Vibes changed', eventRefs: [] as string[], claimRefs: [] }] }
    expect(() => parseNarrative(bad)).toThrow()
  })
  it('rejects an empty causal chain and out-of-range confidence', () => {
    expect(() => parseNarrative({ ...good, causalChain: [] })).toThrow()
    expect(() => parseNarrative({ ...good, confidence: 1.5 })).toThrow()
  })
})

describe('extractJson', () => {
  it('pulls JSON out of a fenced reply', () => {
    expect(extractJson('here you go:\n```json\n{"a":1}\n```\nthanks')).toEqual({ a: 1 })
  })
  it('pulls a bare JSON object', () => {
    expect(extractJson('prefix {"b":2} suffix')).toEqual({ b: 2 })
  })
  it('throws when there is no JSON', () => {
    expect(() => extractJson('no json here')).toThrow()
  })
})

describe('effectiveMomentStatus', () => {
  it('auto-confirms VISIBLE after 72h', () => {
    expect(effectiveMomentStatus('VISIBLE', 0, MOMENT_AUTOCONFIRM_MS)).toBe('CONFIRMED')
    expect(effectiveMomentStatus('VISIBLE', 0, MOMENT_AUTOCONFIRM_MS - 1)).toBe('VISIBLE')
  })
  it('leaves EDITED / REJECTED sticky', () => {
    expect(effectiveMomentStatus('EDITED', 0, MOMENT_AUTOCONFIRM_MS * 10)).toBe('EDITED')
    expect(effectiveMomentStatus('REJECTED', 0, MOMENT_AUTOCONFIRM_MS * 10)).toBe('REJECTED')
  })
})
