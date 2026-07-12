import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction, currentTenantIdForDb } from '../../lib/tenant-db-context'
import { NotFoundError, ValidationError } from '../../lib/errors'

type JsonRecord = Record<string, unknown>
function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue }

export function calculateVerificationRiskScore(result: JsonRecord, findings: Array<{ severity: string }>): number {
  const tests = result.tests && typeof result.tests === 'object' ? result.tests as JsonRecord : {}
  const failed = Number(tests.failed ?? result.failedTests ?? 0)
  const changed = Array.isArray(result.changedFiles) ? result.changedFiles.length : 0
  const critical = findings.filter(f => ['CRITICAL', 'HIGH'].includes(f.severity.toUpperCase())).length
  return Math.min(100, Math.max(0, failed * 20 + critical * 15 + Math.min(20, changed) + (result.coverageRegression === true ? 20 : 0)))
}

export async function requestIndependentVerification(input: { instanceId?: string; nodeId?: string; workItemId?: string; commitSha?: string; environment?: string; command: string; actorId: string }) {
  const command = input.command.trim()
  if (!command) throw new ValidationError('Verification command is required')
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.independentVerification.create({ data: { tenantId, instanceId: input.instanceId, nodeId: input.nodeId, workItemId: input.workItemId, commitSha: input.commitSha, environment: input.environment, command, requestedById: input.actorId, status: 'REQUESTED' } }), tenantId)
}

export async function startIndependentVerification(id: string, actorId: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const existing = await withTenantDbTransaction(prisma, tx => tx.independentVerification.findFirst({ where: { id, tenantId } }), tenantId)
  if (!existing) throw new NotFoundError('IndependentVerification', id)
  return withTenantDbTransaction(prisma, tx => tx.independentVerification.update({ where: { id }, data: { status: 'RUNNING', startedAt: new Date(), requestedById: actorId } }), tenantId)
}

export async function completeIndependentVerification(id: string, actorId: string, input: { status: 'PASSED' | 'FAILED' | 'CANCELLED'; result?: JsonRecord; testSummary?: JsonRecord; coverage?: JsonRecord; findings?: Array<{ filePath?: string; ruleKey?: string; severity?: string; message: string; evidence?: JsonRecord }> }) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const existing = await withTenantDbTransaction(prisma, tx => tx.independentVerification.findFirst({ where: { id, tenantId } }), tenantId)
  if (!existing) throw new NotFoundError('IndependentVerification', id)
  const findings = input.findings ?? []
  const result = input.result ?? {}
  const score = calculateVerificationRiskScore(result, findings.map(finding => ({ severity: finding.severity ?? 'INFO' })))
  return withTenantDbTransaction(prisma, async tx => {
    const verification = await tx.independentVerification.update({ where: { id }, data: { status: input.status, result: json(result), testSummary: json(input.testSummary ?? {}), coverage: json(input.coverage ?? {}), riskScore: score, completedAt: new Date(), requestedById: actorId } })
    if (findings.length) await tx.verificationFinding.createMany({ data: findings.map(finding => ({ verificationId: id, tenantId, filePath: finding.filePath, ruleKey: finding.ruleKey, severity: finding.severity ?? 'INFO', message: finding.message, evidence: json(finding.evidence ?? {}) })) })
    return verification
  }, tenantId)
}

export async function getIndependentVerification(id: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const verification = await withTenantDbTransaction(prisma, tx => tx.independentVerification.findFirst({ where: { id, tenantId } }), tenantId)
  if (!verification) throw new NotFoundError('IndependentVerification', id)
  const findings = await withTenantDbTransaction(prisma, tx => tx.verificationFinding.findMany({ where: { verificationId: id, tenantId }, orderBy: { createdAt: 'asc' } }), tenantId)
  return { verification, findings }
}

export async function listIndependentVerifications(instanceId?: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.independentVerification.findMany({ where: { tenantId, ...(instanceId ? { instanceId } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 }), tenantId)
}

export async function recordGroundingEvidence(input: { instanceId?: string; nodeId?: string; agentRunId?: string; sourceType: string; sourceUri?: string; contentHash?: string; influenceScore?: number; outcome?: string; feedback?: JsonRecord }) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.groundingEvidence.create({ data: { tenantId, instanceId: input.instanceId, nodeId: input.nodeId, agentRunId: input.agentRunId, sourceType: input.sourceType, sourceUri: input.sourceUri, contentHash: input.contentHash, influenceScore: input.influenceScore, outcome: input.outcome, feedback: json(input.feedback ?? {}) } }), tenantId)
}

export async function listGroundingEvidence(instanceId?: string, nodeId?: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.groundingEvidence.findMany({ where: { tenantId, ...(instanceId ? { instanceId } : {}), ...(nodeId ? { nodeId } : {}) }, orderBy: { retrievedAt: 'desc' }, take: 500 }), tenantId)
}

export async function recordCodeImpact(input: { instanceId?: string; nodeId?: string; workItemId?: string; commitSha?: string; query?: string; provider?: string; files?: unknown[]; callGraph?: JsonRecord; matches?: unknown[]; riskScore?: number; actorId: string }) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.codeImpactSnapshot.create({ data: { tenantId, instanceId: input.instanceId, nodeId: input.nodeId, workItemId: input.workItemId, commitSha: input.commitSha, query: input.query, provider: input.provider ?? 'LEXICAL', files: json(input.files ?? []), callGraph: json(input.callGraph ?? {}), matches: json(input.matches ?? []), riskScore: input.riskScore, createdById: input.actorId } }), tenantId)
}

export async function listCodeImpact(instanceId?: string, commitSha?: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.codeImpactSnapshot.findMany({ where: { tenantId, ...(instanceId ? { instanceId } : {}), ...(commitSha ? { commitSha } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 }), tenantId)
}
