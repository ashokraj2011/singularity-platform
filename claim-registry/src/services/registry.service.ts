/**
 * claim-registry — outward contract + lifecycle jobs (M-CR3):
 *  - /lookup/resolve (M11.b): so Workgraph write-time validation can 422 on bad
 *    claim refs the same way it does for agents/tools.
 *  - Rooms→registry promotion intake: a PROMOTED claim crosses the boundary, its
 *    Beta posterior translated to a log-odds prior (the coexist boundary).
 *  - decay-recompute job: re-derives every ACTIVE posterior with decay applied,
 *    emits claim.decay.threshold_crossed when a matured claim slips below its gate
 *    (humans decide — no auto-demotion), and auto-falsifies at ≤0.20.
 */
import type { ClaimKind } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { betaToLogOdds } from '../lib/posterior';
import { decayThresholdCrossed, type MaturityState } from '../lib/maturity';
import { publishEvent } from '../lib/events';
import { createClaim, recompute, transition } from './claim.service';
import { openAmbiguity } from './ambiguity.service';
import { currentRegistryTenant } from '../lib/request-context';

// ── /lookup/resolve (M11.b 200/207) ───────────────────────────────────────────
export interface RefInput { kind: string; id: string }
export interface RefResult { kind: string; id: string; exists: boolean; label?: string; error?: string }

export async function resolveRefs(refs: RefInput[]): Promise<{ all_ok: boolean; results: RefResult[] }> {
  const results = await Promise.all(refs.map(async (ref): Promise<RefResult> => {
    if (ref.kind !== 'claim') return { kind: ref.kind, id: ref.id, exists: false, error: `unsupported kind ${ref.kind}` };
    const claim = await prisma.claim.findFirst({ where: { id: ref.id, tenantId: currentRegistryTenant() }, select: { statement: true, maturity: true, status: true } });
    return claim
      ? { kind: 'claim', id: ref.id, exists: true, label: `${claim.maturity}: ${claim.statement.slice(0, 80)}` }
      : { kind: 'claim', id: ref.id, exists: false };
  }));
  return { all_ok: results.every((r) => r.exists), results };
}

// ── Rooms → registry promotion ────────────────────────────────────────────────
export interface PromoteInput {
  statement: string;
  kind: ClaimKind;
  alpha: number;
  beta: number;
  roomClaimId: string;
  capabilityId?: string | null;
  promotedBy: string;
}

export async function promoteFromRoom(input: PromoteInput) {
  const priorLogOdds = betaToLogOdds(input.alpha, input.beta);
  const { claim, canonicalizationDegraded } = await createClaim({
    kind: input.kind, statement: input.statement, capabilityId: input.capabilityId ?? null,
    createdBy: input.promotedBy, priorLogOddsOverride: priorLogOdds, maturity: 'HYPOTHESIS',
    provenance: { promotedFromRoom: true, roomClaimId: input.roomClaimId, beta: { alpha: input.alpha, beta: input.beta } },
  });
  await publishEvent('claim.promoted', claim.id, { roomClaimId: input.roomClaimId, priorLogOdds });
  return { claim, priorLogOdds, canonicalizationDegraded };
}

// ── decay-recompute job (nightly) ─────────────────────────────────────────────
export async function runDecayRecompute(nowMs: number = Date.now()) {
  const claims = await prisma.claim.findMany({ where: { tenantId: currentRegistryTenant(), status: 'ACTIVE' }, select: { id: true, maturity: true, posteriorProb: true } });
  let recomputed = 0;
  let thresholdCrossed = 0;
  let falsified = 0;

  for (const c of claims) {
    const prev = c.posteriorProb;
    const r = await recompute(c.id, nowMs);
    recomputed++;

    const crossed = decayThresholdCrossed(c.maturity as MaturityState, prev, r.posteriorProb);
    if (crossed !== null) {
      thresholdCrossed++;
      // No auto-demotion (spec §4): flag it, humans decide. Emit the event AND open a
      // MISSING_EVIDENCE ambiguity so the tension lands in the ledger's work queue (M-CR4).
      await publishEvent('claim.decay.threshold_crossed', c.id, { threshold: crossed, prevProb: prev, newProb: r.posteriorProb, maturity: c.maturity });
      await openAmbiguity({
        type: 'MISSING_EVIDENCE', claimId: c.id, severity: 'HIGH',
        detail: { threshold: crossed, prevProb: prev, newProb: r.posteriorProb, maturity: c.maturity },
        openedBy: 'sweep:decay',
      });
    }
    if (r.posteriorProb <= 0.2 && c.maturity !== 'FALSIFIED') {
      await transition(c.id, 'FALSIFIED'); // automatic + terminal; emits claim.falsified
      falsified++;
    }
  }
  return { recomputed, thresholdCrossed, falsified };
}
