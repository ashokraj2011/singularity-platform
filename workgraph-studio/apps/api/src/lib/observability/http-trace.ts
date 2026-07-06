import { context, propagation, trace, isSpanContextValid, type Context } from '@opentelemetry/api'
import { traceHeaders } from '@workgraph/shared-types'

type HeaderBag = Record<string, string>

function traceFlagsHex(flags: number): string {
  return flags.toString(16).padStart(2, '0')
}

export function tracingHeaders(existing: HeaderBag = {}, appTraceId?: string | null, activeContext: Context = context.active()): HeaderBag {
  const headers: HeaderBag = { ...existing }
  propagation.inject(activeContext, headers)

  const spanContext = trace.getSpanContext(activeContext)
  if (!headers.traceparent && spanContext && isSpanContextValid(spanContext)) {
    headers.traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-${traceFlagsHex(spanContext.traceFlags)}`
  }

  return traceHeaders(headers, appTraceId)
}
