import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction, currentTenantIdForDb } from '../../lib/tenant-db-context'
import { NotFoundError, ValidationError } from '../../lib/errors'

function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue }

export async function listRuntimePolicies() {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.runtimePolicy.findMany({ where: { tenantId }, orderBy: { updatedAt: 'desc' } }), tenantId)
}

export async function createRuntimePolicy(input: { name: string; minVersion?: string; allowedPaths?: string[]; consentMode?: string; autoUpdate?: boolean; killSwitch?: boolean; actorId: string }) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  if (!['PER_ACTION', 'SESSION', 'ALWAYS_ALLOW'].includes(input.consentMode ?? 'PER_ACTION')) throw new ValidationError('Unsupported runtime consent mode')
  return withTenantDbTransaction(prisma, tx => tx.runtimePolicy.create({ data: { tenantId, name: input.name, minVersion: input.minVersion, allowedPaths: json(input.allowedPaths ?? []), consentMode: input.consentMode ?? 'PER_ACTION', autoUpdate: input.autoUpdate ?? true, killSwitch: input.killSwitch ?? false, createdById: input.actorId } }), tenantId)
}

export async function updateRuntimePolicy(id: string, input: { minVersion?: string | null; allowedPaths?: string[]; consentMode?: string; autoUpdate?: boolean; killSwitch?: boolean }) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const existing = await withTenantDbTransaction(prisma, tx => tx.runtimePolicy.findFirst({ where: { id, tenantId } }), tenantId)
  if (!existing) throw new NotFoundError('RuntimePolicy', id)
  return withTenantDbTransaction(prisma, tx => tx.runtimePolicy.update({ where: { id }, data: { minVersion: input.minVersion, allowedPaths: input.allowedPaths ? json(input.allowedPaths) : undefined, consentMode: input.consentMode, autoUpdate: input.autoUpdate, killSwitch: input.killSwitch } }), tenantId)
}

export async function listRuntimeDevices(userId: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.runtimeDevice.findMany({ where: { tenantId, userId }, orderBy: { lastSeenAt: 'desc' } }), tenantId)
}

export async function enrollRuntimeDevice(input: { runtimeId: string; deviceName: string; platform: string; version?: string; policyId?: string; workspaceProfiles?: unknown[]; userId: string }) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  if (input.policyId) {
    const policy = await withTenantDbTransaction(prisma, tx => tx.runtimePolicy.findFirst({ where: { id: input.policyId, tenantId, enabled: true } }), tenantId)
    if (!policy) throw new NotFoundError('RuntimePolicy', input.policyId)
  }
  return withTenantDbTransaction(prisma, tx => tx.runtimeDevice.upsert({
    where: { runtimeId: input.runtimeId },
    create: { tenantId, userId: input.userId, runtimeId: input.runtimeId, deviceName: input.deviceName, platform: input.platform, version: input.version, policyId: input.policyId, workspaceProfiles: json(input.workspaceProfiles ?? []), lastSeenAt: new Date() },
    update: { userId: input.userId, deviceName: input.deviceName, platform: input.platform, version: input.version, policyId: input.policyId, workspaceProfiles: json(input.workspaceProfiles ?? []), status: 'ENROLLED', revokedAt: null, lastSeenAt: new Date() },
  }), tenantId)
}

export async function revokeRuntimeDevice(runtimeId: string, userId: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const device = await withTenantDbTransaction(prisma, tx => tx.runtimeDevice.findFirst({ where: { runtimeId, tenantId, userId } }), tenantId)
  if (!device) throw new NotFoundError('RuntimeDevice', runtimeId)
  return withTenantDbTransaction(prisma, tx => tx.runtimeDevice.update({ where: { id: device.id }, data: { status: 'REVOKED', revokedAt: new Date() } }), tenantId)
}

export async function recordRuntimeConsent(input: { runtimeId: string; action: string; scope: string; decision: string; reason?: string; expiresAt?: Date; userId: string }) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const device = await withTenantDbTransaction(prisma, tx => tx.runtimeDevice.findFirst({ where: { runtimeId: input.runtimeId, tenantId, userId: input.userId } }), tenantId)
  if (!device) throw new NotFoundError('RuntimeDevice', input.runtimeId)
  if (!['ALLOW', 'DENY'].includes(input.decision)) throw new ValidationError('Runtime consent decision must be ALLOW or DENY')
  return withTenantDbTransaction(prisma, tx => tx.runtimeConsent.create({ data: { tenantId, runtimeId: input.runtimeId, userId: input.userId, action: input.action, scope: input.scope, decision: input.decision, reason: input.reason, expiresAt: input.expiresAt } }), tenantId)
}

export function evaluateRuntimePolicy(input: {
  deviceStatus: string
  revoked: boolean
  action: string
  scope: string
  allowedPaths?: string[]
  killSwitch?: boolean
  consentMode?: string
  consentGranted?: boolean
}) {
  if (input.deviceStatus === 'REVOKED' || input.revoked) return { allowed: false, code: 'RUNTIME_REVOKED' }
  if (input.killSwitch) return { allowed: false, code: 'RUNTIME_KILL_SWITCH' }
  const allowedPaths = input.allowedPaths ?? []
  if (allowedPaths.length && !allowedPaths.some(path => input.scope === path || input.scope.startsWith(`${path}/`))) return { allowed: false, code: 'WORKSPACE_PATH_NOT_ALLOWED' }
  if ((input.consentMode ?? 'PER_ACTION') === 'PER_ACTION' && !input.consentGranted) return { allowed: false, code: 'CONSENT_REQUIRED' }
  return { allowed: true, consentMode: input.consentMode ?? 'PER_ACTION' }
}

export async function checkRuntimeAction(input: { runtimeId: string; action: string; scope: string; userId: string }) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const device = await withTenantDbTransaction(prisma, tx => tx.runtimeDevice.findFirst({ where: { runtimeId: input.runtimeId, tenantId, userId: input.userId } }), tenantId)
  if (!device) throw new NotFoundError('RuntimeDevice', input.runtimeId)
  const policy = device.policyId ? await withTenantDbTransaction(prisma, tx => tx.runtimePolicy.findFirst({ where: { id: device.policyId!, tenantId } }), tenantId) : null
  const allowedPaths = Array.isArray(policy?.allowedPaths) ? policy!.allowedPaths.map(String) : []
  let consentGranted = false
  if (policy?.consentMode === 'PER_ACTION') {
    const consent = await withTenantDbTransaction(prisma, tx => tx.runtimeConsent.findFirst({ where: { tenantId, runtimeId: input.runtimeId, userId: input.userId, action: input.action, scope: input.scope, decision: 'ALLOW', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, orderBy: { createdAt: 'desc' } }), tenantId)
    consentGranted = Boolean(consent)
  }
  return { ...evaluateRuntimePolicy({ deviceStatus: device.status, revoked: Boolean(device.revokedAt), action: input.action, scope: input.scope, allowedPaths, killSwitch: policy?.killSwitch, consentMode: policy?.consentMode, consentGranted }), policyId: policy?.id ?? null }
}
