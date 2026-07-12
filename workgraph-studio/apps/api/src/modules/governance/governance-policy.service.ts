import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction, currentTenantIdForDb } from '../../lib/tenant-db-context'
import { NotFoundError, ValidationError } from '../../lib/errors'

type JsonRecord = Record<string, unknown>
type PolicyRule = { key: string; label?: string; evidencePath?: string; required?: boolean; severity?: string }

const MODES = new Set(['ADVISORY', 'REQUIRED', 'BLOCKING'])

function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue }
function record(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {} }
function rules(value: unknown): PolicyRule[] {
  return Array.isArray(value) ? value.filter((row): row is PolicyRule => Boolean(row && typeof row === 'object' && !Array.isArray(row) && typeof (row as Record<string, unknown>).key === 'string')).map(row => row as PolicyRule) : []
}
function readPath(root: JsonRecord, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as JsonRecord)[key] : undefined, root)
}
function satisfied(evidence: JsonRecord, rule: PolicyRule): boolean {
  const path = rule.evidencePath ?? rule.key
  const value = readPath(evidence, path) ?? evidence[rule.key]
  for (const key of ['_satisfiedEvidence', 'satisfiedEvidence', '_governanceEvidence', 'governanceEvidence']) {
    if (Array.isArray(evidence[key]) && evidence[key].map(String).includes(rule.key)) return true
  }
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.length > 0
  return value !== undefined && value !== null && String(value).trim().length > 0
}

export function evaluatePolicyRules(mode: string, policyRules: PolicyRule[], evidence: JsonRecord) {
  const normalizedMode = validatePolicyMode(mode)
  const checks = policyRules.map(rule => ({ key: rule.key, label: rule.label ?? rule.key, satisfied: satisfied(evidence, rule), required: rule.required !== false, severity: rule.severity ?? 'ERROR' }))
  const missing = checks.filter(check => check.required && !check.satisfied).map(check => check.key)
  const status = missing.length === 0 ? 'PASSED' : normalizedMode === 'ADVISORY' ? 'WARNED' : 'BLOCKED'
  return { mode: normalizedMode, status, checks, missing }
}

export function validatePolicyMode(mode: string): string {
  const normalized = mode.toUpperCase()
  if (!MODES.has(normalized)) throw new ValidationError('Governance mode must be ADVISORY, REQUIRED, or BLOCKING')
  return normalized
}

export async function listGovernancePolicies() {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.governancePolicy.findMany({ where: { tenantId }, orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }] }), tenantId)
}

export async function getGovernancePolicy(id: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const policy = await withTenantDbTransaction(prisma, tx => tx.governancePolicy.findFirst({ where: { id, tenantId } }), tenantId)
  if (!policy) throw new NotFoundError('GovernancePolicy', id)
  const versions = await withTenantDbTransaction(prisma, tx => tx.governancePolicyVersion.findMany({ where: { policyId: id, tenantId }, orderBy: { version: 'desc' } }), tenantId)
  return { policy, versions }
}

export async function createGovernancePolicy(input: {
  name: string; description?: string; capabilityId?: string; workflowId?: string; workItemTypeKey?: string; mode: string; rules: PolicyRule[]; actorId: string
}) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const mode = validatePolicyMode(input.mode)
  if (input.rules.length === 0) throw new ValidationError('At least one governance rule is required')
  return withTenantDbTransaction(prisma, async tx => {
    const policy = await tx.governancePolicy.create({ data: { tenantId, name: input.name, description: input.description, capabilityId: input.capabilityId, workflowId: input.workflowId, workItemTypeKey: input.workItemTypeKey, mode, createdById: input.actorId } })
    const version = await tx.governancePolicyVersion.create({ data: { policyId: policy.id, tenantId, version: 1, mode, rules: json(input.rules), snapshot: json({ name: input.name, description: input.description, capabilityId: input.capabilityId, workflowId: input.workflowId, workItemTypeKey: input.workItemTypeKey }), createdById: input.actorId } })
    return { policy, version }
  }, tenantId)
}

export async function updateGovernancePolicy(id: string, input: { name?: string; description?: string; capabilityId?: string | null; workflowId?: string | null; workItemTypeKey?: string | null; mode?: string; rules?: PolicyRule[]; actorId: string }) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const existing = await withTenantDbTransaction(prisma, tx => tx.governancePolicy.findFirst({ where: { id, tenantId } }), tenantId)
  if (!existing) throw new NotFoundError('GovernancePolicy', id)
  const mode = input.mode ? validatePolicyMode(input.mode) : existing.mode
  const current = await withTenantDbTransaction(prisma, tx => tx.governancePolicyVersion.findFirst({ where: { policyId: id, version: existing.currentVersion, tenantId } }), tenantId)
  const nextVersion = existing.currentVersion + 1
  const nextRules = input.rules ?? rules(current?.rules)
  if (nextRules.length === 0) throw new ValidationError('At least one governance rule is required')
  return withTenantDbTransaction(prisma, async tx => {
    const policy = await tx.governancePolicy.update({ where: { id }, data: { name: input.name, description: input.description, capabilityId: input.capabilityId, workflowId: input.workflowId, workItemTypeKey: input.workItemTypeKey, mode, currentVersion: nextVersion, status: existing.status === 'ACTIVE' ? 'DRAFT' : existing.status } })
    const version = await tx.governancePolicyVersion.create({ data: { policyId: id, tenantId, version: nextVersion, mode, rules: json(nextRules), snapshot: json({ name: policy.name, description: policy.description, capabilityId: policy.capabilityId, workflowId: policy.workflowId, workItemTypeKey: policy.workItemTypeKey }), createdById: input.actorId } })
    return { policy, version }
  }, tenantId)
}

export async function activateGovernancePolicy(id: string, actorId: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const existing = await withTenantDbTransaction(prisma, tx => tx.governancePolicy.findFirst({ where: { id, tenantId } }), tenantId)
  if (!existing) throw new NotFoundError('GovernancePolicy', id)
  return withTenantDbTransaction(prisma, async tx => {
    await tx.governancePolicy.update({ where: { id }, data: { status: 'ACTIVE' } })
    await tx.governancePolicyVersion.updateMany({ where: { policyId: id, version: existing.currentVersion, tenantId }, data: { activatedAt: new Date(), createdById: actorId } })
    return tx.governancePolicy.findUnique({ where: { id } })
  }, tenantId)
}

export async function evaluateGovernancePolicy(args: {
  policyId: string; evidence: JsonRecord; actorId: string; instanceId?: string; nodeId?: string; workItemId?: string
}) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const policy = await withTenantDbTransaction(prisma, tx => tx.governancePolicy.findFirst({ where: { id: args.policyId, tenantId, status: 'ACTIVE' } }), tenantId)
  if (!policy) throw new NotFoundError('ActiveGovernancePolicy', args.policyId)
  const version = await withTenantDbTransaction(prisma, tx => tx.governancePolicyVersion.findFirst({ where: { policyId: policy.id, tenantId, version: policy.currentVersion } }), tenantId)
  if (!version) throw new ValidationError('Active governance policy has no version snapshot')
  const evaluated = evaluatePolicyRules(policy.mode, rules(version.rules), args.evidence)
  const { checks, missing, status } = evaluated
  const result = { policyId: policy.id, version: version.version, mode: policy.mode, status, checks, missing, evaluatedAt: new Date().toISOString() }
  const evaluation = await withTenantDbTransaction(prisma, tx => tx.governancePolicyEvaluation.create({ data: { policyId: policy.id, policyVersion: version.version, tenantId, instanceId: args.instanceId, nodeId: args.nodeId, workItemId: args.workItemId, mode: policy.mode, status, evidence: json(args.evidence), missing: json(missing), result: json(result), evaluatedById: args.actorId } }), tenantId)
  return { policy, version, evaluation, result }
}

export async function evaluateActiveGovernancePolicies(args: {
  capabilityId?: string; workflowId?: string; workItemTypeKey?: string; evidence: JsonRecord; actorId: string; instanceId?: string; nodeId?: string; workItemId?: string
}) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const policies = await withTenantDbTransaction(prisma, tx => tx.governancePolicy.findMany({ where: { tenantId, status: 'ACTIVE', OR: [
    ...(args.capabilityId ? [{ capabilityId: args.capabilityId }] : []),
    ...(args.workflowId ? [{ workflowId: args.workflowId }] : []),
    ...(args.workItemTypeKey ? [{ workItemTypeKey: args.workItemTypeKey }] : []),
    { capabilityId: null, workflowId: null, workItemTypeKey: null },
  ] }, orderBy: { updatedAt: 'desc' } }), tenantId)
  const results = []
  for (const policy of policies) results.push(await evaluateGovernancePolicy({ policyId: policy.id, evidence: args.evidence, actorId: args.actorId, instanceId: args.instanceId, nodeId: args.nodeId, workItemId: args.workItemId }))
  return { results, blocked: results.filter(item => item.result.status === 'BLOCKED'), warned: results.filter(item => item.result.status === 'WARNED') }
}

export async function governanceCoverage() {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const [policies, evaluations] = await Promise.all([
    withTenantDbTransaction(prisma, tx => tx.governancePolicy.findMany({ where: { tenantId }, select: { mode: true, status: true, capabilityId: true, workflowId: true } }), tenantId),
    withTenantDbTransaction(prisma, tx => tx.governancePolicyEvaluation.findMany({ where: { tenantId }, select: { status: true, policyId: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1000 }), tenantId),
  ])
  return { policyCount: policies.length, activeCount: policies.filter(policy => policy.status === 'ACTIVE').length, byMode: { advisory: policies.filter(policy => policy.mode === 'ADVISORY').length, required: policies.filter(policy => policy.mode === 'REQUIRED').length, blocking: policies.filter(policy => policy.mode === 'BLOCKING').length }, evaluations: { total: evaluations.length, passed: evaluations.filter(row => row.status === 'PASSED').length, warned: evaluations.filter(row => row.status === 'WARNED').length, blocked: evaluations.filter(row => row.status === 'BLOCKED').length }, uncoveredScopes: policies.filter(policy => !policy.capabilityId && !policy.workflowId).length }
}
