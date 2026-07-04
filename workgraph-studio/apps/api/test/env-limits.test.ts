import { describe, expect, it } from 'vitest'
import { boundedByteLimit } from '../src/lib/env-limits'

const options = { defaultBytes: 64_000, minBytes: 1, maxBytes: 256_000 }

describe('boundedByteLimit', () => {
  it.each([undefined, '', ' ', 'bad', '0', '-1', 'NaN', 'Infinity'])(
    'falls back to the default for invalid value %s',
    (raw) => {
      expect(boundedByteLimit(raw, options)).toBe(64_000)
    },
  )

  it('accepts positive byte values', () => {
    expect(boundedByteLimit('1', options)).toBe(1)
    expect(boundedByteLimit('128000', options)).toBe(128_000)
  })

  it('truncates fractional byte values', () => {
    expect(boundedByteLimit('128.9', options)).toBe(128)
  })

  it('caps oversized byte values', () => {
    expect(boundedByteLimit('999999999', options)).toBe(256_000)
  })

  it('rejects unsafe helper configuration', () => {
    expect(() => boundedByteLimit('10', { defaultBytes: 0, maxBytes: 10 })).toThrow(/defaultBytes/)
    expect(() => boundedByteLimit('10', { defaultBytes: 10, maxBytes: 5 })).toThrow(/maxBytes/)
  })
})
