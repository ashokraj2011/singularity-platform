import { type WorkflowInstance, type WorkflowNode } from '@prisma/client'
import { config } from '../../../../config'
import { redactSecrets } from '../../../../lib/redact'
import { publishEvent, type EventEnvelope } from '../../../../lib/eventbus/publisher'

/**
 * EVENT_EMIT executor — publish a workflow event to a configurable data sink.
 *
 * A fire-and-advance server node (same dispatch shape as RUN_PYTHON): returns
 * { passed, output }; the WorkflowRuntime advances on pass and failNode()s on
 * fail. Supported transports:
 *
 *   EVENTBUS — the platform's own outbox bus (publishEvent → event_outbox →
 *              dispatcher fans out to EventSubscription webhooks). Zero extra
 *              deps; works out of the box. The default.
 *   KAFKA    — produce to a topic (kafkajs).
 *   SQS      — send to an SQS queue (@aws-sdk/client-sqs).
 *   SNS      — publish to an SNS topic (@aws-sdk/client-sns).
 *   AMQP     — publish to a RabbitMQ exchange/routing-key (amqplib).
 *
 * Broker SDKs are LAZY + OPTIONAL: each driver dynamic-imports its package only
 * when that transport is selected. If the package isn't installed the node
 * fails (or, with failOnError=false, advances) with TRANSPORT_DEPENDENCY_MISSING
 * rather than crashing the server at boot. So a deployment that only uses
 * EVENTBUS never needs kafkajs/aws-sdk/amqplib on disk.
 *
 * Secrets stay OUT of the graph: broker credentials come from env (the AWS SDK
 * default credential chain; KAFKA_SASL_*; AMQP_URL). The node config carries
 * only routing (topic/queue/exchange) + payload mapping.
 */

// ── config shape (documentation; node.config is loosely typed JSON) ──────────
export type EventEmitTransport = 'EVENTBUS' | 'KAFKA' | 'SQS' | 'SNS' | 'AMQP'
const KNOWN_TRANSPORTS: ReadonlySet<string> = new Set<EventEmitTransport>([
  'EVENTBUS', 'KAFKA', 'SQS', 'SNS', 'AMQP',
])

export interface EventEmitOutput {
  eventEmit: {
    transport: string
    ok: boolean
    eventName: string
    messageId?: string
    detail?: Record<string, unknown>
    error?: string
    code?: string
  }
}

// ── config readers (mirror RunPythonExecutor) ────────────────────────────────
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
function cfgValue(node: WorkflowNode, key: string): unknown {
  const cfg = isRecord(node.config) ? node.config : {}
  const standard = isRecord(cfg.standard) ? cfg.standard : {}
  return cfg[key] ?? standard[key]
}
function cfgString(node: WorkflowNode, key: string): string | undefined {
  const v = cfgValue(node, key)
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
function cfgBool(node: WorkflowNode, key: string, fallback: boolean): boolean {
  const v = cfgValue(node, key)
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true'
  return fallback
}
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, obj)
}
/** Parse a JSON-object config field (e.g. headers). Returns {} when empty. */
function parseJsonObject(node: WorkflowNode, key: string): { value: Record<string, string> } | { error: string } {
  const raw = cfgValue(node, key)
  if (raw == null || raw === '') return { value: {} }
  let obj: unknown = raw
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw) } catch { return { error: `${key} must be valid JSON` } }
  }
  if (!isRecord(obj)) return { error: `${key} must be a JSON object` }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'string' ? v : JSON.stringify(v)
  return { value: out }
}

// ── error types ──────────────────────────────────────────────────────────────
class TransportDependencyError extends Error {
  constructor(public pkg: string) {
    super(`transport requires the '${pkg}' package — run \`npm i ${pkg}\` in apps/api to enable it`)
  }
}

/** Lazy, dep-gated module load. Variable specifier so tsc/vite don't try to
 *  resolve the optional broker SDK at build time; a missing package surfaces as
 *  TransportDependencyError at execution, not a boot crash. */
async function optionalModule(pkg: string): Promise<any> {
  try {
    return await import(/* @vite-ignore */ pkg)
  } catch (err) {
    const msg = String((err as Error)?.message ?? err)
    const code = (err as NodeJS.ErrnoException)?.code
    if (
      code === 'ERR_MODULE_NOT_FOUND' ||
      code === 'MODULE_NOT_FOUND' ||
      /cannot find (module|package)|failed to (load|resolve)|ERR_MODULE_NOT_FOUND/i.test(msg)
    ) {
      throw new TransportDependencyError(pkg)
    }
    throw err
  }
}

interface EmitMessage {
  eventName: string
  body: unknown
  key?: string
  headers: Record<string, string>
}
interface EmitResult {
  messageId?: string
  detail?: Record<string, unknown>
}

// ── transport drivers ─────────────────────────────────────────────────────────

async function emitEventbus(node: WorkflowNode, instance: WorkflowInstance, msg: EmitMessage): Promise<EmitResult> {
  const envelope: EventEnvelope = {
    kind: 'workflow_event',
    source_service: 'workgraph-api',
    trace_id: instance.id,
    subject: { kind: 'WorkflowInstance', id: instance.id },
    status: 'emitted',
    correlation: { nodeId: node.id, key: msg.key ?? null },
    payload: isRecord(msg.body) ? msg.body : { value: msg.body },
  }
  const outboxId = await publishEvent({ eventName: msg.eventName, envelope })
  return { messageId: outboxId, detail: { outboxId } }
}

async function emitKafka(node: WorkflowNode, msg: EmitMessage): Promise<EmitResult> {
  const topic = cfgString(node, 'topic')!
  const brokers = (cfgString(node, 'brokers') ?? process.env.KAFKA_BROKERS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)
  const { Kafka } = await optionalModule('kafkajs')
  const sasl = process.env.KAFKA_SASL_USERNAME
    ? {
        mechanism: (process.env.KAFKA_SASL_MECHANISM ?? 'plain'),
        username: process.env.KAFKA_SASL_USERNAME,
        password: process.env.KAFKA_SASL_PASSWORD ?? '',
      }
    : undefined
  const kafka = new Kafka({
    clientId: cfgString(node, 'clientId') ?? 'workgraph-event-emit',
    brokers,
    ssl: cfgBool(node, 'ssl', Boolean(sasl)),
    ...(sasl ? { sasl } : {}),
  })
  const producer = kafka.producer()
  await producer.connect()
  try {
    const meta = await producer.send({
      topic,
      messages: [{
        key: msg.key,
        value: JSON.stringify(msg.body),
        headers: msg.headers,
      }],
    })
    const first = Array.isArray(meta) ? meta[0] : undefined
    return {
      messageId: first?.baseOffset != null ? String(first.baseOffset) : undefined,
      detail: { topic, partition: first?.partition },
    }
  } finally {
    await producer.disconnect().catch(() => {})
  }
}

function awsAttributes(headers: Record<string, string>): Record<string, { DataType: string; StringValue: string }> {
  const out: Record<string, { DataType: string; StringValue: string }> = {}
  for (const [k, v] of Object.entries(headers)) out[k] = { DataType: 'String', StringValue: v }
  return out
}

async function emitSqs(node: WorkflowNode, msg: EmitMessage): Promise<EmitResult> {
  const queueUrl = cfgString(node, 'queueUrl')!
  const region = cfgString(node, 'region') ?? process.env.AWS_REGION
  const { SQSClient, SendMessageCommand } = await optionalModule('@aws-sdk/client-sqs')
  const client = new SQSClient(region ? { region } : {})
  const groupId = cfgString(node, 'messageGroupId')
  const out = await client.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(msg.body),
    ...(groupId ? { MessageGroupId: groupId, MessageDeduplicationId: msg.key ?? undefined } : {}),
    ...(Object.keys(msg.headers).length ? { MessageAttributes: awsAttributes(msg.headers) } : {}),
  }))
  return { messageId: out?.MessageId, detail: { queueUrl } }
}

async function emitSns(node: WorkflowNode, msg: EmitMessage): Promise<EmitResult> {
  const topicArn = cfgString(node, 'topicArn')!
  const region = cfgString(node, 'region') ?? process.env.AWS_REGION
  const { SNSClient, PublishCommand } = await optionalModule('@aws-sdk/client-sns')
  const client = new SNSClient(region ? { region } : {})
  const out = await client.send(new PublishCommand({
    TopicArn: topicArn,
    Message: JSON.stringify(msg.body),
    Subject: msg.eventName.slice(0, 100),
    ...(Object.keys(msg.headers).length ? { MessageAttributes: awsAttributes(msg.headers) } : {}),
  }))
  return { messageId: out?.MessageId, detail: { topicArn } }
}

async function emitAmqp(node: WorkflowNode, msg: EmitMessage): Promise<EmitResult> {
  const url = cfgString(node, 'url') ?? process.env.AMQP_URL!
  const exchange = cfgString(node, 'exchange') ?? ''
  const routingKey = cfgString(node, 'routingKey')!
  const amqp = await optionalModule('amqplib')
  const conn = await amqp.connect(url)
  try {
    const ch = await conn.createChannel()
    if (exchange) {
      await ch.assertExchange(exchange, cfgString(node, 'exchangeType') ?? 'topic', { durable: true })
    }
    ch.publish(exchange, routingKey, Buffer.from(JSON.stringify(msg.body)), {
      contentType: 'application/json',
      headers: msg.headers,
    })
    await ch.close()
  } finally {
    await conn.close().catch(() => {})
  }
  return { detail: { exchange, routingKey } }
}

// ── config validation (always-fatal, independent of failOnError) ──────────────
function validateConfig(transport: string, node: WorkflowNode): { code: string; error: string } | null {
  if (!KNOWN_TRANSPORTS.has(transport)) {
    return { code: 'EVENT_EMIT_UNKNOWN_TRANSPORT', error: `unknown transport '${transport}' (expected one of ${[...KNOWN_TRANSPORTS].join(', ')})` }
  }
  switch (transport) {
    case 'KAFKA': {
      if (!cfgString(node, 'topic')) return { code: 'EVENT_EMIT_MISSING_TOPIC', error: 'KAFKA transport requires a `topic`' }
      const hasBrokers = cfgString(node, 'brokers') || process.env.KAFKA_BROKERS
      if (!hasBrokers) return { code: 'EVENT_EMIT_MISSING_BROKERS', error: 'KAFKA transport requires `brokers` (node config) or KAFKA_BROKERS (env)' }
      return null
    }
    case 'SQS':
      return cfgString(node, 'queueUrl') ? null : { code: 'EVENT_EMIT_MISSING_QUEUE', error: 'SQS transport requires a `queueUrl`' }
    case 'SNS':
      return cfgString(node, 'topicArn') ? null : { code: 'EVENT_EMIT_MISSING_TOPIC_ARN', error: 'SNS transport requires a `topicArn`' }
    case 'AMQP': {
      if (!cfgString(node, 'routingKey')) return { code: 'EVENT_EMIT_MISSING_ROUTING_KEY', error: 'AMQP transport requires a `routingKey`' }
      if (!cfgString(node, 'url') && !process.env.AMQP_URL) return { code: 'EVENT_EMIT_MISSING_AMQP_URL', error: 'AMQP transport requires `url` (node config) or AMQP_URL (env)' }
      return null
    }
    default:
      return null // EVENTBUS — no routing required
  }
}

async function dispatchTransport(
  transport: string,
  node: WorkflowNode,
  instance: WorkflowInstance,
  msg: EmitMessage,
): Promise<EmitResult> {
  switch (transport) {
    case 'EVENTBUS': return emitEventbus(node, instance, msg)
    case 'KAFKA':    return emitKafka(node, msg)
    case 'SQS':      return emitSqs(node, msg)
    case 'SNS':      return emitSns(node, msg)
    case 'AMQP':     return emitAmqp(node, msg)
    default:         throw new TransportDependencyError(transport) // unreachable post-validation
  }
}

function configFail(transport: string, eventName: string, code: string, error: string): { passed: false; output: EventEmitOutput } {
  return { passed: false, output: { eventEmit: { transport, ok: false, eventName, error, code } } }
}

export async function activateEventEmit(
  node: WorkflowNode,
  instance: WorkflowInstance,
  _actorId?: string,
): Promise<{ passed: boolean; output: EventEmitOutput }> {
  const transport = (cfgString(node, 'transport') ?? 'EVENTBUS').toUpperCase()
  const eventName = cfgString(node, 'eventName') ?? node.label ?? 'workflow.event'
  const failOnError = cfgBool(node, 'failOnError', true)

  // 1) Resolve the payload from the instance context.
  const context = isRecord(instance.context) ? instance.context : {}
  const payloadPath = cfgString(node, 'payloadPath')
  const body: unknown = payloadPath ? resolvePath(context, payloadPath) : context

  // 2) Resolve key + headers.
  const keyPath = cfgString(node, 'keyPath')
  const key = keyPath ? (() => { const v = resolvePath(context, keyPath); return v == null ? undefined : String(v) })()
                      : cfgString(node, 'key')
  const headersResult = parseJsonObject(node, 'headers')
  if ('error' in headersResult) return configFail(transport, eventName, 'EVENT_EMIT_BAD_HEADERS', headersResult.error)

  // 3) Validate transport config — these are author mistakes, always fatal
  //    (failOnError only governs *runtime* delivery errors, below).
  const invalid = validateConfig(transport, node)
  if (invalid) return configFail(transport, eventName, invalid.code, invalid.error)

  const msg: EmitMessage = { eventName, body, key, headers: headersResult.value }

  // 4) Deliver. Runtime/transport errors (broker down, missing SDK, auth) are
  //    subject to failOnError: default true → fail the node; false → advance
  //    best-effort with the error recorded in context for downstream handling.
  try {
    const result = await dispatchTransport(transport, node, instance, msg)
    return {
      passed: true,
      output: { eventEmit: redactSecrets({ transport, ok: true, eventName, messageId: result.messageId, detail: result.detail }) },
    }
  } catch (err) {
    const code = err instanceof TransportDependencyError ? 'EVENT_EMIT_TRANSPORT_DEPENDENCY_MISSING' : 'EVENT_EMIT_FAILED'
    const out: EventEmitOutput = {
      eventEmit: redactSecrets({ transport, ok: false, eventName, error: (err as Error).message, code }),
    }
    return { passed: !failOnError, output: out }
  }
}
