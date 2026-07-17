import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import type { Prisma, PrismaClient } from '@prisma/client'
import { normalizeTraceId, traceIdFromParts } from '@workgraph/shared-types'
import { config } from '../config'
import { ValidationError } from './errors'

type TenantDbStore = {
  tenantId?: string
  traceId?: string
  tx?: TransactionClient
}

type TransactionClient = Prisma.TransactionClient

const tenantDbContext = new AsyncLocalStorage<TenantDbStore>()

export function currentTenantDbContext(): TenantDbStore {
  return tenantDbContext.getStore() ?? {}
}

export function currentTenantIdForDb(): string | undefined {
  return currentTenantDbContext().tenantId
}

export function currentTraceIdForRequest(): string | undefined {
  return currentTenantDbContext().traceId
}

export function currentTenantDbClient(): TransactionClient | undefined {
  return currentTenantDbContext().tx
}

export function runWithTenantDbContext<T>(tenantId: string | undefined, callback: () => T, traceId?: string): T {
  const existing = currentTenantDbContext()
  return tenantDbContext.run({ ...existing, tenantId, traceId: traceId ?? existing.traceId }, callback)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringKey(source: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(source)) return undefined
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function resolveTenantFromRequestForDb(req: Request): string | undefined {
  const header = req.header('x-tenant-id') ?? req.header('x-singularity-tenant-id')
  if (header?.trim()) return header.trim()
  const queryTenant = typeof req.query.tenant_id === 'string'
    ? req.query.tenant_id
    : typeof req.query.tenantId === 'string'
      ? req.query.tenantId
      : undefined
  if (queryTenant?.trim()) return queryTenant.trim()
  return stringKey(req.body, 'tenantId', 'tenant_id')
}

function tenantIsolationStrictForDb(): boolean {
  return config.TENANT_ISOLATION_MODE === 'strict'
}

export function tenantDbContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const bodyTrace = stringKey(req.body, 'traceId', 'trace_id')
  const traceId = normalizeTraceId(req.header('x-singularity-trace-id'))
    ?? normalizeTraceId(bodyTrace)
    ?? traceIdFromParts(['http', randomUUID()])
  runWithTenantDbContext(resolveTenantFromRequestForDb(req), next, traceId)
}

export async function withTenantDbTransaction<T>(
  prisma: PrismaClient,
  callback: (tx: TransactionClient) => Promise<T>,
  tenantId = currentTenantIdForDb(),
): Promise<T> {
  const activeTx = currentTenantDbClient()
  if (activeTx) {
    const activeTenantId = currentTenantIdForDb()
    if (tenantId && activeTenantId && tenantId !== activeTenantId) {
      throw new Error('tenant-scoped DB transaction cannot switch tenant inside an active transaction')
    }
    return callback(activeTx)
  }

  return prisma.$transaction(async (tx) => {
    if (tenantIsolationStrictForDb()) {
      if (!tenantId) {
        throw new ValidationError('TENANT_ISOLATION_MODE=strict requires tenant context before tenant-scoped DB transaction')
      }
      await tx.$executeRaw`select set_config('app.tenant_id', ${tenantId}, true)`
    } else if (tenantId) {
      await tx.$executeRaw`select set_config('app.tenant_id', ${tenantId}, true)`
    }
    const existing = currentTenantDbContext()
    return tenantDbContext.run({ ...existing, tenantId, tx }, () => callback(tx))
  })
}
