/**
 * claim-registry — the ambiguity sweeps (M-CR4). Periodic scans (a scheduler POSTs the
 * /jobs endpoints nightly) that surface tensions into the ledger. Each sweep is
 * idempotent via openAmbiguity's dedupe. NONE of them mutate a claim's belief or maturity
 * — they only open ledger entries; humans decide.
 *
 *   contradiction — asserted CONTRADICTS edges where both sides are still believed
 *   starvation    — young claims that gathered no evidence and aged out
 *   decay         — lives in registry.service.runDecayRecompute (it opens MISSING_EVIDENCE)
 */
import { prisma } from '../lib/prisma';
import { openAmbiguity } from './ambiguity.service';
import { currentRegistryTenant } from '../lib/request-context';
import { runDecayRecompute } from './registry.service';
import {
  detectStarvation, contradictionLive, contradictionSeverity,
  DEFAULT_STARVATION, type StarvationPolicy,
} from '../lib/ambiguity';

/**
 * For every asserted CONTRADICTS relation where BOTH claims are still believed
 * (ACTIVE, posterior ≥ floor), open a CONTRADICTION ambiguity. A contradiction whose
 * loser already decayed/falsified is self-resolved and skipped.
 */
export async function runContradictionSweep(openedBy = 'sweep:contradiction') {
  const relations = await prisma.claimRelation.findMany({
    where: { tenantId: currentRegistryTenant(), type: 'CONTRADICTS' },
    include: {
      fromClaim: { select: { id: true, status: true, posteriorProb: true } },
      toClaim: { select: { id: true, status: true, posteriorProb: true } },
    },
  });
  let scanned = 0;
  let opened = 0;
  for (const rel of relations) {
    scanned++;
    const a = { status: rel.fromClaim.status, posteriorProb: rel.fromClaim.posteriorProb };
    const b = { status: rel.toClaim.status, posteriorProb: rel.toClaim.posteriorProb };
    if (!contradictionLive(a, b)) continue;
    const { created } = await openAmbiguity({
      type: 'CONTRADICTION',
      claimId: rel.fromClaimId,
      relatedClaimId: rel.toClaimId,
      severity: contradictionSeverity(a, b),
      detail: { relationId: rel.id, fromProb: a.posteriorProb, toProb: b.posteriorProb },
      openedBy,
    });
    if (created) opened++;
  }
  return { scanned, opened };
}

/**
 * Young claims (FRAGMENT / HYPOTHESIS) that have gathered no evidence and aged past the
 * policy window — they will never mature. Open a STARVATION ambiguity so a human can
 * feed or retire them.
 */
export async function runStarvationSweep(nowMs: number = Date.now(), policy: StarvationPolicy = DEFAULT_STARVATION, openedBy = 'sweep:starvation') {
  const claims = await prisma.claim.findMany({
    where: { tenantId: currentRegistryTenant(), status: 'ACTIVE', maturity: { in: ['FRAGMENT', 'HYPOTHESIS'] } },
    select: { id: true, maturity: true, createdAt: true, _count: { select: { evidenceLinks: true } } },
  });
  let scanned = 0;
  let opened = 0;
  for (const c of claims) {
    scanned++;
    const det = detectStarvation(
      { maturity: c.maturity, createdAtMs: c.createdAt.getTime(), evidenceCount: c._count.evidenceLinks, lastEvidenceAtMs: null },
      nowMs, policy,
    );
    if (!det.starved) continue;
    const { created } = await openAmbiguity({
      type: 'STARVATION', claimId: c.id, severity: 'LOW',
      detail: { ageDays: Math.round(det.ageDays), reason: det.reason }, openedBy,
    });
    if (created) opened++;
  }
  return { scanned, opened };
}

/** Run every sweep (decay + contradiction + starvation) — the full nightly pass. */
export async function runAllSweeps(nowMs: number = Date.now()) {
  const decay = await runDecayRecompute(nowMs);
  const contradiction = await runContradictionSweep();
  const starvation = await runStarvationSweep(nowMs);
  return { decay, contradiction, starvation };
}
