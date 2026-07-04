import { describe, expect, it } from 'vitest'
import { copilotComposeTimeoutMs } from '../src/modules/workflow/copilot-compose-config'

describe('Copilot prompt composition timeout config', () => {
  it.each([undefined, '', ' ', 'bad', '0', '-1000', '999', 'NaN', 'Infinity'])(
    'falls back to the default for invalid value %s',
    (raw) => {
      expect(copilotComposeTimeoutMs(raw)).toBe(30_000)
    },
  )

  it('accepts in-range millisecond values', () => {
    expect(copilotComposeTimeoutMs('1000')).toBe(1_000)
    expect(copilotComposeTimeoutMs('45000')).toBe(45_000)
  })

  it('truncates fractional milliseconds', () => {
    expect(copilotComposeTimeoutMs('1234.9')).toBe(1_234)
  })

  it('caps large values so best-effort export cannot hang indefinitely', () => {
    expect(copilotComposeTimeoutMs('999999999')).toBe(120_000)
  })
})
