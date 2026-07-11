import { afterEach, describe, expect, it } from 'vitest'
import { openSubscriptionSecret, publicSubscription, sealSubscriptionSecret } from '../src/lib/eventbus/subscription-secret'

const originalKey = process.env.WORKGRAPH_EVENT_SECRET_KEY
const originalAppEnv = process.env.APP_ENV

afterEach(() => {
  if (originalKey === undefined) delete process.env.WORKGRAPH_EVENT_SECRET_KEY
  else process.env.WORKGRAPH_EVENT_SECRET_KEY = originalKey
  if (originalAppEnv === undefined) delete process.env.APP_ENV
  else process.env.APP_ENV = originalAppEnv
})

describe('event subscription secret protection', () => {
  it('encrypts at rest and decrypts only for delivery', () => {
    process.env.WORKGRAPH_EVENT_SECRET_KEY = 'test-event-secret-key-min-32-characters'
    const sealed = sealSubscriptionSecret('subscriber-hmac-secret-value')
    expect(sealed).toMatch(/^enc:v1:/)
    expect(sealed).not.toContain('subscriber-hmac-secret-value')
    expect(openSubscriptionSecret(sealed)).toBe('subscriber-hmac-secret-value')
  })

  it('redacts the stored value from API response shapes', () => {
    const value = publicSubscription({ id: 'sub-1', secret: 'ciphertext', targetUrl: 'https://example.com/events' })
    expect(value).toEqual({ id: 'sub-1', targetUrl: 'https://example.com/events', secretConfigured: true })
    expect(value).not.toHaveProperty('secret')
  })

  it('rejects weak development keys in production', () => {
    process.env.APP_ENV = 'production'
    process.env.WORKGRAPH_EVENT_SECRET_KEY = 'dev-workgraph-event-secret-min-32-chars'
    expect(() => sealSubscriptionSecret('subscriber-hmac-secret-value')).toThrow(/WORKGRAPH_EVENT_SECRET_KEY is required/)
  })
})
