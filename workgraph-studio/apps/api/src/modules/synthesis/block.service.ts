/**
 * Synthesis Studio — document block CRUD (R1A Documents phase). Blocks are the
 * addressable, typed content of an own-content document version. Every mutation is gated:
 * the document must NOT be spec-bound (its content lives in the SpecificationVersion) and
 * must be in an editable state (DRAFT/CHANGES_REQUESTED). A PINNED block is frozen until
 * unpinned or the doc is forked.
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb } from '../../lib/tenant-db-context'
import { config } from '../../config'
import { NotFoundError, ConflictError } from '../../lib/errors'
import { isEditable, type DocStatus } from './document-lifecycle'

const tenantId = (): string => currentTenantIdForDb() ?? config.WORKGRAPH_DEFAULT_TENANT_ID

/** Resolve the editable current version of an own-content, editable, tenant-owned document. */
async function editableVersionId(documentId: string): Promise<string> {
  const doc = await prisma.synthesisDocument.findFirst({
    where: { id: documentId, tenantId: tenantId() },
    select: { id: true, status: true, specificationVersionId: true, currentVersionId: true },
  })
  if (!doc) throw new NotFoundError('SynthesisDocument', documentId)
  if (doc.specificationVersionId) throw new ConflictError('Spec-bound document — edit its SpecificationVersion, not blocks.')
  if (!isEditable(doc.status as DocStatus)) throw new ConflictError(`Document is ${doc.status}; blocks are read-only.`)
  if (!doc.currentVersionId) throw new ConflictError('Document has no editable version.')
  return doc.currentVersionId
}

export interface AddBlockInput {
  blockType: string
  content?: Record<string, unknown>
  ordinal?: number
  mode?: 'LIVE' | 'PINNED'
  sourceRef?: Record<string, unknown>
  authorType?: 'HUMAN' | 'AGENT' | 'SYSTEM'
  authorId?: string
  agentRole?: string
}

export async function addBlock(documentId: string, input: AddBlockInput) {
  const documentVersionId = await editableVersionId(documentId)
  const last = await prisma.documentBlock.findFirst({ where: { documentVersionId }, orderBy: { ordinal: 'desc' }, select: { ordinal: true } })
  const ordinal = input.ordinal ?? ((last?.ordinal ?? -1) + 1)
  return prisma.documentBlock.create({
    data: {
      tenantId: tenantId(), documentVersionId, ordinal,
      blockType: input.blockType as never,
      mode: input.mode ?? 'LIVE',
      content: (input.content ?? {}) as Prisma.InputJsonValue,
      ...(input.sourceRef ? { sourceRef: input.sourceRef as Prisma.InputJsonValue } : {}),
      authorType: input.authorType ?? 'HUMAN',
      authorId: input.authorId ?? null,
      agentRole: input.agentRole ?? null,
    },
  })
}

export async function updateBlock(documentId: string, blockId: string, patch: { content?: Record<string, unknown>; ordinal?: number }) {
  const documentVersionId = await editableVersionId(documentId)
  const block = await prisma.documentBlock.findFirst({ where: { id: blockId, documentVersionId }, select: { id: true, mode: true } })
  if (!block) throw new NotFoundError('DocumentBlock', blockId)
  if (block.mode === 'PINNED') throw new ConflictError('Block is PINNED — unpin or fork to edit.')
  return prisma.documentBlock.update({
    where: { id: block.id },
    data: {
      ...(patch.content ? { content: patch.content as Prisma.InputJsonValue } : {}),
      ...(patch.ordinal !== undefined ? { ordinal: patch.ordinal } : {}),
    },
  })
}

export async function removeBlock(documentId: string, blockId: string) {
  const documentVersionId = await editableVersionId(documentId)
  const block = await prisma.documentBlock.findFirst({ where: { id: blockId, documentVersionId }, select: { id: true } })
  if (!block) throw new NotFoundError('DocumentBlock', blockId)
  await prisma.documentBlock.delete({ where: { id: block.id } })
  return { deleted: true }
}

/** Explicit per-block pin: LIVE → PINNED, freezing current content into pinnedSnapshot. */
export async function pinBlock(documentId: string, blockId: string) {
  const documentVersionId = await editableVersionId(documentId)
  const block = await prisma.documentBlock.findFirst({ where: { id: blockId, documentVersionId } })
  if (!block) throw new NotFoundError('DocumentBlock', blockId)
  return prisma.documentBlock.update({ where: { id: block.id }, data: { mode: 'PINNED', pinnedSnapshot: block.content as Prisma.InputJsonValue } })
}
