import { describe, expect, it } from 'vitest'
import { boundedByteLimit, boundedIntLimit } from '../src/lib/env-limits'

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
    expect(() => boundedByteLimit('10', { defaultBytes: 0, maxBytes: 10 })).toThrow(/defaultValue/)
    expect(() => boundedByteLimit('10', { defaultBytes: 10, maxBytes: 5 })).toThrow(/maxValue/)
  })
})

describe('boundedIntLimit', () => {
  it.each([undefined, '', ' ', 'bad', '0', '-1', 'NaN', 'Infinity'])(
    'falls back to the default for invalid value %s',
    (raw) => {
      expect(boundedIntLimit(raw, { defaultValue: 3000, minValue: 1, maxValue: 10000 })).toBe(3000)
    },
  )

  it('accepts and truncates in-range values', () => {
    expect(boundedIntLimit('1', { defaultValue: 3000, minValue: 1, maxValue: 10000 })).toBe(1)
    expect(boundedIntLimit('3500.9', { defaultValue: 3000, minValue: 1, maxValue: 10000 })).toBe(3500)
  })

  it('caps oversized values', () => {
    expect(boundedIntLimit('999999', { defaultValue: 3000, minValue: 1, maxValue: 10000 })).toBe(10_000)
  })

  it('rejects unsafe helper configuration', () => {
    expect(() => boundedIntLimit('10', { defaultValue: 0, maxValue: 10 })).toThrow(/defaultValue/)
    expect(() => boundedIntLimit('10', { defaultValue: 10, maxValue: 5 })).toThrow(/maxValue/)
  })
})
