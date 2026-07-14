/**
 * Probes & Evidence service (Phase 2). A probe pre-registers the cheapest test that could falsify a
 * claim's riskiest assumption; resolving it emits tier-capped, idempotent Evidence that moves the Beta
 * posterior (the real belief update — estimates only shape the prior). A room's convergence is computed
 * from the best remaining probe's gain-per-hour. Abandonment is a first-class terminal. All the belief
 * math is the pure engine in ./belief + ./probes.
 */
import type { EvidenceTier as PrismaEvidenceTier } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { currentTenantIdForDb } from "../../lib/tenant-db-context";
import { logEvent, publishOutbox } from "../../lib/audit";
import { NotFoundError } from "../../lib/errors";
import { expectedInfoGain, TIER_CAP, type EvidenceTier } from "./belief";
import { roomConvergence, DEFAULT_CONVERGENCE_BAR } from "./probes";
import { getClaim, recomputePosterior } from "./rooms.service";

const tenant = () => currentTenantIdForDb() ?? undefined;

export interface CreateProbeInput {
  riskiestAssumption: string;
  falsification: string;
  tier?: EvidenceTier;
  ownerId?: string;
  deadline?: string;
}

export async function createProbe(claimId: string, input: CreateProbeInput, userId: string) {
  const claim = await prisma.claim.findUnique({ where: { id: claimId }, select: { id: true, roomId: true, alpha: true, beta: true } });
  if (!claim) throw new NotFoundError("Claim", claimId);
  const tier = (input.tier ?? "SIMULATION") as PrismaEvidenceTier;
  const eig = expectedInfoGain({ alpha: claim.alpha, beta: claim.beta }, tier as EvidenceTier);
  const probe = await prisma.probe.create({
    data: {
      claimId,
      roomId: claim.roomId,
      riskiestAssumption: input.riskiestAssumption,
      falsification: input.falsification,
      tier,
      ownerId: input.ownerId ?? userId, // exactly one owner
      deadline: input.deadline ? new Date(input.deadline) : null,
      eig,
      createdById: userId,
      tenantId: tenant(),
    },
  });
  await logEvent("ProbeCreated", "Probe", probe.id, userId);
  return probe;
}

export async function listProbes(filter: { claimId?: string; roomId?: string }) {
  const items = await prisma.probe.findMany({
    where: { ...(filter.claimId ? { claimId: filter.claimId } : {}), ...(filter.roomId ? { roomId: filter.roomId } : {}) },
    orderBy: { createdAt: "desc" },
  });
  return { items };
}

export interface ResolveProbeInput {
  supports: boolean;
  weight?: number;
  outcome?: string;
  sourceUri?: string;
  note?: string;
}

/** Resolve a probe → emit Evidence (idempotent by identity) → re-fold the claim's posterior. */
export async function resolveProbe(probeId: string, input: ResolveProbeInput, userId: string) {
  const probe = await prisma.probe.findUnique({ where: { id: probeId } });
  if (!probe) throw new NotFoundError("Probe", probeId);
  if (probe.status !== "OPEN") return { probe, claim: await getClaim(probe.claimId) }; // already resolved — idempotent

  const evidenceKey = `probe:${probeId}`; // one probe → one evidence; identity makes promotion idempotent
  await prisma.evidence.upsert({
    where: { evidenceKey },
    create: {
      claimId: probe.claimId,
      probeId,
      tier: probe.tier,
      supports: input.supports,
      weight: input.weight ?? TIER_CAP[probe.tier as EvidenceTier], // a clean result is worth its tier's cap
      evidenceKey,
      sourceUri: input.sourceUri ?? null,
      note: input.note ?? null,
      createdById: userId,
      tenantId: tenant(),
    },
    update: {}, // same observation arriving again counts once
  });
  const updated = await prisma.probe.update({ where: { id: probeId }, data: { status: "RESOLVED", outcome: input.outcome ?? null } });
  await recomputePosterior(probe.claimId); // evidence moves the belief
  await logEvent("ProbeResolved", "Probe", probeId, userId);
  await publishOutbox("Claim", probe.claimId, "EvidencePromoted", { probeId, tier: probe.tier, supports: input.supports });
  return { probe: updated, claim: await getClaim(probe.claimId) };
}

export async function abandonProbe(probeId: string, userId: string) {
  const probe = await prisma.probe.findUnique({ where: { id: probeId }, select: { id: true } });
  if (!probe) throw new NotFoundError("Probe", probeId);
  const updated = await prisma.probe.update({ where: { id: probeId }, data: { status: "ABANDONED" } });
  await logEvent("ProbeAbandoned", "Probe", probeId, userId);
  return updated;
}

/** Abandonment is first-class: a room that cannot conclude "not worth building" manufactures specs. */
export async function abandonClaim(claimId: string, userId: string) {
  const claim = await prisma.claim.findUnique({ where: { id: claimId }, select: { id: true } });
  if (!claim) throw new NotFoundError("Claim", claimId);
  await prisma.claim.update({ where: { id: claimId }, data: { status: "ABANDONED" } });
  await logEvent("ClaimAbandoned", "Claim", claimId, userId);
  await publishOutbox("Claim", claimId, "ClaimAbandoned", { by: userId });
  return getClaim(claimId);
}

/** The room's stopping-rule readout: the best remaining probe's gain-per-hour vs the convergence bar. */
export async function getRoomConvergence(roomId: string) {
  const probes = await prisma.probe.findMany({ where: { roomId }, select: { eig: true, tier: true, status: true } });
  const conv = roomConvergence(probes.map((p) => ({ eig: p.eig, tier: p.tier as EvidenceTier, status: p.status })));
  return { ...conv, bar: DEFAULT_CONVERGENCE_BAR };
}
