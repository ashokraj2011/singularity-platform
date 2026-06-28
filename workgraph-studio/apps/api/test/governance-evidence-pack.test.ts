import { describe, it, expect } from 'vitest'
import {
  verifyEvidencePack,
  buildEvidenceManifest,
  computeSha256,
} from '../src/modules/workflow/runtime/executors/governance/evidencePack'

describe('evidence pack (dual-persistence verify side)', () => {
  it('computeSha256 is stable, prefixed, and content-sensitive', () => {
    expect(computeSha256('abc')).toBe(computeSha256('abc'))
    expect(computeSha256('abc').startsWith('sha256:')).toBe(true)
    expect(computeSha256('abc')).not.toBe(computeSha256('abd'))
  })

  it('buildEvidenceManifest sorts items by key (deterministic)', () => {
    const m = buildEvidenceManifest([
      { key: 'b', path: 'b', gitSha256: 'x' },
      { key: 'a', path: 'a', gitSha256: 'y' },
    ])
    expect(m.items.map(i => i.key)).toEqual(['a', 'b'])
  })

  it('complete iff every required key is present', () => {
    const m = buildEvidenceManifest([{ key: 'design', path: 'd', gitSha256: 'h' }])
    expect(verifyEvidencePack(m, ['design']).complete).toBe(true)
    const v = verifyEvidencePack(m, ['design', 'tests'])
    expect(v.complete).toBe(false)
    expect(v.missing).toEqual(['tests'])
  })

  it('consistent iff every DB hash matches its git hash (tamper/drift detection)', () => {
    const ok = buildEvidenceManifest([{ key: 'a', path: 'a', gitSha256: 'h', dbSha256: 'h' }])
    expect(verifyEvidencePack(ok).consistent).toBe(true)
    const bad = buildEvidenceManifest([{ key: 'a', path: 'a', gitSha256: 'h', dbSha256: 'DIFFERENT' }])
    const v = verifyEvidencePack(bad)
    expect(v.consistent).toBe(false)
    expect(v.mismatched).toEqual(['a'])
  })

  it('items without a DB hash are not cross-checked', () => {
    const m = buildEvidenceManifest([{ key: 'a', path: 'a', gitSha256: 'h' }])
    expect(verifyEvidencePack(m).consistent).toBe(true)
  })

  it('null manifest: not complete when required, consistent when nothing to check', () => {
    expect(verifyEvidencePack(null, ['x']).complete).toBe(false)
    expect(verifyEvidencePack(null).consistent).toBe(true)
  })
})
