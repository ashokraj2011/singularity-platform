import type { WorkflowNode, WorkflowInstance } from '@prisma/client'
import { prisma } from '../../../../lib/prisma'
import { buildAdapter } from '../../../connectors/connector.service'
import { logEvent, publishOutbox } from '../../../../lib/audit'

interface SinkConfig {
  kind: 'CONNECTOR' | 'S3' | 'DB_EVENT' | 'ARTIFACT'
  connectorId?: string
  operation?: string
  paramMap?: Record<string, string>   // paramKey → context path (dot-notation)
  // S3 shortcuts
  bucket?: string
  keyTemplate?: string
  bodyPath?: string
  // Artifact sink
  artifactType?: string
  namePath?: string
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce((acc: unknown, key) => {
    if (acc == null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, obj)
}

function resolveParams(paramMap: Record<string, string>, context: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, path] of Object.entries(paramMap)) {
    out[k] = resolvePath(context, path) ?? path  // fallback to literal if not found
  }
  return out
}

export async function activateDataSink(node: WorkflowNode, instance: WorkflowInstance): Promise<void> {
  const config = (node.config ?? {}) as Record<string, unknown> & { sinkConfig?: SinkConfig }
  const sink: SinkConfig = (config.sinkConfig as SinkConfig) ?? { kind: 'DB_EVENT' }
  const context = (instance.context ?? {}) as Record<string, unknown>

  try {
    if (sink.kind === 'CONNECTOR' && sink.connectorId) {
      const connector = await prisma.connector.findUniqueOrThrow({ where: { id: sink.connectorId } })
      const adapter = buildAdapter(connector.type, connector.config as any, connector.credentials as any)
      const resolvedParams = sink.paramMap ? resolveParams(sink.paramMap, context) : {}
      const result = await adapter.invoke(sink.operation ?? 'putObject', resolvedParams)
      await logEvent('DataSinkWritten', 'WorkflowInstance', instance.id, undefined, { nodeId: node.id, connectorId: sink.connectorId, operation: sink.operation })
      await publishOutbox('WorkflowInstance', instance.id, 'DataSinkWritten', { nodeId: node.id })
      return
    }

    if (sink.kind === 'DB_EVENT') {
      const data = sink.bodyPath ? resolvePath(context, sink.bodyPath) : context
      await prisma.outboxEvent.create({
        data: {
          aggregateType: 'DATA_SINK',
          aggregateId: instance.id,
          eventType: 'SinkWrite',
          payload: { nodeId: node.id, data } as any,
          status: 'PROCESSED',
        },
      })
      await logEvent('DataSinkWritten', 'WorkflowInstance', instance.id, undefined, { nodeId: node.id, kind: 'DB_EVENT' })
      return
    }

    if (sink.kind === 'ARTIFACT') {
      const body = sink.bodyPath ? resolvePath(context, sink.bodyPath) : context
      const name = sink.namePath ? String(resolvePath(context, sink.namePath) ?? node.label) : node.label
      await prisma.consumable.create({
        data: {
          typeId: sink.artifactType ?? 'generic',
          instanceId: instance.id,
          name,
          status: 'PUBLISHED',
          content: { body } as any,
          createdById: instance.createdById ?? undefined,
        } as any,
      })
      await logEvent('DataSinkWritten', 'WorkflowInstance', instance.id, undefined, { nodeId: node.id, kind: 'ARTIFACT', name })
      return
    }

    throw new Error(`Unsupported sink kind: ${sink.kind}`)
  } catch (err: any) {
    await logEvent('DataSinkFailed', 'WorkflowInstance', instance.id, undefined, { nodeId: node.id, error: err?.message })
    throw err
  }
}
