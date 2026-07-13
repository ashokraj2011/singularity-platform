import { Prisma } from '@prisma/client'
import { traceIdFromParts } from '@workgraph/shared-types'
import { prisma } from '../../lib/prisma'
import { withTenantDbTransaction } from '../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../lib/audit'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { contextFabricClient } from '../../lib/context-fabric/client'
import type { SpecificationPackage, SpecificationPackageBody } from './specification.schemas'
import { validateSpecificationBody, type SpecValidationResult } from './specification.validator'
import { createSpecificationDraft, updateSpecificationDraft } from './specifications.service'
import {
  specGenerationSystemPrompt,
  buildGenerationTask,
  buildRepairTask,
  parseGeneratedSpec,
  type SpecGenDocument,
  type WorkItemContext,
} from './spec-generation'

/** The single model call the generator needs — injectable so the orchestration is unit-testable. */
export interface SpecGenLlm {
  complete(input: { system: string; task: string; traceId: string; actorId: string; workItemId: string; workCode: string; temperature: number }): Promise<string>
}

// Default: route through Context Fabric's governed single-turn, same as the planner.
export const defaultSpecGenLlm: SpecGenLlm = {
  async complete({ system, task, traceId, actorId, workItemId, workCode, temperature }) {
    const res = await contextFabricClient.executeGovernedTurn({
      trace_id: traceId,
      run_context: {
        work_item_id: workItemId,
        work_item_code: workCode,
        capability_id: process.env.SPEC_GEN_CAPABILITY_ID ?? 'spec-author',
        user_id: actorId,
        surface: 'spec-generation',
      },
      system_prompt: system,
      task,
      model_overrides: { temperature, maxOutputTokens: 4000 },
      limits: { outputTokenBudget: 4000, timeoutSec: 180 },
    })
    return res.finalResponse ?? ''
  },
}

export interface GenerateSpecInput {
  prompt: string
  documents?: SpecGenDocument[]
  basedOnVersionId?: string
}

export interface GeneratedBody {
  body: SpecificationPackageBody
  validation: SpecValidationResult
  repaired: boolean
  attempts: number
}

/**
 * Prompt → body, with two guard passes and NO DB: one JSON re-ask on a parse failure, and one
 * repair pass when the deterministic validator finds blocking errors. Pure aside from the injected
 * LLM, so it is unit-testable with a fake. Throws only if the model never returns parseable JSON.
 */
export async function generateSpecBody(ctx: WorkItemContext, input: GenerateSpecInput, actorId: string, workItemId: string, llm: SpecGenLlm): Promise<GeneratedBody> {
  const system = specGenerationSystemPrompt()
  const task = buildGenerationTask(ctx, input.prompt, input.documents)
  const base = { system, traceId: traceIdFromParts(['spec-gen', workItemId], ':'), actorId, workItemId, workCode: ctx.workCode }

  let attempts = 1
  let parsed = parseGeneratedSpec(await llm.complete({ ...base, task, temperature: 0.2 }))
  if (!parsed.ok) {
    // One re-ask at temperature 0 with the parse error surfaced.
    attempts++
    parsed = parseGeneratedSpec(await llm.complete({ ...base, task: `${task}\n\nYour previous answer was not valid JSON (${parsed.error}). Return STRICT JSON only.`, temperature: 0 }))
  }
  if (!parsed.ok) {
    throw new ValidationError(`The model did not return a parseable specification (${parsed.error}). Try refining the request.`)
  }

  let body = parsed.body
  let validation = validateSpecificationBody(body)
  let repaired = false
  if (!validation.passed) {
    // One repair pass — feed the blocking checks back and re-parse; keep whichever we can parse.
    attempts++
    const repair = parseGeneratedSpec(await llm.complete({ ...base, task: buildRepairTask(task, validation), temperature: 0 }))
    if (repair.ok) {
      body = repair.body
      validation = validateSpecificationBody(body)
      repaired = true
    }
  }
  return { body, validation, repaired, attempts }
}

/**
 * Generate a spec body from a prompt/documents and persist it as a new DRAFT version (spec §2).
 * Reuses the create + optimistic-concurrency update path so the draft is indistinguishable from a
 * hand-authored one, then stamps a SPEC_GENERATED event on the Work Item timeline.
 */
export async function generateSpecificationDraft(
  workItemId: string,
  input: GenerateSpecInput,
  actorId: string,
  llm: SpecGenLlm = defaultSpecGenLlm,
): Promise<{ specification: SpecificationPackage; validation: SpecValidationResult; repaired: boolean }> {
  if (!input.prompt?.trim()) throw new ValidationError('A prompt is required to generate a specification.')
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    select: { id: true, workCode: true, title: true, description: true, tenantId: true },
  })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)

  const ctx: WorkItemContext = { workCode: workItem.workCode, title: workItem.title ?? workItem.workCode, description: workItem.description }
  const { body, validation, repaired } = await generateSpecBody(ctx, input, actorId, workItemId, llm)

  // Persist through the existing draft path: create (revision 1) → apply the generated body.
  const created = await createSpecificationDraft(workItemId, input.basedOnVersionId ? { basedOnVersionId: input.basedOnVersionId } : {}, actorId)
  const versionId = created.version.id
  const specification = await updateSpecificationDraft(workItemId, versionId, { expectedRevision: created.version.revision, body }, actorId)

  const payload = { specificationVersionId: versionId, version: specification.version.number, repaired, requirementCount: body.requirements.length, passed: validation.passed }
  await withTenantDbTransaction(prisma, (tx) => tx.workItemEvent.create({
    data: { workItemId, eventType: 'SPEC_GENERATED', actorId, payload: payload as Prisma.InputJsonValue, tenantId: workItem.tenantId },
  }), workItem.tenantId ?? undefined)
  await logEvent('SpecGenerated', 'WorkItem', workItemId, actorId, payload)
  await publishOutbox('WorkItem', workItemId, 'SpecGenerated', payload)

  return { specification, validation, repaired }
}
