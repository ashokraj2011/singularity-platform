import { traceIdFromParts } from '@workgraph/shared-types'
import { prisma } from '../../lib/prisma'
import { ConflictError, NotFoundError } from '../../lib/errors'
import { specificationPackageBodySchema, emptySpecificationPackageBody } from './specification.schemas'
import { updateSpecificationDraft } from './specifications.service'
import { defaultSpecGenLlm, type SpecGenLlm } from './spec-generation.service'
import {
  specAgentSystemPrompt,
  buildConverseTask,
  parseAgentResponse,
  applyProposal,
  type ConverseMessage,
  type SpecProposal,
} from './spec-agent'

function bodyOf(pkg: any) {
  const parsed = specificationPackageBodySchema.safeParse(pkg ?? {})
  return parsed.success ? parsed.data : emptySpecificationPackageBody()
}

/** Converse with Agent Storm about this Work Item's spec; returns a reply + applyable proposals. */
export async function converseSpecAgent(
  workItemId: string,
  input: { messages: ConverseMessage[]; versionId?: string },
  actorId: string,
  llm: SpecGenLlm = defaultSpecGenLlm,
) {
  const workItem = await prisma.workItem.findUnique({ where: { id: workItemId }, select: { id: true, workCode: true } })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)

  let spec: { summary?: string; requirements?: any[] } | null = null
  if (input.versionId) {
    const version = await prisma.specificationVersion.findUnique({ where: { id: input.versionId } })
    if (version && version.workItemId === workItemId) {
      const b = bodyOf(version.package)
      spec = { summary: b.summary, requirements: b.requirements }
    }
  }

  const text = await llm.complete({
    system: specAgentSystemPrompt(),
    task: buildConverseTask(input.messages, spec),
    traceId: traceIdFromParts(['spec-agent', workItemId], ':'),
    actorId,
    workItemId,
    workCode: workItem.workCode,
    temperature: 0.3,
  })
  return parseAgentResponse(text)
}

/** Apply one Agent Storm proposal to a draft version (append/replace a requirement/AC/test). */
export async function applySpecProposal(workItemId: string, versionId: string, proposal: SpecProposal, actorId: string) {
  const version = await prisma.specificationVersion.findUnique({ where: { id: versionId } })
  if (!version || version.workItemId !== workItemId) throw new NotFoundError('SpecificationVersion', versionId)
  if (version.status !== 'DRAFT' && version.status !== 'CHANGES_REQUESTED') {
    throw new ConflictError(`Specification version ${version.version} is ${version.status}; proposals can only be applied to an editable draft.`)
  }
  const patch = applyProposal(bodyOf(version.package), proposal)
  return updateSpecificationDraft(workItemId, versionId, { expectedRevision: version.revision, body: patch }, actorId)
}
