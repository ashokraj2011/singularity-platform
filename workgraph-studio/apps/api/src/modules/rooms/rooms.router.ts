/**
 * Rooms & Claims API — mounted at /api/studio. The demand-side epistemic layer: rooms over a project,
 * claims carrying Beta posteriors + a human steward, belief estimates that pool, a "most contested"
 * ranking (variance = ignorance), an AI-peer copilot, and the decayed-on-read registry.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import { validate } from "../../middleware/validate";
import { createRoom, listRooms, getRoom, addClaim, getClaim, estimateClaim, listClaims, getRegistryClaims } from "./rooms.service";
import { proposeClaims, acceptCopilotClaim } from "./room-copilot.service";
import { createProbe, listProbes, resolveProbe, abandonProbe, abandonClaim, getRoomConvergence } from "./probes.service";

export const roomsRouter: Router = Router();

const claimTypeEnum = z.enum(["MARKET", "USER", "OPERATIONAL", "TECHNICAL"]);
const evidenceTierEnum = z.enum(["PRODUCTION", "EXPERIMENT", "SOURCE_DOCUMENT", "SIMULATION", "AGENT", "OPINION"]);
const createProbeSchema = z.object({
  riskiestAssumption: z.string().trim().min(1).max(2000),
  falsification: z.string().trim().min(1).max(2000),
  tier: evidenceTierEnum.optional(),
  ownerId: z.string().trim().max(200).optional(),
  deadline: z.string().datetime().optional(),
});
const resolveProbeSchema = z.object({
  supports: z.boolean(),
  weight: z.number().min(0).max(100).optional(),
  outcome: z.string().trim().max(2000).optional(),
  sourceUri: z.string().trim().max(600).optional(),
  note: z.string().trim().max(2000).optional(),
});
const createRoomSchema = z.object({ title: z.string().trim().min(1).max(200) });
const addClaimSchema = z.object({
  roomId: z.string().uuid().optional(),
  statement: z.string().trim().min(1).max(2000),
  riskiestAssumption: z.string().trim().max(2000).optional(),
  claimType: claimTypeEnum.optional(),
  contextScope: z.string().trim().max(120).optional(),
  entityKind: z.string().trim().max(60).optional(),
  entityId: z.string().trim().max(200).optional(),
  capabilityId: z.string().trim().max(200).optional(),
  stewardId: z.string().trim().max(200).optional(),
  initialEstimate: z.number().min(0).max(1).optional(),
  provenance: z.record(z.unknown()).optional(),
});
const estimateSchema = z.object({ probability: z.number().min(0).max(1), rationale: z.string().trim().max(2000).optional() });
const proposeSchema = z.object({ prompt: z.string().trim().min(1).max(8000) });
const acceptSchema = z.object({
  statement: z.string().trim().min(1).max(2000),
  riskiestAssumption: z.string().trim().max(2000).optional(),
  claimType: claimTypeEnum.optional(),
  selfEstimate: z.number().min(0).max(1),
  rationale: z.string().trim().max(2000).optional(),
  traceId: z.string().trim().max(200).optional(),
});

const userId = (req: Request) => req.user!.userId;
const projectId = (req: Request) => String(req.params.projectId);
const roomId = (req: Request) => String(req.params.roomId);
const claimId = (req: Request) => String(req.params.claimId);

// ── Rooms ──
roomsRouter.post("/projects/:projectId/rooms", validate(createRoomSchema), async (req, res, next) => {
  try { res.status(201).json(await createRoom(projectId(req), req.body, userId(req))); } catch (e) { next(e); }
});
roomsRouter.get("/projects/:projectId/rooms", async (req, res, next) => {
  try { res.json(await listRooms(projectId(req))); } catch (e) { next(e); }
});
roomsRouter.get("/rooms/:roomId", async (req, res, next) => {
  try { res.json(await getRoom(roomId(req))); } catch (e) { next(e); }
});

// ── Claims ──
roomsRouter.post("/projects/:projectId/claims", validate(addClaimSchema), async (req, res, next) => {
  try { res.status(201).json(await addClaim(projectId(req), req.body, userId(req))); } catch (e) { next(e); }
});
roomsRouter.get("/projects/:projectId/claims", async (req, res, next) => {
  try {
    const contested = req.query.contested === "true" || req.query.contested === "1";
    const roomFilter = typeof req.query.roomId === "string" ? req.query.roomId : undefined;
    res.json(await listClaims(projectId(req), { roomId: roomFilter, contested }));
  } catch (e) { next(e); }
});
roomsRouter.get("/claims/:claimId", async (req, res, next) => {
  try { res.json(await getClaim(claimId(req))); } catch (e) { next(e); }
});
roomsRouter.post("/claims/:claimId/estimate", validate(estimateSchema), async (req, res, next) => {
  try { res.json(await estimateClaim(claimId(req), req.body, userId(req), "HUMAN")); } catch (e) { next(e); }
});

// ── Copilot (AI peer) ──
roomsRouter.post("/rooms/:roomId/copilot/propose", validate(proposeSchema), async (req, res, next) => {
  try { res.json(await proposeClaims(roomId(req), req.body, userId(req))); } catch (e) { next(e); }
});
roomsRouter.post("/rooms/:roomId/copilot/accept", validate(acceptSchema), async (req, res, next) => {
  try { res.status(201).json(await acceptCopilotClaim(roomId(req), req.body, userId(req))); } catch (e) { next(e); }
});

// ── Probes & Evidence (Phase 2) ──
const probeId = (req: Request) => String(req.params.probeId);

roomsRouter.post("/claims/:claimId/probes", validate(createProbeSchema), async (req, res, next) => {
  try { res.status(201).json(await createProbe(claimId(req), req.body, userId(req))); } catch (e) { next(e); }
});
roomsRouter.get("/claims/:claimId/probes", async (req, res, next) => {
  try { res.json(await listProbes({ claimId: claimId(req) })); } catch (e) { next(e); }
});
roomsRouter.get("/rooms/:roomId/probes", async (req, res, next) => {
  try { res.json(await listProbes({ roomId: roomId(req) })); } catch (e) { next(e); }
});
roomsRouter.post("/probes/:probeId/resolve", validate(resolveProbeSchema), async (req, res, next) => {
  try { res.json(await resolveProbe(probeId(req), req.body, userId(req))); } catch (e) { next(e); }
});
roomsRouter.post("/probes/:probeId/abandon", async (req, res, next) => {
  try { res.json(await abandonProbe(probeId(req), userId(req))); } catch (e) { next(e); }
});
roomsRouter.post("/claims/:claimId/abandon", async (req, res, next) => {
  try { res.json(await abandonClaim(claimId(req), userId(req))); } catch (e) { next(e); }
});
roomsRouter.get("/rooms/:roomId/convergence", async (req, res, next) => {
  try { res.json(await getRoomConvergence(roomId(req))); } catch (e) { next(e); }
});

// ── Registry (decayed-on-read) ──
roomsRouter.get("/registry/claims", async (req, res, next) => {
  try {
    const contextScope = typeof req.query.contextScope === "string" ? req.query.contextScope : undefined;
    const proj = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    res.json(await getRegistryClaims({ contextScope, projectId: proj }));
  } catch (e) { next(e); }
});
