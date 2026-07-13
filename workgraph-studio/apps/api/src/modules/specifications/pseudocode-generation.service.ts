import { randomUUID } from 'crypto'
import { traceIdFromParts } from '@workgraph/shared-types'
import { prisma } from '../../lib/prisma'
import { ConflictError, NotFoundError } from '../../lib/errors'
import {
  specificationPackageBodySchema,
  emptySpecificationPackageBody,
  type PseudocodeModule,
} from './specification.schemas'
import { updateSpecificationDraft } from './specifications.service'
import { defaultSpecGenLlm, type SpecGenLlm } from './spec-generation.service'
import { pseudocodeSystemPrompt, buildPseudocodeTask, parsePseudocode } from './pseudocode-generation'

export interface GeneratePseudocodeInput {
  requirementIds?: string[]
  language?: string
  title?: string
  instructions?: string
}

/**
 * Generate a pseudo-code module for a DRAFT spec version and append it to the version's
 * `pseudocode` section (Spec Studio). Reuses the injectable spec-gen LLM and the existing
 * optimistic-concurrency draft-update path, so a generated module is indistinguishable from a
 * hand-authored one. Only DRAFT / CHANGES_REQUESTED versions are editable.
 */
export async function generatePseudocode(
  workItemId: string,
  versionId: string,
  input: GeneratePseudocodeInput,
  actorId: string,
  llm: SpecGenLlm = defaultSpecGenLlm,
) {
  const workItem = await prisma.workItem.findUnique({ where: { id: workItemId }, select: { id: true, workCode: true } })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  const version = await prisma.specificationVersion.findUnique({ where: { id: versionId } })
  if (!version || version.workItemId !== workItemId) throw new NotFoundError('SpecificationVersion', versionId)
  if (version.status !== 'DRAFT' && version.status !== 'CHANGES_REQUESTED') {
    throw new ConflictError(`Specification version ${version.version} is ${version.status}; pseudo-code can only be generated on an editable draft.`)
  }

  const parsedBody = specificationPackageBodySchema.safeParse(version.package ?? {})
  const body = parsedBody.success ? parsedBody.data : emptySpecificationPackageBody()

  const language = (input.language ?? 'pseudocode').trim() || 'pseudocode'
  const scope = input.requirementIds?.length
    ? body.requirements.filter((r) => input.requirementIds!.includes(r.id))
    : body.requirements

  const text = await llm.complete({
    system: pseudocodeSystemPrompt(),
    task: buildPseudocodeTask({
      title: input.title,
      language,
      instructions: input.instructions,
      requirements: scope.map((r) => ({ id: r.id, statement: r.statement, priority: r.priority })),
    }),
    traceId: traceIdFromParts(['pseudocode', versionId], ':'),
    actorId,
    workItemId,
    workCode: workItem.workCode,
    temperature: 0.2,
  })

  const parsed = parsePseudocode(text, language)
  const moduleEntry: PseudocodeModule = {
    id: `PC-${randomUUID().slice(0, 8)}`,
    title: (input.title ?? '').trim() || `Generated ${parsed.language} module`,
    language: parsed.language,
    requirementIds: scope.map((r) => r.id),
    content: parsed.content,
    generated: true,
  }

  const specification = await updateSpecificationDraft(
    workItemId,
    versionId,
    { expectedRevision: version.revision, body: { pseudocode: [...body.pseudocode, moduleEntry] } },
    actorId,
  )
  return { specification, module: moduleEntry }
}
