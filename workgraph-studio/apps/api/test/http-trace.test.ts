import { context, trace, TraceFlags } from '@opentelemetry/api'
import { describe, expect, it } from 'vitest'
import { tracingHeaders } from '../src/lib/observability/http-trace'

describe('tracingHeaders', () => {
  it('injects W3C traceparent and preserves existing headers', () => {
    const spanContext = {
      traceId: '11111111111111111111111111111111',
      spanId: '2222222222222222',
      traceFlags: TraceFlags.SAMPLED,
    }
    const ctx = trace.setSpanContext(context.active(), spanContext)

    const headers = tracingHeaders({ 'content-type': 'application/json' }, 'app-trace-123', ctx)
    expect(headers['content-type']).toBe('application/json')
    expect(headers.traceparent).toBe('00-11111111111111111111111111111111-2222222222222222-01')
    expect(headers['x-singularity-trace-id']).toBe('app-trace-123')
  })

  it('omits tracing headers when there is no active span or app trace id', () => {
    expect(tracingHeaders({ accept: 'application/json' })).toEqual({ accept: 'application/json' })
  })
})
