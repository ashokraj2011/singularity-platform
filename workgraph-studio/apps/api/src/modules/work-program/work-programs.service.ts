import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction, currentTenantIdForDb } from '../../lib/tenant-db-context'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { createWorkItem } from '../work-items/work-items.service'
import { routeWorkItem } from '../work-items/work-item-routing.service'
import { createWorkItemDependency } from '../work-items/work-item-dependencies.service'

type ProgramStepInput = {
  stepKey: string
  ordinal?: number
  titleTemplate: string
  descriptionTemplate?: string
  workItemTypeKey?: string
  targetCapabilityId: string
  workflowTemplateId?: string
  routingMode?: 'MANUAL' | 'AUTO_ATTACH' | 'AUTO_START' | 'SCHEDULED_START'
  inputMapping?: Record<string, unknown>
  dependsOnKeys?: string[]
}

function interpolate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => {
    const value = key.split('.').reduce<unknown>((current, part) => {
      return current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined
    }, input)
    return value == null ? '' : String(value)
  })
}

async function validateProgramStepTemplates(steps: ProgramStepInput[], tenantId: string) {
  const ids = [...new Set(steps.map(step => step.workflowTemplateId).filter((id): id is string => Boolean(id)))]
  if (ids.length === 0) return
  const templates = await withTenantDbTransaction(prisma, tx => tx.workflow.findMany({
    where: { id: { in: ids }, archivedAt: null, status: { not: 'ARCHIVED' }, profile: { not: 'workbench' } },
    select: { id: true, capabilityId: true },
  }), tenantId)
  const byId = new Map(templates.map(template => [template.id, template]))
  for (const step of steps) {
    if (!step.workflowTemplateId) continue
    const template = byId.get(step.workflowTemplateId)
    if (!template) throw new ValidationError(`Workflow template ${step.workflowTemplateId} is not available for Work Program execution`)
    if (template.capabilityId && template.capabilityId !== step.targetCapabilityId) {
      throw new ValidationError(`Work Program step ${step.stepKey} targets capability ${step.targetCapabilityId}, but its workflow belongs to ${template.capabilityId}`)
    }
  }
}

export async function createWorkProgram(input: {
  name: string
  description?: string
  capabilityId?: string
  metadata?: Record<string, unknown>
  status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'
  steps: ProgramStepInput[]
  createdById: string
}) {
  if (input.steps.length === 0) throw new ValidationError('A Work Program requires at least one step')
  const keys = new Set<string>()
  for (const step of input.steps) {
    if (keys.has(step.stepKey)) throw new ValidationError(`Duplicate program step key ${step.stepKey}`)
    keys.add(step.stepKey)
    for (const dependency of step.dependsOnKeys ?? []) {
      if (!keys.has(dependency) && !input.steps.some(candidate => candidate.stepKey === dependency)) {
        throw new ValidationError(`Program step ${step.stepKey} depends on unknown step ${dependency}`)
      }
    }
  }
  const tenantId = currentTenantIdForDb() ?? 'default'
  await validateProgramStepTemplates(input.steps, tenantId)
  return withTenantDbTransaction(prisma, tx => tx.workProgram.create({
    data: {
      name: input.name,
      description: input.description,
      capabilityId: input.capabilityId,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      createdById: input.createdById,
      status: input.status ?? 'DRAFT',
      tenantId,
      steps: {
        create: input.steps.map((step, index) => ({
          stepKey: step.stepKey,
          ordinal: step.ordinal ?? index,
          titleTemplate: step.titleTemplate,
          descriptionTemplate: step.descriptionTemplate,
          workItemTypeKey: step.workItemTypeKey ?? 'GENERAL',
          targetCapabilityId: step.targetCapabilityId,
          workflowTemplateId: step.workflowTemplateId,
          routingMode: step.routingMode ?? 'MANUAL',
          inputMapping: (step.inputMapping ?? {}) as Prisma.InputJsonValue,
          dependsOnKeys: (step.dependsOnKeys ?? []) as Prisma.InputJsonValue,
        })),
      },
    },
    include: { steps: { orderBy: { ordinal: 'asc' } } },
  }), tenantId)
}

export async function listWorkPrograms(createdById: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.workProgram.findMany({
    where: { tenantId, createdById },
    include: { steps: { orderBy: { ordinal: 'asc' } }, _count: { select: { runs: true } } },
    orderBy: { updatedAt: 'desc' },
  }), tenantId)
}

export async function getWorkProgram(id: string, createdById: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.workProgram.findFirst({
    where: { id, tenantId, createdById },
    include: { steps: { orderBy: { ordinal: 'asc' } }, runs: { orderBy: { startedAt: 'desc' }, take: 20 } },
  }), tenantId)
}

export async function updateWorkProgram(id: string, createdById: string, patch: {
  name?: string
  description?: string
  capabilityId?: string
  status?: string
  metadata?: Record<string, unknown>
  steps?: ProgramStepInput[]
}) {
  const existing = await getWorkProgram(id, createdById)
  if (!existing) throw new NotFoundError('WorkProgram', id)
  if (patch.steps && existing.runs.length > 0) throw new ValidationError('A Work Program with runs cannot replace its executable steps')
  if (patch.steps) {
    const keys = new Set<string>()
    for (const step of patch.steps) {
      if (keys.has(step.stepKey)) throw new ValidationError(`Duplicate program step key ${step.stepKey}`)
      keys.add(step.stepKey)
      for (const dependency of step.dependsOnKeys ?? []) if (!patch.steps.some(candidate => candidate.stepKey === dependency)) throw new ValidationError(`Program step ${step.stepKey} depends on unknown step ${dependency}`)
    }
  }
  const tenantId = currentTenantIdForDb() ?? 'default'
  if (patch.steps) await validateProgramStepTemplates(patch.steps, tenantId)
  return withTenantDbTransaction(prisma, tx => tx.workProgram.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.capabilityId !== undefined ? { capabilityId: patch.capabilityId } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata as Prisma.InputJsonValue } : {}),
      ...(patch.steps ? {
        steps: {
          deleteMany: {},
          create: patch.steps.map((step, index) => ({
            stepKey: step.stepKey,
            ordinal: step.ordinal ?? index,
            titleTemplate: step.titleTemplate,
            descriptionTemplate: step.descriptionTemplate,
            workItemTypeKey: step.workItemTypeKey ?? 'GENERAL',
            targetCapabilityId: step.targetCapabilityId,
            workflowTemplateId: step.workflowTemplateId,
            routingMode: step.routingMode ?? 'MANUAL',
            inputMapping: (step.inputMapping ?? {}) as Prisma.InputJsonValue,
            dependsOnKeys: (step.dependsOnKeys ?? []) as Prisma.InputJsonValue,
          })),
        },
      } : {}),
    },
    include: { steps: { orderBy: { ordinal: 'asc' } } },
  }), tenantId)
}

export async function executeWorkProgram(id: string, input: Record<string, unknown>, actorId: string) {
  const program = await getWorkProgram(id, actorId)
  if (!program) throw new NotFoundError('WorkProgram', id)
  if (program.status !== 'ACTIVE') throw new ValidationError(`Work Program must be ACTIVE before execution (current status: ${program.status})`)
  const tenantId = currentTenantIdForDb() ?? 'default'
  const run = await withTenantDbTransaction(prisma, tx => tx.workProgramRun.create({
    data: { programId: id, input: input as Prisma.InputJsonValue, startedById: actorId, tenantId },
  }), tenantId)
  const createdByKey = new Map<string, string>()
  const workItems: Array<{ id: string; workCode: string; stepKey: string }> = []
  const warnings: string[] = []
  for (const step of program.steps) {
    const mapping = (step.inputMapping ?? {}) as Record<string, unknown>
    const mappedInput = Object.fromEntries(Object.entries(mapping).map(([key, value]) => [
      key,
      typeof value === 'string' ? interpolate(value, input) : value,
    ]))
    const item = await createWorkItem({
      title: interpolate(step.titleTemplate, input),
      description: step.descriptionTemplate ? interpolate(step.descriptionTemplate, input) : undefined,
      parentCapabilityId: program.capabilityId ?? step.targetCapabilityId,
      workItemTypeKey: step.workItemTypeKey,
      routingMode: step.routingMode,
      workflowTypeKey: step.workItemTypeKey,
      input: mappedInput,
      details: { source: 'work-program', programId: id, runId: run.id, stepKey: step.stepKey, input: mappedInput },
      targets: [{ targetCapabilityId: step.targetCapabilityId, ...(step.workflowTemplateId ? { childWorkflowTemplateId: step.workflowTemplateId } : {}) }],
    }, actorId)
    createdByKey.set(step.stepKey, item.id)
    workItems.push({ id: item.id, workCode: item.workCode, stepKey: step.stepKey })
    await withTenantDbTransaction(prisma, tx => tx.workProgramRunStep.create({ data: { runId: run.id, stepId: step.id, workItemId: item.id } }), tenantId)
  }
  for (const step of program.steps) {
    const successorId = createdByKey.get(step.stepKey)
    if (!successorId) continue
    for (const dependencyKey of (step.dependsOnKeys as unknown as string[]) ?? []) {
      const predecessorId = createdByKey.get(dependencyKey)
      if (!predecessorId) continue
      await createWorkItemDependency({ predecessorId, successorId, createdById: actorId })
    }
  }
  for (const step of program.steps) {
    const itemId = createdByKey.get(step.stepKey)
    if (!itemId || (step.dependsOnKeys as unknown as string[]).length > 0) continue
    try {
      await routeWorkItem(itemId, actorId, {
        workflowId: step.workflowTemplateId ?? undefined,
        routingMode: step.routingMode,
        startNow: step.routingMode === 'AUTO_START',
      })
      await withTenantDbTransaction(prisma, tx => tx.workProgramRunStep.update({ where: { runId_stepId: { runId: run.id, stepId: step.id } }, data: { status: 'ROUTED', startedAt: new Date() } }), tenantId)
    } catch (err) {
      warnings.push(`${step.stepKey}: ${err instanceof Error ? err.message : String(err)}`)
      await withTenantDbTransaction(prisma, tx => tx.workProgramRunStep.update({ where: { runId_stepId: { runId: run.id, stepId: step.id } }, data: { status: 'BLOCKED', output: { error: String(err) } as Prisma.InputJsonValue } }), tenantId)
    }
  }
  return { run: await withTenantDbTransaction(prisma, tx => tx.workProgramRun.findUnique({ where: { id: run.id }, include: { steps: true } }), tenantId), workItems, warnings }
}

export async function getWorkProgramRun(programId: string, runId: string, actorId: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const program = await getWorkProgram(programId, actorId)
  if (!program) throw new NotFoundError('WorkProgram', programId)
  return withTenantDbTransaction(prisma, tx => tx.workProgramRun.findFirst({
    where: { id: runId, programId, tenantId },
    include: { steps: { include: { step: true, workItem: true } } },
  }), tenantId)
}

/** Keep program bookkeeping aligned with ordinary WorkItem lifecycle events. */
export async function markWorkProgramStepRouted(workItemId: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  return withTenantDbTransaction(prisma, tx => tx.workProgramRunStep.updateMany({
    where: { workItemId, status: { in: ['QUEUED', 'BLOCKED'] } },
    data: { status: 'ROUTED', startedAt: new Date() },
  }), tenantId)
}

export async function reconcileWorkProgramForWorkItem(workItemId: string) {
  const tenantId = currentTenantIdForDb() ?? 'default'
  const links = await withTenantDbTransaction(prisma, tx => tx.workProgramRunStep.findMany({
    where: { workItemId },
    select: { id: true, runId: true, run: { select: { steps: { select: { id: true, status: true } } } } },
  }), tenantId)
  for (const link of links) {
    await withTenantDbTransaction(prisma, tx => tx.workProgramRunStep.update({ where: { id: link.id }, data: { status: 'COMPLETED', completedAt: new Date() } }), tenantId)
    const allComplete = link.run.steps.every(step => step.id === link.id ? true : ['COMPLETED', 'SKIPPED'].includes(step.status))
    if (allComplete) await withTenantDbTransaction(prisma, tx => tx.workProgramRun.updateMany({ where: { id: link.runId, status: 'RUNNING' }, data: { status: 'COMPLETED', completedAt: new Date() } }), tenantId)
  }
  return links.length
}
