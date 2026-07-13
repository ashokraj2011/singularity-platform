import crypto from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { logEvent } from '../../lib/audit'
import { DIRECT_LLM_TOOL_REGISTRY } from './runtime/executors/direct-llm-tools'

export const LOOP_KINDS = ['SINGLE', 'PHASE', 'TOOL'] as const
export const LOOP_PHASES = ['PLAN', 'EXPLORE', 'ACT', 'VERIFY', 'SELF_REVIEW', 'REPAIR', 'FINALIZE'] as const
export const LOOP_FAILURE_MODES = ['REPAIR', 'REVIEW', 'BLOCK'] as const

export type LoopKind = typeof LOOP_KINDS[number]
export type LoopPhase = typeof LOOP_PHASES[number]
export type LoopFailureMode = typeof LOOP_FAILURE_MODES[number]

export type LoopStrategyDefinition = {
  kind: LoopKind
  phaseOrder: LoopPhase[]
  loopStageKey?: string
  loopAgentRole?: string
  promptProfileKey?: string
  maxTurns: number
  earlyStop: boolean
  validationFailure: LoopFailureMode
  maxRepairAttempts: number
  tools: string[]
}

export type LoopValidationFailure = { field: string; message: string }

export type LoopValidationResult = {
  ok: boolean
  definition: LoopStrategyDefinition
  failures: LoopValidationFailure[]
  warnings: string[]
  estimatedProviderCalls: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function integer(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase())
  return fallback
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isRecord(value)) return value
  return Object.keys(value).sort().reduce<Record<string, unknown>>((out, key) => {
    out[key] = canonicalize(value[key])
    return out
  }, {})
}

export function loopStrategyDigest(definition: LoopStrategyDefinition): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(definition))).digest('hex')
}

export function validateLoopStrategyDefinition(raw: unknown): LoopValidationResult {
  const input = isRecord(raw) ? raw : {}
  const failures: LoopValidationFailure[] = []
  const warnings: string[] = []
  const rawKind = String(input.kind ?? 'PHASE').trim().toUpperCase() as LoopKind
  const kind = LOOP_KINDS.includes(rawKind) ? rawKind : 'PHASE'
  if (!LOOP_KINDS.includes(rawKind)) failures.push({ field: 'kind', message: `must be one of ${LOOP_KINDS.join(', ')}.` })

  const rawPhases = Array.isArray(input.phaseOrder)
    ? input.phaseOrder
    : Array.isArray(input.loopPhases) ? input.loopPhases : []
  const phaseOrder = rawPhases.map(String).map(value => value.trim().toUpperCase()).filter(Boolean) as LoopPhase[]
  const unknownPhases = phaseOrder.filter(phase => !LOOP_PHASES.includes(phase))
  for (const phase of unknownPhases) failures.push({ field: 'phaseOrder', message: `unknown phase '${phase}'.` })
  const validPhases = phaseOrder.filter(phase => LOOP_PHASES.includes(phase))
  if (kind === 'PHASE' && validPhases.length === 0) failures.push({ field: 'phaseOrder', message: 'phase loops require at least one phase.' })
  if (new Set(validPhases).size !== validPhases.length) failures.push({ field: 'phaseOrder', message: 'phases must be unique.' })
  if (validPhases.includes('REPAIR') && validPhases[validPhases.length - 1] !== 'REPAIR') {
    warnings.push('REPAIR is normally injected after a validation failure; placing it in the normal phase order may cause an unnecessary repair turn.')
  }

  const maxTurns = integer(input.maxTurns, kind === 'SINGLE' ? 1 : Math.max(validPhases.length, 3))
  if (maxTurns < 1 || maxTurns > 12) failures.push({ field: 'maxTurns', message: 'must be between 1 and 12.' })
  const maxRepairAttempts = integer(input.maxRepairAttempts, 2)
  if (maxRepairAttempts < 0 || maxRepairAttempts > 3) failures.push({ field: 'maxRepairAttempts', message: 'must be between 0 and 3.' })
  const validationFailure = String(input.validationFailure ?? 'REPAIR').trim().toUpperCase() as LoopFailureMode
  if (!LOOP_FAILURE_MODES.includes(validationFailure)) failures.push({ field: 'validationFailure', message: `must be one of ${LOOP_FAILURE_MODES.join(', ')}.` })
  const tools = Array.from(new Set((Array.isArray(input.tools) ? input.tools : []).map(String).map(value => value.trim()).filter(Boolean)))
  const unknownTools = tools.filter(tool => !DIRECT_LLM_TOOL_REGISTRY[tool])
  for (const tool of unknownTools) failures.push({ field: 'tools', message: `tool '${tool}' is not in the read-only direct LLM allowlist.` })
  if (kind === 'TOOL' && tools.length === 0) failures.push({ field: 'tools', message: 'tool loops require at least one registered read-only tool.' })
  if (kind !== 'TOOL' && tools.length > 0) warnings.push('Selected tools are ignored unless the strategy kind is TOOL.')

  const normalized: LoopStrategyDefinition = {
    kind,
    phaseOrder: kind === 'PHASE' ? validPhases : [],
    loopStageKey: text(input.loopStageKey) ?? 'loop.stage',
    loopAgentRole: text(input.loopAgentRole),
    promptProfileKey: text(input.promptProfileKey),
    maxTurns: kind === 'SINGLE' ? 1 : Math.min(Math.max(maxTurns, 1), 12),
    earlyStop: kind === 'SINGLE' ? false : bool(input.earlyStop, true),
    validationFailure: LOOP_FAILURE_MODES.includes(validationFailure) ? validationFailure : 'REPAIR',
    maxRepairAttempts: kind === 'TOOL' ? 0 : Math.min(Math.max(maxRepairAttempts, 0), 3),
    tools: kind === 'TOOL' ? tools.filter(tool => !unknownTools.includes(tool)) : [],
  }
  const repairBudget = normalized.validationFailure === 'REPAIR' ? normalized.maxRepairAttempts : 0
  const estimatedProviderCalls = kind === 'SINGLE'
    ? 1
    : kind === 'TOOL'
      ? normalized.maxTurns
      : Math.min(normalized.maxTurns, normalized.phaseOrder.length + repairBudget)
  return { ok: failures.length === 0, definition: normalized, failures, warnings, estimatedProviderCalls }
}

function tenantId(override?: string): string {
  return override ?? currentTenantIdForDb() ?? 'default'
}

function tenantWhere(scope: string) {
  return { OR: [{ tenantId: scope }, { tenantId: null }] }
}

async function ownStrategy(id: string, includeSystem = true, tenantScope?: string) {
  const scope = tenantId(tenantScope)
  const strategy = await withTenantDbTransaction(prisma, tx => tx.loopStrategy.findFirst({
    where: { id, ...(includeSystem ? tenantWhere(scope) : { tenantId: scope }) },
    include: { versions: { orderBy: { version: 'desc' } } },
  }), scope)
  if (!strategy) throw new NotFoundError('LoopStrategy', id)
  return strategy
}

export async function listLoopStrategies(kind?: string) {
  const scope = tenantId()
  // The public picker scopes this library to Direct LLM strategies with
  // `kind=DIRECT_LLM_TASK`; the stored strategy kind remains SINGLE/PHASE/TOOL.
  const storedKind = kind && kind.toUpperCase() !== 'DIRECT_LLM_TASK' ? kind.toUpperCase() : undefined
  const rows = await withTenantDbTransaction(prisma, tx => tx.loopStrategy.findMany({
    where: { ...tenantWhere(scope), ...(storedKind ? { kind: storedKind } : {}), status: { not: 'ARCHIVED' } },
    include: { versions: { orderBy: { version: 'desc' }, take: 25 } },
    orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
  }), scope)
  return rows.map(row => ({
    ...row,
    latestVersion: row.versions[0] ?? null,
    latestPublishedVersion: row.versions.find(version => Boolean(version.publishedAt)) ?? null,
    versions: undefined,
  }))
}

export async function getLoopStrategy(id: string) {
  const strategy = await ownStrategy(id)
  return { ...strategy, systemProvided: strategy.tenantId === null }
}

export async function resolveLoopStrategyVersion(id: string, version: number, tenantScope?: string) {
  const strategy = await ownStrategy(id, true, tenantScope)
  const row = strategy.versions.find(item => item.version === version)
  if (!row) throw new NotFoundError('LoopStrategyVersion', `${id}@${version}`)
  // A published version remains valid while a newer draft is being prepared.
  // The strategy status describes the current revision; the pinned version's
  // own publication timestamp is the authoritative runtime gate.
  if (!row.publishedAt) throw new ValidationError('Loop strategy version is not published')
  return { strategy, version: row }
}

export async function createLoopStrategy(input: {
  name: string
  description?: string
  kind?: string
  definition: unknown
  actorId: string
  publish?: boolean
}) {
  const scope = tenantId()
  const validation = validateLoopStrategyDefinition(input.definition)
  if (!validation.ok) throw new ValidationError(`Invalid loop strategy: ${validation.failures.map(item => `${item.field}: ${item.message}`).join('; ')}`)
  const created = await withTenantDbTransaction(prisma, async tx => {
    const strategy = await tx.loopStrategy.create({
      data: {
        tenantId: scope,
        name: input.name.trim(),
        description: input.description?.trim() || undefined,
        kind: validation.definition.kind,
        createdById: input.actorId,
        versions: { create: {
          tenantId: scope,
          version: 1,
          definition: validation.definition as unknown as Prisma.InputJsonValue,
          contentHash: loopStrategyDigest(validation.definition),
          createdById: input.actorId,
          ...(input.publish ? { publishedAt: new Date() } : {}),
        } },
        ...(input.publish ? { status: 'PUBLISHED' } : {}),
      },
      include: { versions: true },
    })
    return strategy
  }, scope)
  await logEvent('LoopStrategyCreated', 'LoopStrategy', created.id, input.actorId, { kind: created.kind, version: 1, published: Boolean(input.publish) }).catch(() => undefined)
  return { strategy: created, validation }
}

export async function updateLoopStrategy(id: string, input: { name?: string; description?: string; actorId: string }) {
  const scope = tenantId()
  const existing = await ownStrategy(id, false)
  const updated = await withTenantDbTransaction(prisma, tx => tx.loopStrategy.update({
    where: { id: existing.id },
    data: { name: input.name?.trim(), description: input.description?.trim() },
  }), scope)
  await logEvent('LoopStrategyUpdated', 'LoopStrategy', id, input.actorId, {}).catch(() => undefined)
  return updated
}

export async function createLoopStrategyVersion(id: string, input: { definition: unknown; actorId: string; publish?: boolean }) {
  const scope = tenantId()
  const existing = await ownStrategy(id, false)
  if (existing.status === 'ARCHIVED') throw new ValidationError('Archived loop strategies cannot receive new versions')
  const validation = validateLoopStrategyDefinition(input.definition)
  if (!validation.ok) throw new ValidationError(`Invalid loop strategy: ${validation.failures.map(item => `${item.field}: ${item.message}`).join('; ')}`)
  const nextVersion = existing.currentVersion + 1
  const result = await withTenantDbTransaction(prisma, async tx => {
    const version = await tx.loopStrategyVersion.create({
      data: {
        strategyId: existing.id,
        tenantId: scope,
        version: nextVersion,
        definition: validation.definition as unknown as Prisma.InputJsonValue,
        contentHash: loopStrategyDigest(validation.definition),
        createdById: input.actorId,
        ...(input.publish ? { publishedAt: new Date() } : {}),
      },
    })
    const strategy = await tx.loopStrategy.update({
      where: { id: existing.id },
      data: { currentVersion: nextVersion, kind: validation.definition.kind, ...(input.publish ? { status: 'PUBLISHED' } : { status: 'DRAFT' }) },
    })
    return { strategy, version }
  }, scope)
  await logEvent('LoopStrategyVersionCreated', 'LoopStrategy', id, input.actorId, { version: nextVersion, published: Boolean(input.publish) }).catch(() => undefined)
  return { ...result, validation }
}

export async function publishLoopStrategy(id: string, version: number | undefined, actorId: string) {
  const scope = tenantId()
  const existing = await ownStrategy(id, false)
  const targetVersion = version ?? existing.currentVersion
  if (targetVersion !== existing.currentVersion) throw new ValidationError('Only the current loop strategy version can be published')
  const result = await withTenantDbTransaction(prisma, async tx => {
    const row = await tx.loopStrategyVersion.findFirst({ where: { strategyId: id, tenantId: scope, version: targetVersion } })
    if (!row) throw new NotFoundError('LoopStrategyVersion', `${id}@${targetVersion}`)
    const publishedAt = new Date()
    await tx.loopStrategyVersion.update({ where: { id: row.id }, data: { publishedAt } })
    return tx.loopStrategy.update({ where: { id }, data: { status: 'PUBLISHED' } })
  }, scope)
  await logEvent('LoopStrategyPublished', 'LoopStrategy', id, actorId, { version: targetVersion }).catch(() => undefined)
  return result
}

export function directLlmToolCatalog() {
  return Object.values(DIRECT_LLM_TOOL_REGISTRY).map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    readOnly: true,
  }))
}
