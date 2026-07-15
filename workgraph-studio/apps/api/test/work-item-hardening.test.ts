import { describe, expect, it } from 'vitest'
import { redactEventPayload } from '../src/modules/events/event-payload'
import { routingSelectorContext, selectorMatches } from '../src/modules/work-items/work-item-routing.service'

describe('WorkItem P0/P1 hardening helpers', () => {
  it('redacts sensitive event fields before persistence', () => {
    const payload = redactEventPayload({
      workId: 'WRK-1',
      nested: { authorization: 'Bearer secret', password: 'hidden', value: 3 },
    })
    expect(payload.workId).toBe('WRK-1')
    expect((payload.nested as Record<string, unknown>).authorization).toBe('[REDACTED:SENSITIVE]')
    expect((payload.nested as Record<string, unknown>).password).toBe('[REDACTED:SENSITIVE]')
    expect((payload.nested as Record<string, unknown>).value).toBe(3)
  })

  it('matches routing selectors against event payload and nested input', () => {
    const context = routingSelectorContext({
      input: { payload: { capabilityName: 'Delivery', severity: 'high' } },
      details: { source: 'incoming-event' },
      workItemTypeKey: 'DESIGN_REVIEW',
      title: 'Review design',
    })
    expect(selectorMatches({ capabilityName: 'Delivery', severity: { $in: ['high', 'critical'] } }, context)).toBe(true)
    expect(selectorMatches({ severity: 'low' }, context)).toBe(false)
    expect(selectorMatches({ '$and': [{ 'payload.capabilityName': 'Delivery' }, { 'workItemTypeKey': 'DESIGN_REVIEW' }] }, context)).toBe(true)
  })
})
