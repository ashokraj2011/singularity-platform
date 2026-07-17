import { createHash, randomUUID } from 'node:crypto'
import { Router, type Request } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors'
import { currentTenantIdForDb, withTenantDbTransaction } from '../../lib/tenant-db-context'
import { resolveTenantFromRequest } from '../../lib/tenant-isolation'
import { assertCanViewWorkItem, assertCanMutateWorkItem, createWorkItem, startWorkItemTarget, type CreateWorkItemInput } from './work-items.service'
import { finalizeWorkItem } from './work-item-finalizer.service'
import { logEvent, publishOutbox } from '../../lib/audit'
import { emptySpecificationPackageBody, specificationPackageBodySchema } from '../specifications/specification.schemas'
import { specificationContentHash } from '../specifications/specification.hash'
import { validateSpecificationBody } from '../specifications/specification.validator'
import { registerSubmission } from '../submissions/submissions.service'
import { registerSubmissionSchema } from '../submissions/submission.schemas'
import { startReconciliation } from '../reconciliations/reconciliations.service'
import { requestSpecificationReview } from '../specifications/specification-review.service'
import { scheduleGenerationPlan } from '../planning/generation-scheduler'

export const contractBoundRouter: Router = Router()

const bindingSchema = z.object({
  specificationVersionId: z.string().uuid(),
  resolvedPackage: z.record(z.unknown()).optional(),
  requirementIds: z.array(z.string().min(1)).default([]),
})

const scopeSchema = z.object({
  workItemTargetId: z.string().uuid(),
  specificationBindingId: z.string().uuid().optional(),
  targetCapabilityId: z.string().min(1),
  repository: z.string().min(1),
  component: z.string().optional(),
  requirementIds: z.array(z.string().min(1)).default([]),
  mandatory: z.boolean().default(true),
})

const handoffSchema = z.object({
  specificationBindingId: z.string().uuid().optional(),
  repository: z.string().min(1),
  component: z.string().optional(),
  baseBranch: z.string().min(1),
  baseCommitSha: z.string().min(1),
  requirementIds: z.array(z.string().min(1)).default([]),
  requiredEvidence: z.array(z.unknown()).default([]),
  forbiddenPaths: z.array(z.string()).default([]),
  reconciliationPolicy: z.record(z.unknown()).default({}),
})

const specificationCreateSchema = z.object({
  code: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  mission: z.string().optional(),
})

const specificationVersionSchema = z.object({
  package: z.record(z.unknown()).default({}),
  basedOnVersionId: z.string().uuid().optional(),
})

const planRowSchema = z.object({
  rowKey: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  targetCapabilityId: z.string().min(1),
  childWorkflowTemplateId: z.string().uuid().optional(),
  repository: z.string().min(1).optional(),
  component: z.string().min(1).optional(),
  baseBranch: z.string().min(1).optional(),
  baseCommitSha: z.string().min(1).optional(),
  requirementIds: z.array(z.string()).default([]),
  decisionRefs: z.array(z.string().uuid()).default([]),
  claimRefs: z.array(z.string().uuid()).default([]),
  requiredEvidence: z.array(z.unknown()).default([]),
  forbiddenPaths: z.array(z.string()).default([]),
  reconciliationPolicy: z.record(z.unknown()).default({}),
  dependencies: z.array(z.object({ rowKey: z.string().min(1), dependencyType: z.string().optional() })).default([]),
  estimatedHours: z.number().positive().default(8),
  rateBand: z.string().trim().min(1).max(80).optional(),
  estimatedCostLow: z.number().nonnegative().optional(),
  estimatedCostHigh: z.number().nonnegative().optional(),
  estimatedTokens: z.number().int().nonnegative().optional(),
})

const planSchema = z.object({
  specificationProjectId: z.string().uuid(),
  specificationVersionId: z.string().uuid().optional(),
  requestId: z.string().optional(),
  rows: z.array(planRowSchema).min(1),
})

const reviewSchema = z.object({
  versionId: z.string().uuid().optional(),
  assignedToId: z.string().uuid().optional(),
  assignmentMode: z.enum(['DIRECT_USER', 'TEAM_QUEUE', 'ROLE_BASED', 'SKILL_BASED']).optional(),
  teamId: z.string().uuid().optional(),
  roleKey: z.string().optional(),
  skillKey: z.string().optional(),
  capabilityId: z.string().min(1).optional(),
  dueAt: z.string().datetime().optional(),
  quorumRequired: z.coerce.number().int().min(1).max(100).optional(),
  adminOverride: z.boolean().optional(),
  comment: z.string().trim().max(4000).optional(),
})

const workflowStartCommandSchema = z.object({
  workItemTargetId: z.string().uuid(),
  childWorkflowTemplateId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(8).max(200),
  vars: z.record(z.unknown()).optional(),
  globals: z.record(z.unknown()).optional(),
  params: z.record(z.unknown()).optional(),
})

function tenantOf(req: Request): string {
  return resolveTenantFromRequest(req) ?? currentTenantIdForDb() ?? 'default'
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function loadVisibleWorkItem(workItemId: string, userId: string) {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    include: { targets: true },
  })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  await assertCanViewWorkItem(userId, workItem)
  return workItem
}

contractBoundRouter.get('/work-items/:workItemId/specification-bindings', async (req, res, next) => {
  try {
    await loadVisibleWorkItem(String(req.params.workItemId), req.user!.userId)
    const items = await prisma.workItemSpecificationBinding.findMany({
      where: { workItemId: String(req.params.workItemId) },
      orderBy: { bindingGeneration: 'desc' },
    })
    res.json({ items })
  } catch (err) { next(err) }
})

contractBoundRouter.post('/work-items/:workItemId/specification-bindings', validate(bindingSchema), async (req, res, next) => {
  try {
    const workItemId = String(req.params.workItemId)
    const workItem = await loadVisibleWorkItem(workItemId, req.user!.userId)
    await assertCanMutateWorkItem(req.user!.userId, workItem, 'edit')
    const input = req.body as z.infer<typeof bindingSchema>
    const version = await prisma.specificationVersion.findUnique({ where: { id: input.specificationVersionId } })
    if (!version || (version.workItemId !== workItemId && version.specificationProjectId !== workItem.projectId)) {
      throw new ValidationError('Specification version must belong to the WorkItem or its specification project')
    }
    if (!['APPROVED', 'LOCKED', 'ACTIVE'].includes(String(version.status))) throw new ConflictError('Only an approved or locked specification can be bound')
    const parsed = specificationPackageBodySchema.safeParse(input.resolvedPackage ?? version.package)
    if (!parsed.success) throw new ValidationError('Specification package is invalid and cannot be bound')
    const resolvedPackage = parsed.data as unknown as Prisma.InputJsonValue
    const resolvedContentHash = specificationContentHash(parsed.data)
    const result = await withTenantDbTransaction(prisma, async tx => {
      const latest = await tx.workItemSpecificationBinding.findFirst({ where: { workItemId }, orderBy: { bindingGeneration: 'desc' }, select: { bindingGeneration: true } })
      const generation = (latest?.bindingGeneration ?? 0) + 1
      await tx.workItemSpecificationBinding.updateMany({ where: { workItemId, status: 'CURRENT' }, data: { status: 'SUPERSEDED' } })
      const binding = await tx.workItemSpecificationBinding.create({
        data: {
          workItemId,
          specificationVersionId: version.id,
          bindingGeneration: generation,
          resolvedPackage,
          resolvedContentHash,
          requirementIds: input.requirementIds as Prisma.InputJsonValue,
          boundById: req.user!.userId,
          tenantId: workItem.tenantId,
        },
      })
      await tx.workItemEvent.create({ data: { workItemId, actorId: req.user!.userId, eventType: 'SPECIFICATION_BOUND', tenantId: workItem.tenantId, payload: { bindingId: binding.id, generation, specificationVersionId: version.id, resolvedContentHash } as Prisma.InputJsonValue } })
      return binding
    }, tenantOf(req))
    await logEvent('SpecificationBound', 'WorkItem', workItemId, req.user!.userId, { bindingId: result.id, generation: result.bindingGeneration })
    res.status(201).json(result)
  } catch (err) { next(err) }
})

contractBoundRouter.get('/work-items/:workItemId/development-scopes', async (req, res, next) => {
  try {
    await loadVisibleWorkItem(String(req.params.workItemId), req.user!.userId)
    res.json({ items: await prisma.developmentScope.findMany({ where: { workItemId: String(req.params.workItemId) }, include: { workItemTarget: true, currentHandoffGeneration: true }, orderBy: { createdAt: 'asc' } }) })
  } catch (err) { next(err) }
})

contractBoundRouter.post('/work-items/:workItemId/development-scopes', validate(scopeSchema), async (req, res, next) => {
  try {
    const workItemId = String(req.params.workItemId)
    const workItem = await loadVisibleWorkItem(workItemId, req.user!.userId)
    await assertCanMutateWorkItem(req.user!.userId, workItem, 'edit')
    const input = req.body as z.infer<typeof scopeSchema>
    const target = workItem.targets.find(row => row.id === input.workItemTargetId)
    if (!target) throw new NotFoundError('WorkItemTarget', input.workItemTargetId)
    if (target.targetCapabilityId !== input.targetCapabilityId) throw new ValidationError('DevelopmentScope capability must match its WorkItem target')
    if (input.specificationBindingId) {
      const binding = await prisma.workItemSpecificationBinding.findFirst({ where: { id: input.specificationBindingId, workItemId, status: 'CURRENT' } })
      if (!binding) throw new ValidationError('DevelopmentScope binding is missing or no longer current')
    }
    const scope = await prisma.developmentScope.create({ data: { workItemId, workItemTargetId: input.workItemTargetId, specificationBindingId: input.specificationBindingId, targetCapabilityId: input.targetCapabilityId, repository: input.repository, component: input.component, requirementIds: input.requirementIds as Prisma.InputJsonValue, mandatory: input.mandatory, tenantId: workItem.tenantId } })
    res.status(201).json(scope)
  } catch (err) { next(err) }
})

contractBoundRouter.get('/development-scopes/:scopeId/handoffs', async (req, res, next) => {
  try {
    const scope = await prisma.developmentScope.findUnique({ where: { id: String(req.params.scopeId) } })
    if (!scope) throw new NotFoundError('DevelopmentScope', String(req.params.scopeId))
    await loadVisibleWorkItem(scope.workItemId, req.user!.userId)
    res.json({ items: await prisma.handoffGeneration.findMany({ where: { developmentScopeId: scope.id }, orderBy: { generation: 'desc' } }) })
  } catch (err) { next(err) }
})

contractBoundRouter.post('/development-scopes/:scopeId/handoffs', validate(handoffSchema), async (req, res, next) => {
  try {
    const scope = await prisma.developmentScope.findUnique({ where: { id: String(req.params.scopeId) } })
    if (!scope) throw new NotFoundError('DevelopmentScope', String(req.params.scopeId))
    const workItem = await loadVisibleWorkItem(scope.workItemId, req.user!.userId)
    await assertCanMutateWorkItem(req.user!.userId, workItem, 'edit')
    const input = req.body as z.infer<typeof handoffSchema>
    if (input.specificationBindingId && input.specificationBindingId !== scope.specificationBindingId) {
      throw new ValidationError('Handoff binding must match the DevelopmentScope current binding')
    }
    const generation = ((await prisma.handoffGeneration.findFirst({ where: { developmentScopeId: scope.id }, orderBy: { generation: 'desc' }, select: { generation: true } }))?.generation ?? 0) + 1
    const content = { ...input, generation, scopeId: scope.id }
    const handoff = await prisma.handoffGeneration.create({ data: { developmentScopeId: scope.id, generation, specificationBindingId: input.specificationBindingId ?? scope.specificationBindingId, repository: input.repository, component: input.component, baseBranch: input.baseBranch, baseCommitSha: input.baseCommitSha, requirementIds: input.requirementIds as Prisma.InputJsonValue, requiredEvidence: input.requiredEvidence as Prisma.InputJsonValue, forbiddenPaths: input.forbiddenPaths as Prisma.InputJsonValue, reconciliationPolicy: input.reconciliationPolicy as Prisma.InputJsonValue, contentHash: digest(content), tenantId: workItem.tenantId } })
    res.status(201).json(handoff)
  } catch (err) { next(err) }
})

contractBoundRouter.post('/handoffs/:handoffId/publish', async (req, res, next) => {
  try {
    const handoffId = String(req.params.handoffId)
    const handoff = await prisma.handoffGeneration.findUnique({ where: { id: handoffId }, include: { developmentScope: true } })
    if (!handoff) throw new NotFoundError('HandoffGeneration', handoffId)
    const workItem = await loadVisibleWorkItem(handoff.developmentScope.workItemId, req.user!.userId)
    await assertCanMutateWorkItem(req.user!.userId, workItem, 'edit')
    const result = await withTenantDbTransaction(prisma, async tx => {
      await tx.handoffGeneration.updateMany({ where: { developmentScopeId: handoff.developmentScopeId, status: 'PUBLISHED', id: { not: handoffId } }, data: { status: 'SUPERSEDED' } })
      const published = await tx.handoffGeneration.updateMany({ where: { id: handoffId, status: 'DRAFT' }, data: { status: 'PUBLISHED', publishedById: req.user!.userId, publishedAt: new Date() } })
      if (published.count !== 1) throw new ConflictError('Handoff is no longer a draft')
      await tx.developmentScope.update({ where: { id: handoff.developmentScopeId }, data: { status: 'HANDOFF_PUBLISHED', currentHandoffGenerationId: handoffId } })
      await tx.workItemEvent.create({ data: { workItemId: workItem.id, actorId: req.user!.userId, eventType: 'HANDOFF_PUBLISHED', tenantId: workItem.tenantId, payload: { handoffGenerationId: handoffId, generation: handoff.generation } as Prisma.InputJsonValue } })
      return tx.handoffGeneration.findUniqueOrThrow({ where: { id: handoffId } })
    }, tenantOf(req))
    res.json(result)
  } catch (err) { next(err) }
})

contractBoundRouter.post('/work-items/:workItemId/finalize', async (req, res, next) => {
  try {
    const workItem = await loadVisibleWorkItem(String(req.params.workItemId), req.user!.userId)
    await assertCanMutateWorkItem(req.user!.userId, workItem, 'finalize')
    const body = z.object({ approvalDecision: z.string().optional(), expectedGeneration: z.number().int().nonnegative().optional(), reason: z.string().optional() }).parse(req.body ?? {})
    res.json(await finalizeWorkItem(workItem.id, req.user!.userId, body))
  } catch (err) { next(err) }
})

contractBoundRouter.get('/specifications', async (req, res, next) => {
  try {
    const tenantId = tenantOf(req)
    res.json({ items: await prisma.specificationProject.findMany({ where: { tenantId }, orderBy: { updatedAt: 'desc' } }) })
  } catch (err) { next(err) }
})

contractBoundRouter.post('/specifications', validate(specificationCreateSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof specificationCreateSchema>
    const tenantId = tenantOf(req)
    const project = await prisma.specificationProject.create({
      data: {
        id: randomUUID(),
        code: input.code,
        name: input.name,
        mission: input.mission,
        createdById: req.user!.userId,
        tenantId,
        specification: {
          create: {
            package: emptySpecificationPackageBody() as unknown as Prisma.InputJsonValue,
            updatedById: req.user!.userId,
            tenantId,
          },
        },
      },
    })
    res.status(201).json(project)
  } catch (err) { next(err) }
})

contractBoundRouter.get('/specifications/:specificationId/versions', async (req, res, next) => {
  try {
    const specificationId = String(req.params.specificationId)
    const project = await prisma.specificationProject.findFirst({ where: { id: specificationId, tenantId: tenantOf(req) } })
    if (!project) throw new NotFoundError('SpecificationProject', specificationId)
    res.json({ items: await prisma.specificationVersion.findMany({ where: { specificationProjectId: specificationId }, orderBy: { version: 'desc' } }) })
  } catch (err) { next(err) }
})

contractBoundRouter.post('/specifications/:specificationId/versions', validate(specificationVersionSchema), async (req, res, next) => {
  try {
    const specificationId = String(req.params.specificationId)
    const project = await prisma.specificationProject.findFirst({ where: { id: specificationId, tenantId: tenantOf(req) } })
    if (!project) throw new NotFoundError('SpecificationProject', specificationId)
    const input = req.body as z.infer<typeof specificationVersionSchema>
    const parsed = specificationPackageBodySchema.safeParse(input.package)
    if (!parsed.success) throw new ValidationError('Specification version package is invalid')
    if (input.basedOnVersionId) {
      const base = await prisma.specificationVersion.findFirst({ where: { id: input.basedOnVersionId, specificationProjectId: specificationId, tenantId: tenantOf(req) }, select: { id: true } })
      if (!base) throw new ValidationError('basedOnVersionId must belong to the same specification project')
    }
    const latest = await prisma.specificationVersion.findFirst({ where: { specificationProjectId: specificationId }, orderBy: { version: 'desc' }, select: { version: true } })
    const version = await prisma.specificationVersion.create({ data: { specificationProjectId: specificationId, version: (latest?.version ?? 0) + 1, package: parsed.data as unknown as Prisma.InputJsonValue, contentHash: specificationContentHash(parsed.data), supersedesId: input.basedOnVersionId, createdById: req.user!.userId, tenantId: project.tenantId } })
    res.status(201).json(version)
  } catch (err) { next(err) }
})

contractBoundRouter.get('/specifications/:specificationId/reviews', async (req, res, next) => {
  try {
    const specificationId = String(req.params.specificationId)
    const project = await prisma.specificationProject.findFirst({ where: { id: specificationId, tenantId: tenantOf(req) } })
    if (!project) throw new NotFoundError('SpecificationProject', specificationId)
    const versions = await prisma.specificationVersion.findMany({ where: { specificationProjectId: specificationId }, select: { id: true } })
    res.json({ items: await prisma.approvalRequest.findMany({ where: { subjectType: 'SpecificationVersion', subjectId: { in: versions.map(version => version.id) }, tenantId: tenantOf(req) }, orderBy: { createdAt: 'desc' } }) })
  } catch (err) { next(err) }
})

contractBoundRouter.post('/specifications/:specificationId/reviews', validate(reviewSchema), async (req, res, next) => {
  try {
    const specificationId = String(req.params.specificationId)
    const project = await prisma.specificationProject.findFirst({ where: { id: specificationId, tenantId: tenantOf(req) } })
    if (!project) throw new NotFoundError('SpecificationProject', specificationId)
    const versionId = typeof req.body.versionId === 'string' ? req.body.versionId : (await prisma.specificationVersion.findFirst({ where: { specificationProjectId: specificationId }, orderBy: { version: 'desc' }, select: { id: true } }))?.id
    if (!versionId) throw new ValidationError('A specification version is required for review')
    const version = await prisma.specificationVersion.findFirst({ where: { id: versionId, specificationProjectId: specificationId, tenantId: tenantOf(req) }, select: { id: true } })
    if (!version) throw new NotFoundError('SpecificationVersion', versionId)
    const review = await requestSpecificationReview(
      version.id,
      { ...req.body, dueAt: req.body.dueAt ? new Date(req.body.dueAt) : undefined },
      req.user!.userId,
      tenantOf(req),
    )
    res.status(201).json(review)
  } catch (err) { next(err) }
})

contractBoundRouter.post('/specifications/:specificationId/versions/:versionId/lock', async (req, res, next) => {
  try {
    const projectId = String(req.params.specificationId)
    const versionId = String(req.params.versionId)
    const project = await prisma.specificationProject.findFirst({ where: { id: projectId, tenantId: tenantOf(req) } })
    if (!project) throw new NotFoundError('SpecificationProject', projectId)
    const version = await prisma.specificationVersion.findFirst({ where: { id: versionId, specificationProjectId: projectId } })
    if (!version) throw new NotFoundError('SpecificationVersion', versionId)
    if (!['DRAFT', 'CHANGE_REQUESTED', 'CHANGES_REQUESTED'].includes(String(version.status))) throw new ConflictError(`Specification version is ${version.status} and cannot be locked`)
    const parsed = specificationPackageBodySchema.safeParse(version.package)
    if (!parsed.success) throw new ValidationError('Specification package is malformed')
    const validation = validateSpecificationBody(parsed.data)
    if (!validation.passed) throw new ValidationError(`Specification has ${validation.errorCount} blocking issue(s) and cannot be locked`)
    const locked = await withTenantDbTransaction(prisma, async tx => {
      const updated = await tx.specificationVersion.update({ where: { id: versionId }, data: { status: 'LOCKED', contentHash: specificationContentHash(parsed.data) } })
      await tx.specificationProject.update({ where: { id: projectId }, data: { status: 'LOCKED' } })
      return updated
    }, tenantOf(req))
    res.json(locked)
  } catch (err) { next(err) }
})

contractBoundRouter.get('/work-items/:workItemId/finalization', async (req, res, next) => {
  try {
    await loadVisibleWorkItem(String(req.params.workItemId), req.user!.userId)
    res.json({ items: await prisma.workItemFinalizationRecord.findMany({ where: { workItemId: String(req.params.workItemId) }, orderBy: { createdAt: 'desc' } }) })
  } catch (err) { next(err) }
})

contractBoundRouter.post('/handoffs/:handoffId/submissions', async (req, res, next) => {
  try {
    const handoff = await prisma.handoffGeneration.findUnique({ where: { id: String(req.params.handoffId) }, include: { developmentScope: true } })
    if (!handoff) throw new NotFoundError('HandoffGeneration', String(req.params.handoffId))
    const workItem = await loadVisibleWorkItem(handoff.developmentScope.workItemId, req.user!.userId)
    await assertCanMutateWorkItem(req.user!.userId, workItem, 'submit')
    const parsed = registerSubmissionSchema.parse({ ...(req.body ?? {}), source: req.body?.source ?? 'API' })
    const result = await registerSubmission(
      handoff.developmentScope.workItemId,
      parsed,
      req.user!.userId,
      { developmentScopeId: handoff.developmentScopeId, handoffGenerationId: handoff.id },
    )
    res.status(result.alreadyRegistered ? 200 : 201).json(result)
  } catch (err) { next(err) }
})

contractBoundRouter.post('/submissions/:submissionId/reconciliations', async (req, res, next) => {
  try {
    const submission = await prisma.implementationSubmission.findUnique({ where: { id: String(req.params.submissionId) } })
    if (!submission) throw new NotFoundError('ImplementationSubmission', String(req.params.submissionId))
    const workItem = await loadVisibleWorkItem(submission.workItemId, req.user!.userId)
    await assertCanMutateWorkItem(req.user!.userId, workItem, 'reconcile')
    const mode = z.enum(['DETERMINISTIC', 'DYNAMIC', 'SEMANTIC']).catch('DETERMINISTIC').parse(req.body?.mode)
    res.status(201).json(await startReconciliation(submission.workItemId, submission.id, req.user!.userId, mode))
  } catch (err) { next(err) }
})

contractBoundRouter.post('/workflow-start-commands', validate(workflowStartCommandSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof workflowStartCommandSchema>
    const target = await prisma.workItemTarget.findUnique({ where: { id: input.workItemTargetId }, select: { workItemId: true } })
    if (!target) throw new NotFoundError('WorkItemTarget', input.workItemTargetId)
    const workItem = await loadVisibleWorkItem(target.workItemId, req.user!.userId)
    await assertCanMutateWorkItem(req.user!.userId, workItem, 'start')
    res.json(await startWorkItemTarget(target.workItemId, input.workItemTargetId, req.user!.userId, input))
  } catch (err) { next(err) }
})

contractBoundRouter.get('/generation-plans', async (req, res, next) => {
  try {
    const projectId = typeof req.query.specificationProjectId === 'string' ? req.query.specificationProjectId : undefined
    if (!projectId) throw new ValidationError('specificationProjectId query parameter is required')
    const project = await prisma.specificationProject.findFirst({ where: { id: projectId, tenantId: tenantOf(req) }, select: { id: true } })
    if (!project) throw new NotFoundError('SpecificationProject', projectId)
    res.json({ items: await prisma.generationPlan.findMany({ where: { specificationProjectId: projectId, tenantId: tenantOf(req) }, include: { rows: true }, orderBy: { updatedAt: 'desc' } }) })
  } catch (err) { next(err) }
})

contractBoundRouter.get('/generation-plans/:planId', async (req, res, next) => {
  try {
    const plan = await prisma.generationPlan.findFirst({ where: { id: String(req.params.planId), tenantId: tenantOf(req) }, include: { rows: true } })
    if (!plan) throw new NotFoundError('GenerationPlan', String(req.params.planId))
    res.json(plan)
  } catch (err) { next(err) }
})

contractBoundRouter.post('/generation-plans', validate(planSchema), async (req, res, next) => {
  try {
    const input = req.body as z.infer<typeof planSchema>
    const project = await prisma.specificationProject.findFirst({ where: { id: input.specificationProjectId, tenantId: tenantOf(req) } })
    if (!project) throw new NotFoundError('SpecificationProject', input.specificationProjectId)
    const keys = new Set<string>()
    for (const row of input.rows) {
      if (keys.has(row.rowKey)) throw new ValidationError(`Duplicate generation plan row ${row.rowKey}`)
      keys.add(row.rowKey)
      if (input.specificationVersionId && (!row.repository || !row.baseBranch || !row.baseCommitSha)) {
        throw new ValidationError(`Generation plan row ${row.rowKey} requires repository, baseBranch, and baseCommitSha when a specification version is selected`)
      }
      for (const dependency of row.dependencies) if (!input.rows.some(candidate => candidate.rowKey === dependency.rowKey)) throw new ValidationError(`Unknown generation plan dependency ${dependency.rowKey}`)
    }
    if (input.specificationVersionId) {
      const version = await prisma.specificationVersion.findFirst({ where: { id: input.specificationVersionId, specificationProjectId: project.id, tenantId: tenantOf(req) } })
      if (!version) throw new NotFoundError('SpecificationVersion', input.specificationVersionId)
      if (!['LOCKED', 'ACTIVE', 'APPROVED'].includes(String(version.status))) throw new ConflictError('Generation requires a locked or approved specification version')
    }
    const plan = await prisma.generationPlan.create({ data: { specificationProjectId: project.id, specificationVersionId: input.specificationVersionId, requestId: input.requestId, contentHash: digest(input.rows), totalRows: input.rows.length, createdById: req.user!.userId, tenantId: project.tenantId, rows: { create: input.rows.map(row => ({ rowKey: row.rowKey, title: row.title, description: row.description, targetCapabilityId: row.targetCapabilityId, childWorkflowTemplateId: row.childWorkflowTemplateId, repository: row.repository, component: row.component, baseBranch: row.baseBranch, baseCommitSha: row.baseCommitSha, requirementIds: row.requirementIds as Prisma.InputJsonValue, decisionRefs: row.decisionRefs as Prisma.InputJsonValue, claimRefs: row.claimRefs as Prisma.InputJsonValue, requiredEvidence: row.requiredEvidence as Prisma.InputJsonValue, forbiddenPaths: row.forbiddenPaths as Prisma.InputJsonValue, reconciliationPolicy: row.reconciliationPolicy as Prisma.InputJsonValue, dependencies: row.dependencies as unknown as Prisma.InputJsonValue, estimatedHours: row.estimatedHours, rateBand: row.rateBand, estimatedCostLow: row.estimatedCostLow, estimatedCostHigh: row.estimatedCostHigh, estimatedTokens: row.estimatedTokens })) } }, include: { rows: true } })
    res.status(201).json(plan)
  } catch (err) { next(err) }
})

contractBoundRouter.post('/generation-plans/:planId/validate', async (req, res, next) => {
  try {
    const plan = await prisma.generationPlan.findFirst({ where: { id: String(req.params.planId), tenantId: tenantOf(req) }, include: { rows: true, specificationProject: { include: { budgetEnvelope: true } }, specificationVersion: true } })
    if (!plan) throw new NotFoundError('GenerationPlan', String(req.params.planId))
    const rowKeys = new Set(plan.rows.map(row => row.rowKey))
    const errors: string[] = []
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (key: string) => {
      if (visiting.has(key)) { errors.push(`Dependency cycle includes ${key}`); return }
      if (visited.has(key)) return
      visiting.add(key)
      const row = plan.rows.find(candidate => candidate.rowKey === key)
      for (const dependency of (row?.dependencies as Array<{ rowKey?: string }> ?? [])) {
        if (!dependency.rowKey || !rowKeys.has(dependency.rowKey)) errors.push(`Unknown dependency in ${key}`)
        else visit(dependency.rowKey)
      }
      visiting.delete(key); visited.add(key)
    }
    for (const row of plan.rows) visit(row.rowKey)
    const acceptedDecisions = await prisma.decisionDossier.findMany({ where: { projectId: plan.specificationProjectId, status: 'ACCEPTED', tenantId: tenantOf(req) }, select: { id: true } })
    const acceptedDecisionIds = new Set(acceptedDecisions.map(decision => decision.id))
    const projectClaims = await prisma.claim.findMany({ where: { projectId: plan.specificationProjectId, tenantId: tenantOf(req) }, select: { id: true } })
    const projectClaimIds = new Set(projectClaims.map(claim => claim.id))
    for (const row of plan.rows) {
      const decisionRefs = Array.isArray(row.decisionRefs) ? row.decisionRefs.map(String) : []
      const claimRefs = Array.isArray(row.claimRefs) ? row.claimRefs.map(String) : []
      for (const decisionRef of decisionRefs) if (!acceptedDecisionIds.has(decisionRef)) errors.push(`Row ${row.rowKey} references a decision that is not accepted: ${decisionRef}`)
      for (const claimRef of claimRefs) if (!projectClaimIds.has(claimRef)) errors.push(`Row ${row.rowKey} references a claim outside this initiative: ${claimRef}`)
      if ((row.estimatedCostLow ?? 0) > (row.estimatedCostHigh ?? Number.POSITIVE_INFINITY)) errors.push(`Row ${row.rowKey} cost range is inverted`)
    }
    if (plan.specificationVersion) {
      const parsed = specificationPackageBodySchema.safeParse(plan.specificationVersion.package)
      if (!parsed.success) errors.push('The selected specification version is malformed')
      else {
        const covered = new Set(plan.rows.flatMap(row => Array.isArray(row.requirementIds) ? row.requirementIds.map(String) : []))
        for (const requirement of parsed.data.requirements) if (!covered.has(requirement.id)) errors.push(`Requirement ${requirement.id} is not covered by any generation plan row`)
      }
    }
    const estimatedCostHigh = plan.rows.reduce((sum, row) => sum + (row.estimatedCostHigh ?? row.estimatedCostLow ?? 0), 0)
    const estimatedTokens = plan.rows.reduce((sum, row) => sum + (row.estimatedTokens ?? 0), 0)
    const envelope = plan.specificationProject.budgetEnvelope
    const budgetHigh = envelope?.budgetHigh ?? plan.specificationProject.costBudgetUsd
    const tokenLimit = envelope?.tokenLimit ?? plan.specificationProject.tokenBudget
    const warningPercent = envelope?.warningPercent ?? 80
    const hardCapPercent = envelope?.hardCapPercent ?? 120
    const warnings: string[] = []
    const waiverReason = typeof req.body?.budgetWaiverReason === 'string' ? req.body.budgetWaiverReason.trim() : ''
    const costPercent = budgetHigh ? estimatedCostHigh / budgetHigh * 100 : 0
    const tokenPercent = tokenLimit ? estimatedTokens / tokenLimit * 100 : 0
    const highestPercent = Math.max(costPercent, tokenPercent)
    if (highestPercent >= hardCapPercent) errors.push(`Plan exceeds the ${hardCapPercent}% hard budget cap`)
    else if (highestPercent > 100 && waiverReason.length < 20) errors.push('Plan exceeds its budget envelope; a DRI waiver reason of at least 20 characters is required')
    else if (highestPercent >= warningPercent) warnings.push(`Plan consumes ${highestPercent.toFixed(1)}% of its budget envelope`)
    const startAt = typeof req.body?.startAt === 'string' ? new Date(req.body.startAt) : new Date()
    if (Number.isNaN(startAt.getTime())) throw new ValidationError('startAt must be a valid ISO timestamp')
    const schedule = errors.some(error => error.startsWith('Dependency cycle')) ? [] : scheduleGenerationPlan(plan.rows.map(row => ({
      rowKey: row.rowKey,
      estimatedHours: row.estimatedHours ?? 8,
      dependencies: (Array.isArray(row.dependencies) ? row.dependencies : []).map(dependency => ({ rowKey: String((dependency as Record<string, unknown>).rowKey ?? '') })),
    })), { startAt })
    await Promise.all(schedule.map(item => prisma.generationPlanRow.update({ where: { planId_rowKey: { planId: plan.id, rowKey: item.rowKey } }, data: { projectedStartAt: item.projectedStartAt, projectedFinishAt: item.projectedFinishAt, criticalPath: item.criticalPath } })))
    const status = errors.length ? 'DRAFT' : 'VALIDATED'
    const validation = { valid: errors.length === 0, errors, warnings, waiverReason: waiverReason || null, estimatedCostHigh, estimatedTokens, costPercent, tokenPercent, schedule }
    const updated = await prisma.generationPlan.update({ where: { id: plan.id }, data: { status: status as any, validation: validation as unknown as Prisma.InputJsonValue }, include: { rows: true } })
    if (errors.length) res.status(422).json({ ...updated, errors, warnings })
    else res.json({ ...updated, errors: [], warnings })
  } catch (err) { next(err) }
})

contractBoundRouter.post('/generation-plans/:planId/apply', async (req, res, next) => {
  try {
    const plan = await prisma.generationPlan.findFirst({ where: { id: String(req.params.planId), tenantId: tenantOf(req) }, include: { rows: true, specificationProject: true, specificationVersion: true } })
    if (!plan) throw new NotFoundError('GenerationPlan', String(req.params.planId))
    if (plan.status !== 'VALIDATED' && plan.status !== 'PARTIAL') throw new ConflictError('Generation plan must be validated before apply')
    const byKey = new Map<string, string>()
    let applied = 0
    for (const row of plan.rows) {
      if (row.workItemId) { byKey.set(row.rowKey, row.workItemId); continue }
      try {
        const input: CreateWorkItemInput = {
          title: row.title,
          description: row.description ?? undefined,
          originType: 'SPEC_GENERATED',
          projectId: plan.specificationProjectId,
          parentCapabilityId: row.targetCapabilityId,
          workItemTypeKey: 'SPEC_GENERATED',
          routingMode: 'MANUAL',
          dueAt: row.projectedFinishAt,
          details: {
            title: row.title,
            description: row.description,
            generationPlanId: plan.id,
            generationPlanRowId: row.id,
            rowKey: row.rowKey,
            requirementIds: row.requirementIds,
            decisionRefs: row.decisionRefs,
            claimRefs: row.claimRefs,
            projectedStartAt: row.projectedStartAt?.toISOString(),
            projectedFinishAt: row.projectedFinishAt?.toISOString(),
            criticalPath: row.criticalPath,
            estimatedHours: row.estimatedHours,
            estimatedCostLow: row.estimatedCostLow,
            estimatedCostHigh: row.estimatedCostHigh,
            estimatedTokens: row.estimatedTokens,
          },
          tenantId: plan.tenantId,
          idempotencyKey: `generation-plan:${plan.id}:${row.rowKey}`,
          targets: [{ targetCapabilityId: row.targetCapabilityId, childWorkflowTemplateId: row.childWorkflowTemplateId ?? undefined }],
        }
        const created = await createWorkItem(input, req.user!.userId)
        const createdTarget = created.targets[0]
        if (!createdTarget) throw new ValidationError(`Generation plan row ${row.rowKey} did not create a WorkItem target`)

        let binding = await prisma.workItemSpecificationBinding.findFirst({ where: { workItemId: created.id, status: 'CURRENT' }, orderBy: { bindingGeneration: 'desc' } })
        if (plan.specificationVersion && !binding) {
          const parsed = specificationPackageBodySchema.safeParse(plan.specificationVersion.package)
          if (!parsed.success) throw new ValidationError(`Specification version ${plan.specificationVersion.id} is malformed and cannot be bound`)
          const latestBinding = await prisma.workItemSpecificationBinding.findFirst({ where: { workItemId: created.id }, orderBy: { bindingGeneration: 'desc' }, select: { bindingGeneration: true } })
          binding = await prisma.workItemSpecificationBinding.create({ data: { workItemId: created.id, specificationVersionId: plan.specificationVersion.id, bindingGeneration: (latestBinding?.bindingGeneration ?? 0) + 1, resolvedPackage: parsed.data as unknown as Prisma.InputJsonValue, resolvedContentHash: specificationContentHash(parsed.data), requirementIds: row.requirementIds as Prisma.InputJsonValue, boundById: req.user!.userId, tenantId: plan.tenantId } })
          await prisma.workItemEvent.create({ data: { workItemId: created.id, actorId: req.user!.userId, eventType: 'SPECIFICATION_BOUND', tenantId: plan.tenantId, payload: { bindingId: binding.id, generation: binding.bindingGeneration, specificationVersionId: plan.specificationVersion.id, generatedByPlanId: plan.id } as Prisma.InputJsonValue } })
        }
        if (plan.specificationVersion && row.repository && row.baseBranch && row.baseCommitSha) {
          const existingScope = await prisma.developmentScope.findFirst({ where: { workItemId: created.id, workItemTargetId: createdTarget.id } })
          const scope = existingScope ?? await prisma.developmentScope.create({ data: { workItemId: created.id, workItemTargetId: createdTarget.id, specificationBindingId: binding?.id, targetCapabilityId: row.targetCapabilityId, repository: row.repository, component: row.component, requirementIds: row.requirementIds as Prisma.InputJsonValue, mandatory: true, tenantId: plan.tenantId } })
          const existingHandoff = await prisma.handoffGeneration.findFirst({ where: { developmentScopeId: scope.id }, orderBy: { generation: 'desc' } })
          if (!existingHandoff) {
            const policy = row.reconciliationPolicy && typeof row.reconciliationPolicy === 'object' && !Array.isArray(row.reconciliationPolicy) ? row.reconciliationPolicy as Record<string, unknown> : {}
            const reconciliationPolicy = { ...policy, claimRefs: row.claimRefs, decisionRefs: row.decisionRefs }
            const handoffContent = { scopeId: scope.id, repository: row.repository, component: row.component, baseBranch: row.baseBranch, baseCommitSha: row.baseCommitSha, requirementIds: row.requirementIds, requiredEvidence: row.requiredEvidence, forbiddenPaths: row.forbiddenPaths, reconciliationPolicy }
            await prisma.handoffGeneration.create({ data: { developmentScopeId: scope.id, specificationBindingId: binding?.id, repository: row.repository, component: row.component, baseBranch: row.baseBranch, baseCommitSha: row.baseCommitSha, requirementIds: row.requirementIds as Prisma.InputJsonValue, requiredEvidence: row.requiredEvidence as Prisma.InputJsonValue, forbiddenPaths: row.forbiddenPaths as Prisma.InputJsonValue, reconciliationPolicy: reconciliationPolicy as Prisma.InputJsonValue, contentHash: digest(handoffContent), tenantId: plan.tenantId } })
          }
        }
        byKey.set(row.rowKey, created.id)
        await prisma.generationPlanRow.update({ where: { id: row.id }, data: { workItemId: created.id, state: 'APPLIED', error: null } })
        applied += 1
      } catch (error) {
        await prisma.generationPlanRow.update({ where: { id: row.id }, data: { state: 'FAILED', error: String(error) } })
      }
    }
    for (const row of plan.rows) {
      const successorId = byKey.get(row.rowKey)
      if (!successorId) continue
      for (const dependency of (row.dependencies as Array<{ rowKey?: string; dependencyType?: string }> ?? [])) {
        const predecessorId = byKey.get(String(dependency.rowKey))
        if (!predecessorId) continue
        await prisma.workItemDependency.upsert({ where: { predecessorId_successorId: { predecessorId, successorId } }, update: {}, create: { predecessorId, successorId, dependencyType: dependency.dependencyType ?? 'BLOCKS', createdById: req.user!.userId, tenantId: plan.tenantId } })
      }
    }
    const status = applied === plan.rows.length ? 'APPLIED' : applied > 0 ? 'PARTIAL' : 'FAILED'
    const updated = await prisma.generationPlan.update({ where: { id: plan.id }, data: { status: status as any, appliedRows: { increment: applied } }, include: { rows: true } })
    res.json({ ...updated, applied })
  } catch (err) { next(err) }
})
