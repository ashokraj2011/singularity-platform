/**
 * claim-registry — ambiguity ledger + relations + projections (M-CR4). All mounted at
 * /api/v1. The sweep /jobs endpoints live in registry.router alongside decay-recompute.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { listAmbiguities, acknowledgeAmbiguity, resolveAmbiguity, openAmbiguity } from '../services/ambiguity.service';
import { assertRelation, listRelations } from '../services/relation.service';
import { assumptionRegister } from '../services/projections.service';

export const ambiguityRouter: Router = Router();

const AMBIGUITY_TYPES = ['CONTRADICTION', 'MISSING_EVIDENCE', 'STARVATION'] as const;
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
const RELATION_TYPES = ['CONTRADICTS', 'DEPENDS_ON', 'REFINES', 'DUPLICATES'] as const;

const actorOf = (req: Request) => req.registryActor?.userId ?? 'unknown';
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

// ── Ambiguity ledger ──────────────────────────────────────────────────────────
ambiguityRouter.get('/ambiguities', wrap(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  const claimId = typeof req.query.claimId === 'string' ? req.query.claimId : undefined;
  res.json(await listAmbiguities({ status, type, claimId }));
}));

const manualOpenSchema = z.object({
  type: z.enum(AMBIGUITY_TYPES),
  claimId: z.string().min(1),
  relatedClaimId: z.string().min(1).nullable().optional(),
  severity: z.enum(SEVERITIES).optional(),
  detail: z.record(z.unknown()).optional(),
});
// Manual open — a human flags a tension the sweeps can't detect. Idempotent (200 if it existed).
ambiguityRouter.post('/ambiguities', wrap(async (req, res) => {
  const body = manualOpenSchema.parse(req.body);
  const r = await openAmbiguity({ ...body, openedBy: actorOf(req) });
  res.status(r.created ? 201 : 200).json(r);
}));

const noteSchema = z.object({ note: z.string().max(2000).optional() });
ambiguityRouter.post('/ambiguities/:id/acknowledge', wrap(async (req, res) => {
  res.json(await acknowledgeAmbiguity(String(req.params.id), actorOf(req)));
}));
ambiguityRouter.post('/ambiguities/:id/resolve', wrap(async (req, res) => {
  const { note } = noteSchema.parse(req.body ?? {});
  res.json(await resolveAmbiguity(String(req.params.id), actorOf(req), note, false));
}));
ambiguityRouter.post('/ambiguities/:id/dismiss', wrap(async (req, res) => {
  const { note } = noteSchema.parse(req.body ?? {});
  res.json(await resolveAmbiguity(String(req.params.id), actorOf(req), note, true));
}));

// ── Claim relations (input to the contradiction sweep) ────────────────────────
const relationSchema = z.object({
  toClaimId: z.string().min(1),
  type: z.enum(RELATION_TYPES),
  note: z.string().max(2000).optional(),
});
ambiguityRouter.post('/claims/:id/relations', wrap(async (req, res) => {
  const body = relationSchema.parse(req.body);
  res.status(201).json(await assertRelation({ fromClaimId: String(req.params.id), ...body, createdBy: actorOf(req) }));
}));
ambiguityRouter.get('/claims/:id/relations', wrap(async (req, res) => {
  res.json(await listRelations(String(req.params.id)));
}));

// ── Projections ───────────────────────────────────────────────────────────────
ambiguityRouter.get('/projections/assumption-register', wrap(async (req, res) => {
  const capabilityId = typeof req.query.capabilityId === 'string' ? req.query.capabilityId : undefined;
  res.json(await assumptionRegister({ capabilityId }));
}));
