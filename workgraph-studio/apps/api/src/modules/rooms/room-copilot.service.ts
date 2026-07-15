/**
 * Room copilot service — runs the AI peer through Context Fabric's governed single-turn (so every
 * proposal carries a provenance/correlation trail for free), then lets a human ACCEPT a candidate.
 * On accept: the human becomes the claim's steward (accountability never transfers), and the
 * copilot's self-estimate is recorded as an AGENT peer estimate. Reuses the spec-generation LLM seam.
 */
import { randomUUID } from "crypto";
import { prisma } from "../../lib/prisma";
import { contextFabricClient } from "../../lib/context-fabric/client";
import { NotFoundError } from "../../lib/errors";
import { addClaim, estimateClaim, getClaim } from "./rooms.service";
import { roomCopilotSystemPrompt, buildProposeTask, parseCopilotResponse, type CandidateClaim, type CopilotResult } from "./room-copilot";

const COPILOT_ESTIMATOR_ID = "studio-copilot";

/** The single model call the copilot needs — injectable so the service is unit-testable with a fake. */
export interface RoomCopilotLlm {
  complete(input: { system: string; task: string; traceId: string; actorId: string; projectId: string; roomId: string; temperature: number }): Promise<string>;
}

// Default: Context Fabric governed single-turn, project-scoped (its own surface + capability).
export const defaultRoomCopilotLlm: RoomCopilotLlm = {
  async complete({ system, task, traceId, actorId, projectId, roomId, temperature }) {
    const res = await contextFabricClient.executeGovernedTurn({
      trace_id: traceId,
      run_context: {
        project_id: projectId,
        room_id: roomId,
        capability_id: process.env.ROOM_COPILOT_CAPABILITY_ID ?? "studio-room",
        user_id: actorId,
        surface: "studio-room",
      },
      system_prompt: system,
      task,
      model_overrides: { temperature, maxOutputTokens: 3000 },
      limits: { outputTokenBudget: 3000, timeoutSec: 120 },
    });
    return res.finalResponse ?? "";
  },
};

export async function proposeClaims(
  roomId: string,
  input: { prompt: string },
  actorId: string,
  llm: RoomCopilotLlm = defaultRoomCopilotLlm,
): Promise<CopilotResult & { traceId: string }> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { project: { select: { name: true, mission: true } }, claims: { select: { statement: true }, take: 30 } },
  });
  if (!room) throw new NotFoundError("Room", roomId);

  const traceId = `studio-room-${roomId}-${randomUUID()}`;
  const text = await llm.complete({
    system: roomCopilotSystemPrompt(),
    task: buildProposeTask({ projectName: room.project.name, mission: room.project.mission, roomTitle: room.title, existingClaims: room.claims, prompt: input.prompt }),
    traceId,
    actorId,
    projectId: room.projectId,
    roomId,
    temperature: 0.7, // diverge — the room needs structurally distinct framings, not the safe answer
  });
  return { ...parseCopilotResponse(text), traceId };
}

/** Accept an AI-proposed candidate: the human is steward; the copilot's self-estimate is a peer estimate. */
export async function acceptCopilotClaim(roomId: string, candidate: CandidateClaim & { traceId?: string }, actorId: string) {
  const room = await prisma.room.findUnique({ where: { id: roomId }, select: { projectId: true } });
  if (!room) throw new NotFoundError("Room", roomId);

  const claim = await addClaim(
    room.projectId,
    {
      roomId,
      statement: candidate.statement,
      riskiestAssumption: candidate.riskiestAssumption,
      claimType: candidate.claimType,
      stewardId: actorId, // hard invariant: a human is accountable
      provenance: { origin: "ai", copilot: "studio-room", traceId: candidate.traceId, rationale: candidate.rationale, selfEstimate: candidate.selfEstimate },
    },
    actorId,
  );
  // Record the copilot's belief as an AGENT peer estimate (it pools alongside the humans').
  await estimateClaim(claim.id, { probability: candidate.selfEstimate, rationale: candidate.rationale }, COPILOT_ESTIMATOR_ID, "AGENT");
  return getClaim(claim.id);
}
