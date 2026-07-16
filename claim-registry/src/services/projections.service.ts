/**
 * claim-registry — projections (M-CR4). A projection is a read-model over the claim set,
 * built for a downstream consumer. Assumption-register first (spec): every ASSUMPTION-kind
 * claim with its live belief state, evidence balance, and open-ambiguity count — ordered
 * riskiest (least-believed) first, so the register reads as a to-do, not an archive.
 *
 * v1 is a live query (no materialized table). Materialization + the other projections
 * (decision-log, requirements-traceability, open-questions) are deferred.
 */
import { prisma } from '../lib/prisma';
import { currentRegistryTenant } from '../lib/request-context';

export interface AssumptionRow {
  claimId: string;
  statement: string;
  maturity: string;
  status: string;
  posteriorProb: number;
  effectiveEvidence: number;
  evidenceCount: number;
  supportingCount: number;
  refutingCount: number;
  openAmbiguityCount: number;
  createdAt: string;
  ageDays: number;
}

export interface AssumptionRegister {
  generatedAt: string;
  count: number;
  rows: AssumptionRow[];
}

export async function assumptionRegister(filter: { capabilityId?: string | null }, nowMs: number = Date.now()): Promise<AssumptionRegister> {
  const claims = await prisma.claim.findMany({
    where: {
      tenantId: currentRegistryTenant(),
      kind: 'ASSUMPTION',
      status: { in: ['ACTIVE', 'FALSIFIED'] },
      ...(filter.capabilityId !== undefined ? { capabilityId: filter.capabilityId } : {}),
    },
    include: { evidenceLinks: { select: { direction: true } } },
    orderBy: { posteriorProb: 'asc' }, // riskiest (least-believed) first
    take: 1000,
  });

  // Open-ambiguity count per claim (one round-trip, counted in JS — small result set).
  const ambs = claims.length
    ? await prisma.ambiguity.findMany({ where: { tenantId: currentRegistryTenant(), status: 'OPEN', claimId: { in: claims.map((c) => c.id) } }, select: { claimId: true } })
    : [];
  const ambCount = new Map<string, number>();
  for (const a of ambs) ambCount.set(a.claimId, (ambCount.get(a.claimId) ?? 0) + 1);

  const rows = claims.map((c): AssumptionRow => {
    const supporting = c.evidenceLinks.filter((l) => l.direction === 'SUPPORTS').length;
    const refuting = c.evidenceLinks.filter((l) => l.direction === 'CONTRADICTS').length;
    return {
      claimId: c.id, statement: c.statement, maturity: c.maturity, status: c.status,
      posteriorProb: c.posteriorProb, effectiveEvidence: c.effectiveEvidence,
      evidenceCount: c.evidenceLinks.length, supportingCount: supporting, refutingCount: refuting,
      openAmbiguityCount: ambCount.get(c.id) ?? 0,
      createdAt: c.createdAt.toISOString(), ageDays: Math.round((nowMs - c.createdAt.getTime()) / 86_400_000),
    };
  });
  return { generatedAt: new Date(nowMs).toISOString(), count: rows.length, rows };
}
