import { describe, it, expect } from 'vitest'
import { redactSecrets } from '../src/lib/redact'

// #24 — redactSecrets is the audit-sink safety net: logEvent / publishOutbox /
// createReceipt now run every payload through it before persisting, so no token
// or key reaches the outbox / event-bus / audit ledger regardless of caller.

describe('redactSecrets', () => {
  it('redacts common secret shapes in strings', () => {
    expect(redactSecrets('ghp_' + 'a'.repeat(36))).toBe('[REDACTED_GITHUB_TOKEN]')
    expect(redactSecrets('Authorization: Bearer ' + 'a'.repeat(32))).toBe('Authorization: Bearer [REDACTED_TOKEN]')
    expect(redactSecrets('git clone https://user:p4ssw0rd-secret@github.com/o/r.git'))
      .toBe('git clone https://[REDACTED_CREDENTIALS]@github.com/o/r.git')
    // An sk-ant key IS redacted; the generic sk-{32,} pattern may claim a long one
    // first, so assert the secret is gone rather than which label won.
    const ant = redactSecrets('sk-ant-' + 'a'.repeat(40))
    expect(ant).toContain('[REDACTED')
    expect(ant).not.toContain('aaaa')
  })

  it('walks nested objects and arrays', () => {
    const payload = {
      traceId: 'T-123',
      count: 7,
      env: { GITHUB_TOKEN: 'ghp_' + 'b'.repeat(36) },
      args: ['--token', 'sk-ant-' + 'c'.repeat(40)],
    }
    const safe = redactSecrets(payload)
    expect(safe.traceId).toBe('T-123') // non-secret correlation untouched
    expect(safe.count).toBe(7)
    expect((safe.env as { GITHUB_TOKEN: string }).GITHUB_TOKEN).toBe('[REDACTED_GITHUB_TOKEN]')
    const argSecret = (safe.args as string[])[1]
    expect(argSecret).toContain('[REDACTED')
    expect(argSecret).not.toContain('cccc')
  })

  it('leaves non-secret values and is idempotent', () => {
    expect(redactSecrets('just a normal message')).toBe('just a normal message')
    const once = redactSecrets('token ghp_' + 'd'.repeat(36))
    expect(redactSecrets(once)).toBe(once) // re-redacting a redacted value is a no-op
  })
})
