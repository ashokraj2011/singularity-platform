import { describe, expect, it } from 'vitest'
import { isItemStale, canDecideItem, settleProposalStatus, type ItemStatus } from '../src/modules/synthesis/proposal-contract'

/**
 * Synthesis Proposals — the pure contract core: the per-item content-hash stale fence, the
 * decide guard, and how a proposal settles from its items.
 */
describe('isItemStale — content-hash fence', () => {
  it('is never stale without a declared base hash', () => {
    expect(isItemStale(null, 'x')).toBe(false)
    expect(isItemStale(undefined, undefined)).toBe(false)
  })
  it('is fresh when the base hash matches the current hash', () => {
    expect(isItemStale('h1', 'h1')).toBe(false)
  })
  it('is stale when the current hash differs or is unknown', () => {
    expect(isItemStale('h1', 'h2')).toBe(true)
    expect(isItemStale('h1', undefined)).toBe(true)
  })
})

describe('canDecideItem', () => {
  it('permits a decision only on a PENDING item', () => {
    expect(canDecideItem('PENDING')).toBe(true)
    for (const s of ['ACCEPTED', 'REJECTED', 'EDITED', 'APPLIED', 'STALE'] as ItemStatus[]) {
      expect(canDecideItem(s)).toBe(false)
    }
  })
})

describe('settleProposalStatus', () => {
  it('stays PENDING while any item is PENDING or STALE (needs rebase)', () => {
    expect(settleProposalStatus(['APPLIED', 'PENDING'])).toBe('PENDING')
    expect(settleProposalStatus(['REJECTED', 'STALE'])).toBe('PENDING')
  })
  it('settles ACCEPTED when anything was accepted/applied', () => {
    expect(settleProposalStatus(['APPLIED', 'REJECTED'])).toBe('ACCEPTED')
    expect(settleProposalStatus(['ACCEPTED'])).toBe('ACCEPTED')
    expect(settleProposalStatus(['EDITED', 'REJECTED'])).toBe('ACCEPTED')
  })
  it('settles REJECTED only when every item was rejected', () => {
    expect(settleProposalStatus(['REJECTED', 'REJECTED'])).toBe('REJECTED')
  })
})
