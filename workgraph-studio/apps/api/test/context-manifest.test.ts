import { describe, expect, it } from 'vitest'
import {
  hashManifest, summarizeManifest, estimateTokensFor, BASE_TOKENS_PER_REF,
  type ResolvedRefSnapshot,
} from '../src/modules/synthesis/context-manifest'

/**
 * Synthesis 1.3 — context manifest pure core. The manifest hash is the immutable per-run
 * anchor, so it must be stable + order-independent; PINNED refs without a resolvable
 * versionId+contentHash must be flagged ("cannot pin").
 */
const ref = (over: Partial<ResolvedRefSnapshot> = {}): ResolvedRefSnapshot => ({
  entityType: 'CLAIM', entityId: 'c1', referenceMode: 'FOLLOW_LATEST', exists: true, pinnable: false, ...over,
})

describe('hashManifest', () => {
  it('is stable and order-independent for the same set of refs', () => {
    const a = [ref({ entityId: 'a' }), ref({ entityId: 'b' })]
    const b = [ref({ entityId: 'b' }), ref({ entityId: 'a' })]
    expect(hashManifest(a)).toBe(hashManifest(b))
    expect(hashManifest(a)).toMatch(/^[0-9a-f]{64}$/)
  })
  it('changes when a ref mode, version, or the membership changes', () => {
    const base = [ref({ entityId: 'a', versionId: '1' })]
    expect(hashManifest(base)).not.toBe(hashManifest([ref({ entityId: 'a', versionId: '2' })]))
    expect(hashManifest(base)).not.toBe(hashManifest([ref({ entityId: 'a', versionId: '1', referenceMode: 'PINNED' })]))
    expect(hashManifest(base)).not.toBe(hashManifest([ref({ entityId: 'a', versionId: '1' }), ref({ entityId: 'z' })]))
  })
})

describe('summarizeManifest', () => {
  it('counts pinned/following and flags PINNED refs that cannot be pinned', () => {
    const s = summarizeManifest([
      ref({ referenceMode: 'PINNED', pinnable: true, versionId: '3', contentHash: 'h' }),
      ref({ referenceMode: 'PINNED', pinnable: false }), // pinned but no versionId+hash
      ref({ referenceMode: 'FOLLOW_LATEST' }),
    ])
    expect(s.pinnedCount).toBe(2)
    expect(s.followingCount).toBe(1)
    expect(s.cannotPinCount).toBe(1)
  })
  it('counts unresolved refs and rolls up classification', () => {
    const s = summarizeManifest([
      ref({ exists: false }),
      ref({ classification: 'internal' }),
      ref({ classification: 'internal' }),
    ])
    expect(s.unresolvedCount).toBe(1)
    expect(s.classificationSummary).toMatchObject({ internal: 2, unclassified: 1 })
  })
  it('estimates tokens from label length + a base cost per ref', () => {
    expect(estimateTokensFor(ref({ label: undefined }))).toBe(BASE_TOKENS_PER_REF)
    expect(estimateTokensFor(ref({ label: 'x'.repeat(40) }))).toBe(BASE_TOKENS_PER_REF + 10)
    expect(summarizeManifest([ref({ label: 'abcd' }), ref({ label: 'abcd' })]).tokenEstimate).toBe((BASE_TOKENS_PER_REF + 1) * 2)
  })
})
