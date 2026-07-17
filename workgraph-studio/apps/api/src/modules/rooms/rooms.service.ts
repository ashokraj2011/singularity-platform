/**
 * Rooms & Claims service — the epistemic spine. A Room is an ephemeral exploration over a project;
 * Claims are hypotheses carrying a Beta posterior + a human steward; Estimates are participants'
 * probabilities that pool into the claim's prior (their variance = where the team is most ignorant).
 * All the belief math is the pure engine in ./belief; this layer is persistence + shaping.
 */
import type { ClaimType, EstimatorKind, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { currentTenantIdForDb } from "../../lib/tenant-db-context";
import { logEvent, publishOutbox } from "../../lib/audit";
import { NotFoundError, ConflictError } from "../../lib/errors";
import { getProject } from "../studio/studio-projects.service";
import { poolEstimates, toBetaPrior, betaStats, decayOnRead, ignoranceRank, foldEvidence, UNIFORM_PRIOR, type ClaimTypeKey, type EvidenceTier } from "./belief";

const tenant = () => currentTenantIdForDb() ?? undefined;

// ── Rooms ────────────────────────────────────────────────────────────────────
export async function createRoom(projectId: string, input: { title: string }, userId: string) {
  await getProject(projectId);
  const room = await prisma.room.create({
    data: { projectId, title: input.title, createdById: userId, tenantId: tenant() },
  });
  await logEvent("RoomCreated", "Room", room.id, userId);
  return room;
}

export async function listRooms(projectId: string) {
  await getProject(projectId);
  const rooms = await prisma.room.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { claims: true } } },
  });
  return { items: rooms.map((r) => ({ ...stripCount(r), claimCount: r._count.claims })) };
}

export async function getRoom(roomId: string) {
  const room = await prisma.room.findUnique({ where: { id: roomId }, include: { claims: { include: { estimates: true } } } });
  if (!room) throw new NotFoundError("Room", roomId);
  return { ...room, claims: room.claims.map((c) => shapeClaim(c, c.estimates)) };
}

// ── Claims ───────────────────────────────────────────────────────────────────
type EstimateRow = { probability: number; weight: number; estimatorId: string; estimatorKind: EstimatorKind };
type ClaimRow = {
  id: string; projectId: string; roomId: string | null; statement: string; riskiestAssumption: string | null;
  claimType: ClaimType; contextScope: string; entityKind: string | null; entityId: string | null;
  capabilityId: string | null;
  alpha: number; beta: number; version: number; status: string; stewardId: string; provenance: unknown;
  createdAt: Date; updatedAt: Date;
};

/** Shape a claim for the client: its Beta stats + the estimator disagreement (the ignorance signal). */
export function shapeClaim(claim: ClaimRow, estimates: EstimateRow[]) {
  const stats = betaStats({ alpha: claim.alpha, beta: claim.beta });
  const pooled = poolEstimates(estimates.map((e) => ({ probability: e.probability, weight: e.weight })));
  return {
    id: claim.id,
    projectId: claim.projectId,
    roomId: claim.roomId,
    statement: claim.statement,
    riskiestAssumption: claim.riskiestAssumption,
    claimType: claim.claimType,
    contextScope: claim.contextScope,
    entityKind: claim.entityKind,
    entityId: claim.entityId,
    capabilityId: claim.capabilityId,
    status: claim.status,
    stewardId: claim.stewardId,
    alpha: claim.alpha,
    beta: claim.beta,
    mean: stats.mean,
    concentration: stats.concentration,
    disagreement: pooled.variance, // variance across estimators — locates ignorance
    estimateCount: estimates.length,
    provenance: claim.provenance,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
  };
}

/**
 * Recompute a claim's Beta posterior: pooled estimates form the prior, then Evidence is folded in
 * (tier-capped + idempotent by evidence identity). Called after every estimate change AND after a probe
 * resolves. Estimates shape the belief cheaply; evidence — from probes — is what actually moves it.
 */
export async function recomputePosterior(claimId: string): Promise<void> {
  const [estimates, evidence] = await Promise.all([
    prisma.estimate.findMany({ where: { claimId } }),
    prisma.evidence.findMany({ where: { claimId } }),
  ]);
  const prior = estimates.length
    ? toBetaPrior(poolEstimates(estimates.map((e) => ({ probability: e.probability, weight: e.weight }))).mean)
    : { ...UNIFORM_PRIOR };
  const posterior = foldEvidence(prior, evidence.map((ev) => ({ id: ev.id, supports: ev.supports, tier: ev.tier as EvidenceTier, weight: ev.weight })));
  await prisma.claim.update({ where: { id: claimId }, data: { alpha: posterior.alpha, beta: posterior.beta } });
}

export interface AddClaimInput {
  roomId?: string;
  statement: string;
  riskiestAssumption?: string;
  claimType?: ClaimType;
  contextScope?: string;
  entityKind?: string;
  entityId?: string;
  capabilityId?: string;
  stewardId?: string; // defaults to the caller — a human is always accountable
  initialEstimate?: number; // the steward's own P(true)
  provenance?: Record<string, unknown>;
}

export async function addClaim(projectId: string, input: AddClaimInput, userId: string) {
  await getProject(projectId);
  if (input.roomId) {
    const room = await prisma.room.findUnique({ where: { id: input.roomId }, select: { projectId: true } });
    if (!room || room.projectId !== projectId) throw new ConflictError("Room does not belong to this project.");
  }
  const created = await prisma.claim.create({
    data: {
      projectId,
      roomId: input.roomId ?? null,
      statement: input.statement,
      riskiestAssumption: input.riskiestAssumption ?? null,
      claimType: input.claimType ?? "TECHNICAL",
      contextScope: input.contextScope ?? "default",
      entityKind: input.entityKind ?? null,
      entityId: input.entityId ?? null,
      capabilityId: input.capabilityId ?? null,
      stewardId: input.stewardId ?? userId, // hard invariant: a human steward
      provenance: (input.provenance ?? { origin: "human", by: userId }) as Prisma.InputJsonValue,
      createdById: userId,
      tenantId: tenant(),
    },
  });
  if (typeof input.initialEstimate === "number") {
    await upsertEstimate(created.id, { probability: input.initialEstimate }, userId, "HUMAN");
    await recomputePosterior(created.id);
  }
  await logEvent("ClaimCreated", "Claim", created.id, userId);
  await publishOutbox("Claim", created.id, "ClaimCreated", { projectId, roomId: created.roomId, stewardId: created.stewardId });
  return getClaim(created.id);
}

export async function getClaim(claimId: string) {
  const claim = await prisma.claim.findUnique({ where: { id: claimId }, include: { estimates: true } });
  if (!claim) throw new NotFoundError("Claim", claimId);
  return shapeClaim(claim, claim.estimates);
}

async function upsertEstimate(claimId: string, input: { probability: number; weight?: number; rationale?: string }, estimatorId: string, estimatorKind: EstimatorKind) {
  await prisma.estimate.upsert({
    where: { claimId_estimatorId: { claimId, estimatorId } },
    create: { claimId, estimatorId, estimatorKind, probability: input.probability, weight: input.weight ?? 1, rationale: input.rationale ?? null, tenantId: tenant() },
    update: { probability: input.probability, ...(input.weight != null ? { weight: input.weight } : {}), rationale: input.rationale ?? null },
  });
}

export async function estimateClaim(claimId: string, input: { probability: number; rationale?: string }, estimatorId: string, estimatorKind: EstimatorKind = "HUMAN") {
  const claim = await prisma.claim.findUnique({ where: { id: claimId }, select: { id: true } });
  if (!claim) throw new NotFoundError("Claim", claimId);
  await upsertEstimate(claimId, input, estimatorId, estimatorKind);
  await recomputePosterior(claimId);
  await logEvent("ClaimEstimated", "Claim", claimId, estimatorId);
  return getClaim(claimId);
}

/** List a project's (or a room's) claims. `contested=true` ranks by disagreement — most ignorant first. */
export async function listClaims(projectId: string, opts: { roomId?: string; contested?: boolean } = {}) {
  await getProject(projectId);
  const claims = await prisma.claim.findMany({
    where: { projectId, ...(opts.roomId ? { roomId: opts.roomId } : {}) },
    include: { estimates: true },
    orderBy: { createdAt: "desc" },
  });
  const shaped = claims.map((c) => shapeClaim(c, c.estimates));
  return { items: opts.contested ? ignoranceRank(shaped) : shaped };
}

/** The registry read: claims across a context, DECAYED ON READ by evidence age + claim type. */
export async function getRegistryClaims(filter: { contextScope?: string; projectId?: string } = {}) {
  const claims = await prisma.claim.findMany({
    where: { ...(filter.contextScope ? { contextScope: filter.contextScope } : {}), ...(filter.projectId ? { projectId: filter.projectId } : {}) },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  const nowMs = Date.now();
  const items = claims.map((c) => {
    const ageDays = Math.max(0, (nowMs - c.updatedAt.getTime()) / 86_400_000);
    const decayed = decayOnRead({ alpha: c.alpha, beta: c.beta }, ageDays, c.claimType as ClaimTypeKey);
    const stats = betaStats(decayed);
    return {
      id: c.id,
      projectId: c.projectId,
      statement: c.statement,
      claimType: c.claimType,
      contextScope: c.contextScope,
      status: c.status,
      stewardId: c.stewardId,
      mean: stats.mean,
      concentration: stats.concentration,
      ageDays: Math.round(ageDays),
      updatedAt: c.updatedAt,
    };
  });
  return { items };
}

function stripCount<T extends { _count?: unknown }>(row: T): Omit<T, "_count"> {
  const { _count, ...rest } = row;
  return rest;
}
