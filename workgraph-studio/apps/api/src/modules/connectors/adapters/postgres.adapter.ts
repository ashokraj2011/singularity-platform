import { prisma } from '../../../lib/prisma'
import type { ConnectorAdapter, OperationDef } from '../connector-adapter'

interface PostgresConfig { schema?: string }
// Uses the app's own Prisma connection for internal sink writes.
// For external DBs, raw connection via pg would be needed — deferred.
interface PostgresCredentials { connectionString?: string }

export class PostgresAdapter implements ConnectorAdapter {
  constructor(private config: PostgresConfig, private creds: PostgresCredentials) {}

  async testConnection() {
    try {
      await prisma.$queryRaw`SELECT 1`
      return { ok: true }
    } catch (e: any) { return { ok: false, error: e?.message } }
  }

  async invoke(operation: string, params: Record<string, unknown>) {
    switch (operation) {
      case 'rawQuery':    return this.rawQuery(params)
      case 'upsertJson':  return this.upsertJson(params)
      default: throw new Error(`Unknown Postgres operation: ${operation}`)
    }
  }

  private async rawQuery(p: Record<string, unknown>) {
    // Only SELECT allowed via this adapter to prevent destructive writes via untrusted params
    const sql = p.sql as string
    if (!/^\s*SELECT\s/i.test(sql)) throw new Error('Only SELECT queries are allowed via rawQuery')
    const result = await prisma.$queryRawUnsafe(sql)
    return result
  }

  private async upsertJson(p: Record<string, unknown>) {
    // Writes JSON data to a designated audit/sink table using outbox pattern
    const { table, id, data } = p as { table: string; id?: string; data: Record<string, unknown> }
    // For safety, we only support writing to outbox_events as a generic sink
    if (table !== 'outbox_events' && table !== 'workflow_events') {
      throw new Error(`Direct table writes only allowed for outbox_events or workflow_events. Got: ${table}`)
    }
    const result = await prisma.outboxEvent.create({
      data: {
        aggregateType: 'DATA_SINK',
        aggregateId: id ?? 'unknown',
        eventType: 'SinkWrite',
        payload: data as any,
        status: 'PROCESSED',
      },
    })
    return { id: result.id }
  }

  listOperations(): OperationDef[] {
    return [
      { id: 'rawQuery', label: 'Raw SELECT Query', params: [{ key: 'sql', label: 'SQL (SELECT only)', type: 'text', required: true }] },
      { id: 'upsertJson', label: 'Write to Outbox (Event Sink)', params: [{ key: 'table', label: 'Target (outbox_events)', type: 'string', required: true }, { key: 'data', label: 'Data (JSON)', type: 'json', required: true }] },
    ]
  }
}
