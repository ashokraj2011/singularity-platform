/**
 * Unit tests for the EVENT_EMIT executor (activateEventEmit).
 *
 * The executor returns { passed, output }; the WorkflowRuntime advances on pass
 * and failNode()s on fail. We mock the eventbus publisher so the EVENTBUS path
 * needs no database, and assert: config validation (always fatal), payload/key
 * resolution from context, the EVENTBUS happy path, the lazy broker-dependency
 * gating, and the failOnError semantics for runtime delivery errors.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

// Replace the eventbus publisher so EVENTBUS emits don't touch Postgres.
vi.mock('../src/lib/eventbus/publisher', () => ({
  publishEvent: vi.fn(async () => 'outbox-test-1'),
}))

import { activateEventEmit } from '../src/modules/workflow/runtime/executors/EventEmitExecutor'
import { publishEvent } from '../src/lib/eventbus/publisher'

type AnyNode = Parameters<typeof activateEventEmit>[0]
type AnyInstance = Parameters<typeof activateEventEmit>[1]

function node(standard: Record<string, unknown>, label = 'Emit'): AnyNode {
  return { id: 'node-1', label, config: { standard } } as unknown as AnyNode
}
function instance(context: Record<string, unknown> = {}): AnyInstance {
  return { id: 'inst-1', context } as unknown as AnyInstance
}

beforeEach(() => {
  ;(publishEvent as Mock).mockClear()
})

describe('activateEventEmit — config validation (always fatal)', () => {
  it('fails on an unknown transport', async () => {
    const res = await activateEventEmit(node({ transport: 'CARRIER_PIGEON' }), instance())
    expect(res.passed).toBe(false)
    expect(res.output.eventEmit.code).toBe('EVENT_EMIT_UNKNOWN_TRANSPORT')
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('fails KAFKA without a topic', async () => {
    const res = await activateEventEmit(node({ transport: 'KAFKA', brokers: 'h:9092' }), instance())
    expect(res.passed).toBe(false)
    expect(res.output.eventEmit.code).toBe('EVENT_EMIT_MISSING_TOPIC')
  })

  it('fails SQS without a queueUrl', async () => {
    const res = await activateEventEmit(node({ transport: 'SQS' }), instance())
    expect(res.passed).toBe(false)
    expect(res.output.eventEmit.code).toBe('EVENT_EMIT_MISSING_QUEUE')
  })

  it('fails SNS without a topicArn', async () => {
    const res = await activateEventEmit(node({ transport: 'SNS' }), instance())
    expect(res.passed).toBe(false)
    expect(res.output.eventEmit.code).toBe('EVENT_EMIT_MISSING_TOPIC_ARN')
  })

  it('fails AMQP without a routingKey', async () => {
    const res = await activateEventEmit(node({ transport: 'AMQP', url: 'amqp://x' }), instance())
    expect(res.passed).toBe(false)
    expect(res.output.eventEmit.code).toBe('EVENT_EMIT_MISSING_ROUTING_KEY')
  })

  it('fails on malformed headers JSON', async () => {
    const res = await activateEventEmit(node({ transport: 'EVENTBUS', headers: '{not json}' }), instance())
    expect(res.passed).toBe(false)
    expect(res.output.eventEmit.code).toBe('EVENT_EMIT_BAD_HEADERS')
    expect(publishEvent).not.toHaveBeenCalled()
  })
})

describe('activateEventEmit — EVENTBUS transport (default)', () => {
  it('publishes the whole context and advances', async () => {
    const ctx = { order: { id: 42 }, total: 99 }
    const res = await activateEventEmit(node({ eventName: 'order.created' }), instance(ctx))
    expect(res.passed).toBe(true)
    expect(res.output.eventEmit).toMatchObject({ transport: 'EVENTBUS', ok: true, eventName: 'order.created', messageId: 'outbox-test-1' })

    expect(publishEvent).toHaveBeenCalledTimes(1)
    const arg = (publishEvent as Mock).mock.calls[0][0]
    expect(arg.eventName).toBe('order.created')
    expect(arg.envelope.payload).toEqual(ctx)
    expect(arg.envelope.subject).toEqual({ kind: 'WorkflowInstance', id: 'inst-1' })
  })

  it('resolves payloadPath + keyPath from the context', async () => {
    const ctx = { order: { id: 42, customer: 'acme' } }
    const res = await activateEventEmit(
      node({ transport: 'EVENTBUS', eventName: 'order', payloadPath: 'order', keyPath: 'order.customer' }),
      instance(ctx),
    )
    expect(res.passed).toBe(true)
    const arg = (publishEvent as Mock).mock.calls[0][0]
    expect(arg.envelope.payload).toEqual({ id: 42, customer: 'acme' })
    expect(arg.envelope.correlation.key).toBe('acme')
  })

  it('defaults the event name to the node label', async () => {
    const res = await activateEventEmit(node({}, 'My Emit Node'), instance({ a: 1 }))
    expect(res.passed).toBe(true)
    expect(res.output.eventEmit.eventName).toBe('My Emit Node')
  })
})

describe('activateEventEmit — broker dependency gating', () => {
  // kafkajs / aws-sdk / amqplib are optionalDependencies and not installed in
  // CI, so selecting those transports must degrade gracefully rather than crash.
  it('fails with a dependency-missing code when the broker SDK is absent (failOnError default)', async () => {
    const res = await activateEventEmit(
      node({ transport: 'KAFKA', topic: 't', brokers: 'localhost:9092' }),
      instance({ a: 1 }),
    )
    expect(res.passed).toBe(false)
    expect(res.output.eventEmit.code).toBe('EVENT_EMIT_TRANSPORT_DEPENDENCY_MISSING')
    expect(res.output.eventEmit.ok).toBe(false)
  })

  it('advances best-effort when failOnError=false', async () => {
    const res = await activateEventEmit(
      node({ transport: 'KAFKA', topic: 't', brokers: 'localhost:9092', failOnError: 'false' }),
      instance({ a: 1 }),
    )
    expect(res.passed).toBe(true) // node advances despite the delivery error
    expect(res.output.eventEmit.ok).toBe(false)
    expect(res.output.eventEmit.code).toBe('EVENT_EMIT_TRANSPORT_DEPENDENCY_MISSING')
  })
})
