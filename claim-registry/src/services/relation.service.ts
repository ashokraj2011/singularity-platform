/**
 * claim-registry — claim-to-claim relations (M-CR4). A typed edge asserted by a human or
 * an agent verdict; CONTRADICTS is the input the contradiction sweep reads. Kept minimal:
 * relations are asserted, never inferred (no embeddings — the same fail-loud stance as
 * canonicalization), so a contradiction only exists because someone declared it.
 */
import { prisma } from '../lib/prisma';
import { publishEvent } from '../lib/events';
import { AppError } from '../lib/errors';

export type RelationType = 'CONTRADICTS' | 'DEPENDS_ON' | 'REFINES' | 'DUPLICATES';

export interface AssertRelationInput {
  fromClaimId: string;
  toClaimId: string;
  type: RelationType;
  note?: string;
  createdBy: string;
}

export async function assertRelation(input: AssertRelationInput) {
  if (input.fromClaimId === input.toClaimId) {
    throw new AppError(422, 'SELF_RELATION', 'A claim cannot relate to itself.');
  }
  const [from, to] = await Promise.all([
    prisma.claim.findUnique({ where: { id: input.fromClaimId }, select: { id: true } }),
    prisma.claim.findUnique({ where: { id: input.toClaimId }, select: { id: true } }),
  ]);
  if (!from) throw new AppError(404, 'CLAIM_NOT_FOUND', `Claim ${input.fromClaimId} not found.`);
  if (!to) throw new AppError(404, 'CLAIM_NOT_FOUND', `Claim ${input.toClaimId} not found.`);

  const relation = await prisma.claimRelation.upsert({
    where: { fromClaimId_toClaimId_type: { fromClaimId: input.fromClaimId, toClaimId: input.toClaimId, type: input.type as never } },
    update: { note: input.note ?? null },
    create: { fromClaimId: input.fromClaimId, toClaimId: input.toClaimId, type: input.type as never, note: input.note ?? null, createdBy: input.createdBy },
  });
  await publishEvent('claim.relation.asserted', relation.id, { fromClaimId: input.fromClaimId, toClaimId: input.toClaimId, type: input.type });
  return relation;
}

export async function listRelations(claimId: string) {
  return prisma.claimRelation.findMany({
    where: { OR: [{ fromClaimId: claimId }, { toClaimId: claimId }] },
    orderBy: { createdAt: 'desc' },
  });
}
