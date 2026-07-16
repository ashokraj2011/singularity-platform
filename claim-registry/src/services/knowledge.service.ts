/**
 * claim-registry — capture + lowering service (M-CR2). Knowledge-event intake is
 * PERMISSIVE (invariant 6 — capture is never blocked by governance); the lowering
 * pass turns a raw capture into claim candidates via the LLM gateway (model_alias,
 * no provider creds), each PRE-MATCHED against existing claims by canonicalKey so a
 * curator sees dedup hits rather than silently forking the graph. Candidates are
 * advisory; a human accepts (→ create or attach) or rejects.
 */
import { randomUUID } from 'crypto';
import type { CaptureSource, ClaimKind } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { hashPayload, statementCanonicalKey } from '../lib/canonical';
import { putPayload, getPayload } from '../lib/payload-store';
import { publishEvent } from '../lib/events';
import { loweringSystemPrompt, buildLoweringTask, parseLoweringResponse } from '../lib/lowering';
import { defaultGatewayLlm, type GatewayLlm } from '../lib/gateway';
import { createClaim } from './claim.service';
import { AppError } from '../lib/errors';
import { currentRegistryTenant } from '../lib/request-context';

export interface CaptureEventInput {
  source: CaptureSource;
  content: string; // the raw capture text (transcript/doc)
  externalRef?: string;
  capabilityId?: string | null;
  capturedBy: string;
}

/** Permissive intake — hash-dedup on contentHash; the same capture links, never re-ingests. */
export async function captureEvent(input: CaptureEventInput) {
  const tenantId = currentRegistryTenant();
  const contentHash = hashPayload({ source: input.source, content: input.content });
  const existing = await prisma.knowledgeEvent.findFirst({ where: { tenantId, contentHash } });
  if (existing) return { event: existing, deduped: true };

  const event = await prisma.knowledgeEvent.create({
    data: {
      tenantId,
      source: input.source, externalRef: input.externalRef ?? null, contentHash,
      payloadRef: putPayload(input.content), capabilityId: input.capabilityId ?? null, capturedBy: input.capturedBy,
    },
  });
  await publishEvent('knowledge.event.captured', event.id, { source: event.source, contentHash });
  return { event, deduped: false };
}

/** Run the lowering pass through the LLM gateway, persist pre-matched candidates. */
export async function lowerEvent(eventId: string, llm: GatewayLlm = defaultGatewayLlm) {
  const tenantId = currentRegistryTenant();
  const event = await prisma.knowledgeEvent.findFirst({ where: { id: eventId, tenantId } });
  if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', `KnowledgeEvent ${eventId} not found.`);

  let proposals;
  try {
    const transcript = getPayload(event.payloadRef);
    const traceId = `claim-registry-lower-${eventId}-${randomUUID()}`;
    const text = await llm.complete({ system: loweringSystemPrompt(), task: buildLoweringTask(transcript, { source: event.source }), traceId });
    proposals = parseLoweringResponse(text);
  } catch (err) {
    await prisma.knowledgeEvent.update({ where: { id: eventId }, data: { loweringStatus: 'FAILED' as never } });
    throw new AppError(502, 'LOWERING_FAILED', `Lowering pass failed: ${(err as Error).message}`);
  }

  // Pre-match each candidate against existing claims by canonicalKey (the dedup guard).
  const rows = await Promise.all(proposals.map(async (p) => {
    const canonicalKey = statementCanonicalKey(p.statement);
    const match = await prisma.claim.findFirst({ where: { tenantId, canonicalKey }, select: { id: true } });
    return prisma.loweringCandidate.create({
      data: {
        tenantId,
        eventId, proposedStatement: p.statement, proposedKind: p.kind as never,
        modelConfidence: p.confidence, matchedClaimId: match?.id ?? null,
      },
    });
  }));

  await prisma.knowledgeEvent.update({ where: { id: eventId }, data: { loweringStatus: (rows.length ? 'LOWERED' : 'NO_CLAIMS') as never } });
  for (const r of rows) await publishEvent('lowering.candidate.created', r.id, { eventId, matched: !!r.matchedClaimId });

  const matched = rows.filter((r) => r.matchedClaimId).length;
  return { candidates: rows, count: rows.length, matched };
}

export async function listCandidates(status?: string) {
  const tenantId = currentRegistryTenant();
  return {
    items: await prisma.loweringCandidate.findMany({
      where: { tenantId, ...(status ? { status: status as never } : {}) },
      orderBy: { createdAt: 'desc' }, take: 200,
    }),
  };
}

/** Accept a candidate → create a new claim, or (if pre-matched) attach to the existing one. */
export async function acceptCandidate(candidateId: string, reviewedBy: string) {
  const tenantId = currentRegistryTenant();
  const c = await prisma.loweringCandidate.findFirst({ where: { id: candidateId, tenantId } });
  if (!c) throw new AppError(404, 'CANDIDATE_NOT_FOUND', `LoweringCandidate ${candidateId} not found.`);
  if (c.status !== 'PENDING_REVIEW') throw new AppError(409, 'ALREADY_REVIEWED', `Candidate is ${c.status}.`);

  if (c.matchedClaimId) {
    const updated = await prisma.loweringCandidate.update({
      where: { id: candidateId }, data: { status: 'MERGED_TO_EXISTING' as never, reviewedBy, resultingClaimId: c.matchedClaimId },
    });
    await publishEvent('lowering.candidate.accepted', candidateId, { resultingClaimId: c.matchedClaimId, merged: true });
    return { candidate: updated, claimId: c.matchedClaimId, merged: true };
  }

  const { claim } = await createClaim({
    kind: c.proposedKind as ClaimKind, statement: c.proposedStatement, createdBy: reviewedBy,
    provenance: { knowledgeEventId: c.eventId, loweringCandidateId: c.id, capturedFrom: 'lowering' },
  });
  const updated = await prisma.loweringCandidate.update({
    where: { id: candidateId }, data: { status: 'ACCEPTED' as never, reviewedBy, resultingClaimId: claim.id },
  });
  await publishEvent('lowering.candidate.accepted', candidateId, { resultingClaimId: claim.id, merged: false });
  return { candidate: updated, claimId: claim.id, merged: false };
}

export async function rejectCandidate(candidateId: string, reviewedBy: string) {
  const c = await prisma.loweringCandidate.findFirst({ where: { id: candidateId, tenantId: currentRegistryTenant() } });
  if (!c) throw new AppError(404, 'CANDIDATE_NOT_FOUND', `LoweringCandidate ${candidateId} not found.`);
  const updated = await prisma.loweringCandidate.update({ where: { id: candidateId }, data: { status: 'REJECTED' as never, reviewedBy } });
  return { candidate: updated };
}
