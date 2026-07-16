/**
 * claim-registry — the ambiguity ledger (M-CR4). The queue of surfaced-but-unresolved
 * epistemic tensions. Opening is idempotent (one OPEN row per logical tension); closing
 * is a human act (acknowledge / resolve / dismiss). The ledger never mutates a claim's
 * belief or maturity — it only records that a human needs to look.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { publishEvent } from '../lib/events';
import { AppError } from '../lib/errors';
import { dedupeKeyFor, SEVERITY_RANK, STATUS_RANK, type AmbiguityType, type Severity } from '../lib/ambiguity';
import { currentRegistryTenant } from '../lib/request-context';

export interface OpenAmbiguityInput {
  type: AmbiguityType;
  claimId: string;
  relatedClaimId?: string | null;
  severity?: Severity;
  detail?: Record<string, unknown>;
  openedBy: string;
}

/**
 * Open an ambiguity — idempotent. If an OPEN row with the same logical key already
 * exists (same type + same claims), returns it untouched (`created:false`) rather than
 * forking a duplicate. This is what lets the nightly sweeps re-run safely.
 */
export async function openAmbiguity(input: OpenAmbiguityInput): Promise<{ ambiguity: Awaited<ReturnType<typeof prisma.ambiguity.create>>; created: boolean }> {
  const tenantId = currentRegistryTenant();
  const involved = [input.claimId, ...(input.relatedClaimId ? [input.relatedClaimId] : [])];
  const dedupeKey = dedupeKeyFor(input.type, involved);
  const existing = await prisma.ambiguity.findFirst({ where: { tenantId, dedupeKey, status: 'OPEN' } });
  if (existing) return { ambiguity: existing, created: false };

  const ambiguity = await prisma.ambiguity.create({
    data: {
      tenantId,
      type: input.type as never,
      claimId: input.claimId,
      relatedClaimId: input.relatedClaimId ?? null,
      dedupeKey,
      severity: input.severity ?? 'MEDIUM',
      detail: (input.detail ?? {}) as Prisma.InputJsonValue,
      openedBy: input.openedBy,
    },
  });
  await publishEvent('ambiguity.opened', ambiguity.id, {
    type: input.type, claimId: input.claimId, relatedClaimId: input.relatedClaimId ?? null, severity: ambiguity.severity,
  });
  return { ambiguity, created: true };
}

export interface AmbiguityFilter {
  status?: string;
  type?: string;
  claimId?: string;
}

/** List the ledger. OPEN + HIGH-severity + oldest float to the top (the work queue order). */
export async function listAmbiguities(filter: AmbiguityFilter) {
  const tenantId = currentRegistryTenant();
  const rows = await prisma.ambiguity.findMany({
    where: {
      tenantId,
      ...(filter.status ? { status: filter.status as never } : {}),
      ...(filter.type ? { type: filter.type as never } : {}),
      ...(filter.claimId ? { claimId: filter.claimId } : {}),
    },
    take: 500,
  });
  return rows.sort((a, b) =>
    (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
    (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
    a.openedAt.getTime() - b.openedAt.getTime(),
  );
}

export async function acknowledgeAmbiguity(id: string, actor: string) {
  const amb = await prisma.ambiguity.findFirst({ where: { id, tenantId: currentRegistryTenant() } });
  if (!amb) throw new AppError(404, 'AMBIGUITY_NOT_FOUND', `Ambiguity ${id} not found.`);
  if (amb.status !== 'OPEN') throw new AppError(409, 'AMBIGUITY_NOT_OPEN', `Ambiguity is ${amb.status}, not OPEN.`);
  const updated = await prisma.ambiguity.update({
    where: { id }, data: { status: 'ACKNOWLEDGED' as never, acknowledgedBy: actor, acknowledgedAt: new Date() },
  });
  await publishEvent('ambiguity.acknowledged', id, { actor });
  return updated;
}

/** Close an ambiguity — resolved (tension settled) or dismissed (not real / won't-fix). */
export async function resolveAmbiguity(id: string, actor: string, note: string | undefined, dismiss = false) {
  const amb = await prisma.ambiguity.findFirst({ where: { id, tenantId: currentRegistryTenant() } });
  if (!amb) throw new AppError(404, 'AMBIGUITY_NOT_FOUND', `Ambiguity ${id} not found.`);
  if (amb.status === 'RESOLVED' || amb.status === 'DISMISSED') {
    throw new AppError(409, 'AMBIGUITY_CLOSED', `Ambiguity already ${amb.status}.`);
  }
  const status = dismiss ? 'DISMISSED' : 'RESOLVED';
  const updated = await prisma.ambiguity.update({
    where: { id }, data: { status: status as never, resolvedBy: actor, resolvedAt: new Date(), resolutionNote: note ?? null },
  });
  await publishEvent(dismiss ? 'ambiguity.dismissed' : 'ambiguity.resolved', id, { actor, note: note ?? null });
  return updated;
}
