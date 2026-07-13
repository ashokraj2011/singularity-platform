import { describe, it, expect } from 'vitest'
import {
  extractRunLoopStrategyId,
  extractRunLoopStrategyVersion,
} from '../src/modules/workflow/runtime/executors/DirectLlmTaskExecutor'

describe('run-level loop strategy extraction', () => {
  it('reads loopStrategyId from _globals, then _vars, then legacy globals/vars', () => {
    expect(extractRunLoopStrategyId({ _globals: { loopStrategyId: ' g-123 ' } })).toBe('g-123')
    expect(extractRunLoopStrategyId({ _vars: { loopStrategyId: 'v-1' } })).toBe('v-1')
    expect(extractRunLoopStrategyId({ globals: { loopStrategyId: 'legacy-g' } })).toBe('legacy-g')
    // _globals wins over _vars
    expect(extractRunLoopStrategyId({ _globals: { loopStrategyId: 'g' }, _vars: { loopStrategyId: 'v' } })).toBe('g')
  })

  it('returns undefined when absent / blank / non-string / non-object', () => {
    expect(extractRunLoopStrategyId(null)).toBeUndefined()
    expect(extractRunLoopStrategyId('nope')).toBeUndefined()
    expect(extractRunLoopStrategyId({})).toBeUndefined()
    expect(extractRunLoopStrategyId({ _vars: { loopStrategyId: '   ' } })).toBeUndefined()
    expect(extractRunLoopStrategyId({ _vars: { loopStrategyId: 42 } })).toBeUndefined()
  })

  it('reads an optional positive-integer version, else undefined', () => {
    expect(extractRunLoopStrategyVersion({ _globals: { loopStrategyVersion: 3 } })).toBe(3)
    expect(extractRunLoopStrategyVersion({ _vars: { loopStrategyVersion: '2' } })).toBe(2)
    expect(extractRunLoopStrategyVersion({ _vars: { loopStrategyVersion: 4.9 } })).toBe(4)
    expect(extractRunLoopStrategyVersion({})).toBeUndefined()
    expect(extractRunLoopStrategyVersion({ _vars: { loopStrategyVersion: 0 } })).toBeUndefined()
    expect(extractRunLoopStrategyVersion({ _vars: { loopStrategyVersion: -1 } })).toBeUndefined()
  })
})
