import { describe, expect, it } from 'vitest'
import { systemPromptCacheTtlMs } from '../src/lib/prompt-composer/client'

describe('Workgraph Prompt Composer system prompt cache TTL', () => {
  it.each([undefined, '', ' ', 'not-a-number', '0', '-1', 'Infinity', 'NaN'])(
    'falls back to 5 minutes for invalid value %s',
    (raw) => {
      expect(systemPromptCacheTtlMs(raw)).toBe(300_000)
    },
  )

  it('accepts positive values in seconds', () => {
    expect(systemPromptCacheTtlMs('1')).toBe(1_000)
    expect(systemPromptCacheTtlMs('42')).toBe(42_000)
  })

  it('truncates fractional seconds instead of extending beyond the requested TTL', () => {
    expect(systemPromptCacheTtlMs('8.9')).toBe(8_000)
  })

  it('caps large values at 24 hours', () => {
    expect(systemPromptCacheTtlMs(String(99 * 24 * 60 * 60))).toBe(86_400_000)
  })
})
