import type { Request } from 'express'
import { config } from '../config'
import { ForbiddenError, ValidationError } from './errors'
import { prisma } from './prisma'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
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

export function tenantIsolationStrict(): boolean {
  return config.TENANT_ISOLATION_MODE === 'strict'
}

export function resolveTenantFromContext(context: unknown): string | undefined {
  const ctx = isRecord(context) ? context : {}
  const vars = isRecord(ctx._vars) ? ctx._vars : isRecord(ctx.vars) ? ctx.vars : {}
  const globals = isRecord(ctx._globals) ? ctx._globals : isRecord(ctx.globals) ? ctx.globals : {}
  const workItem = isRecord(ctx._workItem) ? ctx._workItem : {}
  const workItemInput = isRecord(workItem.input) ? workItem.input : {}

  return stringKey(ctx, 'tenantId', 'tenant_id')
    ?? stringKey(vars, 'tenantId', 'tenant_id')
    ?? stringKey(globals, 'tenantId', 'tenant_id')
    ?? stringKey(workItem, 'tenantId', 'tenant_id')
    ?? stringKey(workItemInput, 'tenantId', 'tenant_id')
}

export function resolveTenantFromRequest(req: Request): string | undefined {
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

export function requireTenantFromRequest(req: Request, surface = 'this request'): string | undefined {
  if (!tenantIsolationStrict()) return undefined
  const tenantId = resolveTenantFromRequest(req)
  if (!tenantId) {
    throw new ValidationError(`TENANT_ISOLATION_MODE=strict requires X-Tenant-Id or tenant_id for ${surface}`)
  }
  return tenantId
}

function configuredTenantIds(raw: string): string[] {
  return [...new Set(raw.split(',').map(value => value.trim()).filter(Boolean))].sort()
}

export function configuredTenantIdsForInternalToken(): string[] {
  return configuredTenantIds(config.WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS)
}

export function requireTenantScopedInternalToken(req: Request, surface = 'internal service request'): string | undefined {
  if (!tenantIsolationStrict()) return undefined
  const tenantId = resolveTenantFromRequest(req)
  if (!tenantId) {
    throw new ForbiddenError(`Tenant isolation is strict; include X-Tenant-Id or tenant_id for ${surface}`)
  }
  const allowed = configuredTenantIdsForInternalToken()
  if (allowed.length === 0) {
    throw new ForbiddenError(`Tenant isolation is strict but WORKGRAPH_INTERNAL_TOKEN_TENANT_IDS is not configured for ${surface}`)
  }
  if (!allowed.includes(tenantId)) {
    throw new ForbiddenError(`Tenant isolation denied ${surface}`)
  }
  return tenantId
}

export async function backfillWorkflowInstanceTenantId(instanceId: string, tenantId: string): Promise<void> {
  await prisma.workflowInstance.updateMany({
    where: { id: instanceId, tenantId: null },
    data: { tenantId },
  })
}

export async function assertWorkflowInstanceTenant(req: Request, instanceId: string): Promise<void> {
  if (!tenantIsolationStrict()) return

  const instance = await prisma.workflowInstance.findUnique({
    where: { id: instanceId },
    select: { id: true, tenantId: true, context: true },
  })
  if (!instance) {
    throw new ForbiddenError(`WorkflowInstance ${instanceId} not found or not accessible`)
  }

  const instanceTenant = instance.tenantId ?? resolveTenantFromContext(instance.context)
  const requestTenant = resolveTenantFromRequest(req)

  if (!instanceTenant) {
    throw new ForbiddenError('Tenant isolation is strict but this workflow instance has no tenantId')
  }
  if (!requestTenant) {
    throw new ForbiddenError('Tenant isolation is strict; include X-Tenant-Id or tenant_id for workflow instance access')
  }
  if (instanceTenant !== requestTenant) {
    throw new ForbiddenError('Tenant isolation denied workflow instance access')
  }

  if (!instance.tenantId) {
    await backfillWorkflowInstanceTenantId(instance.id, instanceTenant)
  }
}

export async function assertPendingExecutionTenant(req: Request, executionId: string): Promise<void> {
  if (!tenantIsolationStrict()) return
  const exec = await prisma.pendingExecution.findUnique({
    where: { id: executionId },
    select: { instanceId: true },
  })
  if (!exec) throw new ForbiddenError(`PendingExecution ${executionId} not found or not accessible`)
  await assertWorkflowInstanceTenant(req, exec.instanceId)
}

async function assertLinkedWorkflowInstanceTenant(
  req: Request,
  resourceType: string,
  resourceId: string,
  instanceId: string | null | undefined,
): Promise<void> {
  if (!tenantIsolationStrict()) return
  if (!instanceId) {
    throw new ForbiddenError(`Tenant isolation is strict but ${resourceType} ${resourceId} is not linked to a workflow instance`)
  }
  await assertWorkflowInstanceTenant(req, instanceId)
}

export async function assertAgentRunTenant(req: Request, runId: string): Promise<void> {
  if (!tenantIsolationStrict()) return
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { instanceId: true },
  })
  if (!run) throw new ForbiddenError(`AgentRun ${runId} not found or not accessible`)
  await assertLinkedWorkflowInstanceTenant(req, 'AgentRun', runId, run.instanceId)
}

export async function assertToolRunTenant(req: Request, runId: string): Promise<void> {
  if (!tenantIsolationStrict()) return
  const run = await prisma.toolRun.findUnique({
    where: { id: runId },
    select: { instanceId: true },
  })
  if (!run) throw new ForbiddenError(`ToolRun ${runId} not found or not accessible`)
  await assertLinkedWorkflowInstanceTenant(req, 'ToolRun', runId, run.instanceId)
}

export async function assertApprovalRequestTenant(req: Request, approvalRequestId: string): Promise<void> {
  if (!tenantIsolationStrict()) return
  const request = await prisma.approvalRequest.findUnique({
    where: { id: approvalRequestId },
    select: { instanceId: true },
  })
  if (!request) throw new ForbiddenError(`ApprovalRequest ${approvalRequestId} not found or not accessible`)
  await assertLinkedWorkflowInstanceTenant(req, 'ApprovalRequest', approvalRequestId, request.instanceId)
}

export async function assertConsumableTenant(req: Request, consumableId: string): Promise<void> {
  if (!tenantIsolationStrict()) return
  const consumable = await prisma.consumable.findUnique({
    where: { id: consumableId },
    select: { instanceId: true },
  })
  if (!consumable) throw new ForbiddenError(`Consumable ${consumableId} not found or not accessible`)
  await assertLinkedWorkflowInstanceTenant(req, 'Consumable', consumableId, consumable.instanceId)
}

export async function assertDocumentTenant(req: Request, documentId: string): Promise<void> {
  if (!tenantIsolationStrict()) return
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { instanceId: true },
  })
  if (!document) throw new ForbiddenError(`Document ${documentId} not found or not accessible`)
  await assertLinkedWorkflowInstanceTenant(req, 'Document', documentId, document.instanceId)
}

export async function assertWorkflowNodeTenant(req: Request, nodeId: string): Promise<void> {
  if (!tenantIsolationStrict()) return
  const node = await prisma.workflowNode.findUnique({
    where: { id: nodeId },
    select: { instanceId: true },
  })
  if (!node) throw new ForbiddenError(`WorkflowNode ${nodeId} not found or not accessible`)
  await assertLinkedWorkflowInstanceTenant(req, 'WorkflowNode', nodeId, node.instanceId)
}

export function tenantIdForCreate(context: unknown): string | undefined {
  return resolveTenantFromContext(context)
}
