/**
 * Synthesis Studio — versioned documents (R1A Documents phase). READOUT/DIGEST/NARRATIVE/
 * GENERIC docs OWN their content via DocumentVersion + DocumentBlock. PRD/BRD are
 * SPEC-BOUND: they carry a specificationVersionId and do NOT own content here — the
 * SpecificationVersion stays the system-of-record (the fork the plan warns against is
 * closed by refusing block edits on spec-bound docs). Entering a frozen state forces
 * every block PINNED + stamps a canonical contentHash (mirrors the spec approval freeze).
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb } from '../../lib/tenant-db-context'
import { config } from '../../config'
import { hashPayload } from '../../lib/snapshot'
import { NotFoundError, ConflictError, ValidationError } from '../../lib/errors'
import { getProject } from '../studio/studio-projects.service'
import { canTransition, requiresPinnedBlocks, type DocStatus } from './document-lifecycle'

const tenantId = (): string => currentTenantIdForDb() ?? config.WORKGRAPH_DEFAULT_TENANT_ID
const SPEC_BOUND_TYPES = new Set(['PRD', 'BRD'])

export interface CreateDocumentInput {
  specificationProjectId: string
  docType: 'PRD' | 'BRD' | 'READOUT' | 'DIGEST' | 'NARRATIVE' | 'GENERIC'
  title: string
  workItemId?: string | null
  workspaceId?: string | null
  specificationVersionId?: string | null
}

export async function createDocument(input: CreateDocumentInput, userId: string) {
  await getProject(input.specificationProjectId)
  if (SPEC_BOUND_TYPES.has(input.docType) && !input.specificationVersionId) {
    throw new ValidationError(`${input.docType} documents must bind to a specificationVersionId (they never own duplicate content).`)
  }
  const doc = await prisma.synthesisDocument.create({
    data: {
      tenantId: tenantId(),
      specificationProjectId: input.specificationProjectId,
      docType: input.docType,
      title: input.title,
      workItemId: input.workItemId ?? null,
      workspaceId: input.workspaceId ?? null,
      specificationVersionId: input.specificationVersionId ?? null,
      createdById: userId,
    },
  })
  // Own-content docs get a v1 DocumentVersion; spec-bound docs point at the spec instead.
  if (!doc.specificationVersionId) {
    const v = await prisma.documentVersion.create({ data: { tenantId: tenantId(), documentId: doc.id, version: 1, createdById: userId } })
    await prisma.synthesisDocument.update({ where: { id: doc.id }, data: { currentVersionId: v.id } })
  }
  return getDocument(doc.id)
}

export async function getDocument(documentId: string) {
  const doc = await prisma.synthesisDocument.findFirst({
    where: { id: documentId, tenantId: tenantId() },
    include: { versions: { orderBy: { version: 'desc' }, include: { blocks: { orderBy: { ordinal: 'asc' } } } } },
  })
  if (!doc) throw new NotFoundError('SynthesisDocument', documentId)
  return doc
}

export async function listDocuments(filter: { projectId?: string; workspaceId?: string }) {
  const where: Prisma.SynthesisDocumentWhereInput = { tenantId: tenantId() }
  if (filter.projectId) where.specificationProjectId = filter.projectId
  if (filter.workspaceId) where.workspaceId = filter.workspaceId
  if (!filter.projectId && !filter.workspaceId) throw new ValidationError('projectId or workspaceId is required')
  return { items: await prisma.synthesisDocument.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200 }) }
}

export async function transitionDocument(documentId: string, to: DocStatus, actor: string) {
  const doc = await prisma.synthesisDocument.findFirst({ where: { id: documentId, tenantId: tenantId() } })
  if (!doc) throw new NotFoundError('SynthesisDocument', documentId)
  const from = doc.status as DocStatus
  if (!canTransition(from, to)) throw new ConflictError(`Illegal document transition ${from} → ${to}.`)
  // Independent-reviewer rule for APPROVED (mirrors approveSpecificationVersion).
  if (to === 'APPROVED' && doc.createdById === actor) {
    throw new ValidationError('An independent reviewer must approve this document (author ≠ approver).')
  }

  let contentHash = doc.contentHash
  // Freeze: entering a frozen state forces every block PINNED + stamps a contentHash.
  if (requiresPinnedBlocks(to) && doc.currentVersionId) {
    const blocks = await prisma.documentBlock.findMany({ where: { documentVersionId: doc.currentVersionId }, orderBy: { ordinal: 'asc' } })
    for (const b of blocks) {
      if (b.mode !== 'PINNED') {
        await prisma.documentBlock.update({ where: { id: b.id }, data: { mode: 'PINNED', pinnedSnapshot: b.content as Prisma.InputJsonValue } })
      }
    }
    contentHash = hashPayload(blocks.map((b) => ({ ordinal: b.ordinal, blockType: b.blockType, content: b.content })))
    await prisma.documentVersion.update({
      where: { id: doc.currentVersionId },
      data: { status: to, contentHash, ...(to === 'APPROVED' ? { approvedById: actor } : {}) },
    })
  }
  return prisma.synthesisDocument.update({
    where: { id: documentId },
    data: { status: to, contentHash, ...(to === 'APPROVED' ? { approvedById: actor } : {}) },
  })
}
