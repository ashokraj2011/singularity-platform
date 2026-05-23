/**
 * Curation proxy router unit tests (task #111).
 *
 * Pinned: the reviewed_by precedence rule. This piece is load-bearing
 * for the audit trail — a regression that prefers a blank body field
 * over a real authenticated email would attribute every operator
 * action to "(unknown)" and there's no recovery once it's in the
 * partition (audit-gov's reviewed_at is set monotonically).
 *
 * The fetch-proxy paths (GET / PATCH passthrough) are NOT tested
 * here — they're a thin wrapper over getJsonStrict / patchJsonStrict
 * which are exercised at audit-gov's own engine routes layer. Adding
 * supertest + a live express harness would buy little signal for
 * the eight-line forwarder.
 */
import { describe, expect, it } from 'vitest'

import { resolveReviewedByFrom } from '../src/modules/audit/curation.router'

describe('resolveReviewedByFrom — precedence', () => {
  it('body wins when present and non-empty', () => {
    const r = resolveReviewedByFrom({
      bodyReviewedBy: 'override@example.com',
      user: { email: 'auth@example.com', userId: 'auth-uid' },
    })
    expect(r).toBe('override@example.com')
  })

  it('body is trimmed', () => {
    const r = resolveReviewedByFrom({
      bodyReviewedBy: '   spaced@example.com   ',
      user: { email: 'auth@example.com' },
    })
    expect(r).toBe('spaced@example.com')
  })

  it('blank body string falls through to auth', () => {
    const r = resolveReviewedByFrom({
      bodyReviewedBy: '   ',
      user: { email: 'auth@example.com' },
    })
    expect(r).toBe('auth@example.com')
  })

  it('non-string body falls through to auth (defensive)', () => {
    // A misconfigured client might POST { reviewed_by: 42 } or
    // { reviewed_by: null } — the type guard rejects, auth wins.
    const r = resolveReviewedByFrom({
      bodyReviewedBy: 42,
      user: { userId: 'auth-uid' },
    })
    expect(r).toBe('auth-uid')
  })

  it('email beats userId when both present on auth', () => {
    // Email is more human-readable and stable across IAM migrations
    // than the opaque sub claim — prefer it for the audit trail.
    const r = resolveReviewedByFrom({
      user: { email: 'preferred@example.com', userId: 'opaque-uid-99' },
    })
    expect(r).toBe('preferred@example.com')
  })

  it('userId is used when email is missing', () => {
    const r = resolveReviewedByFrom({
      user: { userId: 'just-the-sub' },
    })
    expect(r).toBe('just-the-sub')
  })

  it('falls back to (unknown) when nothing is present', () => {
    expect(resolveReviewedByFrom({})).toBe('(unknown)')
    expect(resolveReviewedByFrom({ user: {} })).toBe('(unknown)')
    expect(resolveReviewedByFrom({ user: undefined })).toBe('(unknown)')
  })

  it('whitespace-only auth fields fall back to (unknown)', () => {
    // Defensive against an IAM provider that emits blank strings
    // instead of omitting the field — without trim, those would
    // pass as a valid reviewer.
    const r = resolveReviewedByFrom({
      user: { email: '   ', userId: '   ' },
    })
    expect(r).toBe('(unknown)')
  })
})
