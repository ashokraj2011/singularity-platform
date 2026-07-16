/**
 * claim-registry — claim service (M-CR1). The invariants (spec §1) live here:
 * append-only versioned claims, immutable content-hashed evidence, DERIVED posterior
 * (never set by an API), maturity moves through the gated machine, every transition
 * produces a receipt, and canonicalization runs before insert (exact-hash HARD;
 * embedding near-dup is fail-loud, never a silent fork).
 */
import { randomUUID } from 'crypto';
import type { Prisma, ClaimKind, MaturityState as PrismaMaturity } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { statementCanonicalKey, hashPayload } from '../lib/canonical';
import { publishEvent, emitReceipt } from '../lib/events';
import { computePosterior, priorLogOddsForKind, type PosteriorEvidenceLink, type EvidenceTier, type EvidenceDirection } from '../lib/posterior';
import { evaluateTransition, autoTransitionFor, DEFAULT_GATES, type MaturityState } from '../lib/maturity';
import { AppError } from '../lib/errors';

const KIND_HALF_LIFE_DAYS: Record<string, number> = { HYPOTHESIS: 180, ASSUMPTION: 90, OBSERVATION: 180, CONSTRAINT: 730, DECISION: 365, REQUIREMENT: 365 };
const halfLifeFor = (kind: string) => KIND_HALF_LIFE_DAYS[kind] ?? 180;

// ── Create (canonicalization runs first) ──────────────────────────────────────
export interface CreateClaimInput {
  kind: ClaimKind;
  statement: string;
  capabilityId?: string | null;
  subjectRefs?: unknown[];
  tags?: string[];
  provenance?: Record<string, unknown>;
  createdBy: string;
  force?: boolean;
  /** override the kind-default prior (Rooms→registry promotion seeds from a Beta posterior) */
  priorLogOddsOverride?: number;
  /** promoted claims arrive already reviewed/typed, not as raw FRAGMENTs */
  maturity?: 'FRAGMENT' | 'HYPOTHESIS';
}

export async function createClaim(input: CreateClaimInput) {
  const canonicalKey = statementCanonicalKey(input.statement);
  // Exact-hash dedup — the HARD guard, works without embeddings.
  const existing = await prisma.claim.findUnique({ where: { canonicalKey } });
  if (existing && !input.force) {
    throw new AppError(409, 'CLAIM_EXISTS', 'An identical claim already exists.', { existing });
  }
  // Embedding near-dup is DEFERRED (the platform embedding path is unreliable by
  // default). We flag the claim embeddingDegraded so canonicalization is fail-LOUD,
  // never a silent posterior fork — the invariant the spec demands. Wire the
  // /v1/embeddings call in once a reliable embedding alias is configured.
  const embeddingDegraded = true;
  const prior = input.priorLogOddsOverride ?? priorLogOddsForKind(input.kind);
  const seed = computePosterior(prior, [], Date.now(), halfLifeFor(input.kind));

  const claim = await prisma.claim.create({
    data: {
      kind: input.kind, statement: input.statement, canonicalKey,
      capabilityId: input.capabilityId ?? null,
      subjectRefs: (input.subjectRefs ?? []) as Prisma.InputJsonValue,
      tags: input.tags ?? [],
      provenance: (input.provenance ?? {}) as Prisma.InputJsonValue,
      createdBy: input.createdBy,
      priorLogOdds: prior, posteriorLogOdds: seed.posteriorLogOdds, posteriorProb: seed.posteriorProb,
      effectiveEvidence: 0, halfLifeDays: halfLifeFor(input.kind), embeddingDegraded,
      ...(input.maturity ? { maturity: input.maturity as never } : {}),
      versions: { create: { version: 1, statement: input.statement, editedBy: input.createdBy } },
    },
  });
  await publishEvent('claim.created', claim.id, { kind: claim.kind, canonicalKey });
  return { claim, canonicalizationDegraded: embeddingDegraded };
}

export async function getClaim(id: string) {
  const claim = await prisma.claim.findUnique({ where: { id }, include: { evidenceLinks: true, versions: { orderBy: { version: 'desc' } }, transitions: { orderBy: { occurredAt: 'desc' } } } });
  if (!claim) throw new AppError(404, 'CLAIM_NOT_FOUND', `Claim ${id} not found.`);
  return claim;
}

// ── Evidence attach + synchronous recompute ───────────────────────────────────
export interface AttachEvidenceInput {
  tier: EvidenceTier;
  kind: string;
  direction: EvidenceDirection;
  logLikelihoodRatio: number;
  sourceKey: string;
  excerpt: string;
  observedAt: string; // ISO
  sourceMeta?: Record<string, unknown>;
  decayExempt?: boolean;
  payloadRef?: string;
  attachedBy: string;
}

export async function attachEvidence(claimId: string, input: AttachEvidenceInput) {
  const claim = await prisma.claim.findUnique({ where: { id: claimId } });
  if (!claim) throw new AppError(404, 'CLAIM_NOT_FOUND', `Claim ${claimId} not found.`);
  const before = claim.posteriorProb;

  const contentHash = hashPayload({ excerpt: input.excerpt, sourceMeta: input.sourceMeta ?? {}, observedAt: input.observedAt, kind: input.kind, tier: input.tier });
  // Evidence is immutable + content-hashed; the same payload reuses the object.
  const evidence = await prisma.evidenceObject.upsert({
    where: { contentHash },
    update: {},
    create: {
      tier: input.tier as never, kind: input.kind as never, contentHash, excerpt: input.excerpt,
      payloadRef: input.payloadRef ?? null, sourceMeta: (input.sourceMeta ?? {}) as Prisma.InputJsonValue,
      observedAt: new Date(input.observedAt), createdBy: input.attachedBy,
    },
  });
  await prisma.evidenceLink.upsert({
    where: { claimId_evidenceId: { claimId, evidenceId: evidence.id } },
    update: {},
    create: {
      claimId, evidenceId: evidence.id, direction: input.direction as never,
      logLikelihoodRatio: input.logLikelihoodRatio, sourceKey: input.sourceKey,
      decayExempt: input.decayExempt ?? false, attachedBy: input.attachedBy,
    },
  });

  const after = await recompute(claimId);
  await publishEvent('claim.evidence.attached', claimId, { evidenceId: evidence.id, tier: input.tier, direction: input.direction });
  if (Math.abs(after.posteriorProb - before) >= 0.05) {
    await publishEvent('claim.posterior.updated', claimId, { before, after: after.posteriorProb });
  }
  const auto = await maybeAutoTransition(claimId);
  return { posteriorBefore: before, posteriorAfter: after.posteriorProb, effectiveEvidence: after.effectiveEvidence, evidenceId: evidence.id, autoTransitionedTo: auto };
}

/** Recompute the posterior from links + decay (the derived state; invariant 3). */
export async function recompute(claimId: string, nowMs: number = Date.now()) {
  const claim = await prisma.claim.findUnique({ where: { id: claimId }, include: { evidenceLinks: { include: { evidence: true } } } });
  if (!claim) throw new AppError(404, 'CLAIM_NOT_FOUND', `Claim ${claimId} not found.`);

  const links: PosteriorEvidenceLink[] = claim.evidenceLinks.map((l) => ({
    direction: l.direction as EvidenceDirection, tier: l.evidence.tier as EvidenceTier,
    logLikelihoodRatio: l.logLikelihoodRatio, sourceKey: l.sourceKey, decayExempt: l.decayExempt,
    observedAtMs: l.evidence.observedAt.getTime(),
  }));
  const r = computePosterior(claim.priorLogOdds, links, nowMs, claim.halfLifeDays);

  // Track how long the posterior has held above the SPEC_BOUND threshold (0.9).
  const held = r.posteriorProb >= 0.9;
  const thresholdHeldSince = held ? (claim.thresholdHeldSince ?? new Date(nowMs)) : null;

  await prisma.claim.update({
    where: { id: claimId },
    data: {
      posteriorLogOdds: r.posteriorLogOdds, posteriorProb: r.posteriorProb, effectiveEvidence: r.effectiveEvidence,
      lastComputedAt: new Date(nowMs), thresholdHeldSince,
    },
  });
  return r;
}

async function tierContext(claimId: string) {
  const links = await prisma.evidenceLink.findMany({ where: { claimId }, include: { evidence: { select: { tier: true } } } });
  return links.map((l) => l.evidence.tier as EvidenceTier);
}

async function maybeAutoTransition(claimId: string): Promise<string | null> {
  const claim = await prisma.claim.findUnique({ where: { id: claimId } });
  if (!claim) return null;
  const presentTiers = await tierContext(claimId);
  const ctx = {
    posteriorProb: claim.posteriorProb, effectiveEvidence: claim.effectiveEvidence, presentTiers,
    approvedBy: null, thresholdHeldSinceMs: claim.thresholdHeldSince?.getTime() ?? null, nowMs: Date.now(),
  };
  const to = autoTransitionFor(claim.maturity as MaturityState, ctx);
  if (!to) return null;
  await applyTransition(claim.id, claim.maturity as MaturityState, to, null);
  return to;
}

// ── Gated transition ──────────────────────────────────────────────────────────
export async function transition(claimId: string, toState: MaturityState, approvedBy?: string | null) {
  const claim = await prisma.claim.findUnique({ where: { id: claimId } });
  if (!claim) throw new AppError(404, 'CLAIM_NOT_FOUND', `Claim ${claimId} not found.`);
  const presentTiers = await tierContext(claimId);
  const ctx = {
    posteriorProb: claim.posteriorProb, effectiveEvidence: claim.effectiveEvidence, presentTiers,
    approvedBy: approvedBy ?? null, thresholdHeldSinceMs: claim.thresholdHeldSince?.getTime() ?? null, nowMs: Date.now(),
  };
  const verdict = evaluateTransition(claim.maturity as MaturityState, toState, ctx);
  if (!verdict.allowed) throw new AppError(422, 'GATE_UNMET', verdict.reason ?? 'transition not allowed', { from: claim.maturity, to: toState });
  return applyTransition(claimId, claim.maturity as MaturityState, toState, approvedBy ?? null);
}

async function applyTransition(claimId: string, from: MaturityState, to: MaturityState, approvedBy: string | null) {
  const claim = await prisma.claim.findUnique({ where: { id: claimId }, include: { evidenceLinks: true } });
  if (!claim) throw new AppError(404, 'CLAIM_NOT_FOUND', `Claim ${claimId} not found.`);
  const traceId = `claim-registry-${claimId}-${randomUUID()}`;
  const gate = DEFAULT_GATES[`${from}->${to}`];
  const evidenceHash = hashPayload(claim.evidenceLinks.map((l) => ({ e: l.evidenceId, d: l.direction, llr: l.logLikelihoodRatio })));

  await prisma.maturityTransition.create({
    data: {
      claimId, fromState: from as PrismaMaturity, toState: to as PrismaMaturity,
      thresholdProb: gate?.posteriorMin ?? 0, actualProb: claim.posteriorProb, evidenceHash,
      approvedBy, receiptTraceId: traceId,
    },
  });
  const updated = await prisma.claim.update({
    where: { id: claimId },
    data: { maturity: to as PrismaMaturity, ...(to === 'FALSIFIED' ? { status: 'FALSIFIED' as never } : {}) },
  });
  await emitReceipt({ traceId, kind: 'claim.maturity.changed', subjectKind: 'claim', subjectId: claimId, actorKind: approvedBy ? 'user' : 'system', actorId: approvedBy ?? 'auto', status: 'ok', payload: { from, to, posterior: claim.posteriorProb } });
  await publishEvent('claim.maturity.changed', claimId, { from, to, actualProb: claim.posteriorProb }, traceId);
  if (to === 'FALSIFIED') await publishEvent('claim.falsified', claimId, { posterior: claim.posteriorProb });

  // SPEC_BOUND writes a snapshot the Spec Control Plane can reference.
  let snapshotId: string | undefined;
  if (to === 'SPEC_BOUND') {
    snapshotId = hashPayload({ id: claimId, statement: claim.statement, posterior: claim.posteriorProb, evidenceHash, at: traceId });
    await publishEvent('claim.spec_bound', claimId, { snapshotId });
  }
  return { claim: updated, receiptTraceId: traceId, snapshotId };
}
