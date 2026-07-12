import { describe, expect, it } from 'vitest'
import {
  COPILOT_PROGRESS_EVENT_TYPE,
  copilotProgressEventSchema,
  normalizeProgressEvent,
  toProgressRow,
} from '../src/modules/workflow/runtime/copilot-progress'

const NODE = '11111111-1111-1111-1111-111111111111'
const OTHER_NODE = '22222222-2222-2222-2222-222222222222'

describe('copilotProgressEventSchema', () => {
  it('accepts a minimal tick (event only) and a full tick', () => {
    expect(copilotProgressEventSchema.safeParse({ event: 'run.started' }).success).toBe(true)
    const full = copilotProgressEventSchema.safeParse({
      event: 'phase.completed',
      phase: 'design',
      nodeId: NODE,
      status: 'completed',
      message: 'done',
      seq: 3,
      at: '2026-07-11T00:00:00.000Z',
      data: { durationMs: 1200, changedFileCount: 2 },
    })
    expect(full.success).toBe(true)
  })

  it('rejects a missing/empty event and a non-uuid nodeId', () => {
    expect(copilotProgressEventSchema.safeParse({}).success).toBe(false)
    expect(copilotProgressEventSchema.safeParse({ event: '' }).success).toBe(false)
    expect(copilotProgressEventSchema.safeParse({ event: 'x', nodeId: 'not-a-uuid' }).success).toBe(false)
  })
})

describe('normalizeProgressEvent', () => {
  const valid = new Set([NODE])

  it('keeps a nodeId that names a real node of the run', () => {
    const out = normalizeProgressEvent({ event: 'phase.started', phase: 'design', nodeId: NODE }, valid)
    expect(out).toEqual({ event: 'phase.started', phase: 'design', nodeId: NODE })
  })

  it('drops a nodeId that is not a node of this run (anti-spoof)', () => {
    const out = normalizeProgressEvent({ event: 'phase.started', nodeId: OTHER_NODE }, valid)
    expect(out.nodeId).toBeUndefined()
    expect(out.event).toBe('phase.started')
  })

  it('omits absent optional fields rather than emitting undefined keys', () => {
    const out = normalizeProgressEvent({ event: 'run.started' }, valid)
    expect(out).toEqual({ event: 'run.started' })
    expect(Object.keys(out)).toEqual(['event'])
  })

  it('copies through seq=0 and passes data through verbatim', () => {
    const out = normalizeProgressEvent({ event: 'phase.started', seq: 0, data: { index: 1 } }, valid)
    expect(out.seq).toBe(0)
    expect(out.data).toEqual({ index: 1 })
  })
})

describe('toProgressRow', () => {
  it('prefixes the kind and defaults severity to info', () => {
    const row = toProgressRow('ev1', '2026-07-11T00:00:00.000Z', { event: 'phase.started', phase: 'design' })
    expect(row).toEqual({
      id: 'ev1',
      kind: 'copilot.progress.phase.started',
      timestamp: '2026-07-11T00:00:00.000Z',
      severity: 'info',
      payload: { event: 'phase.started', phase: 'design' },
    })
  })

  it('marks failed / error status as error severity', () => {
    expect(toProgressRow('e', 'now', { event: 'phase.completed', status: 'failed' }).severity).toBe('error')
    expect(toProgressRow('e', 'now', { event: 'phase.completed', status: 'ERROR' }).severity).toBe('error')
    expect(toProgressRow('e', 'now', { event: 'phase.completed', status: 'completed' }).severity).toBe('info')
  })

  it('serializes a Date occurredAt to ISO', () => {
    const row = toProgressRow('e', new Date('2026-07-11T12:34:56.000Z'), { event: 'run.completed' })
    expect(row.timestamp).toBe('2026-07-11T12:34:56.000Z')
  })

  it('exposes the stable WorkflowEvent.eventType constant', () => {
    expect(COPILOT_PROGRESS_EVENT_TYPE).toBe('CopilotRunProgress')
  })
})
