import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { resolveRefs, promoteFromRoom, runDecayRecompute } from '../services/registry.service';
import { runContradictionSweep, runStarvationSweep, runAllSweeps } from '../services/sweeps.service';
import { requireServicePrincipal } from '../middleware/auth';

export const registryRouter: Router = Router();

const CLAIM_KINDS = ['HYPOTHESIS', 'ASSUMPTION', 'OBSERVATION', 'CONSTRAINT', 'DECISION', 'REQUIREMENT'] as const;

const resolveSchema = z.object({
  refs: z.array(z.object({ kind: z.string().min(1), id: z.string().min(1) })).min(1).max(100),
});
const promoteSchema = z.object({
  statement: z.string().trim().min(1).max(2000),
  kind: z.enum(CLAIM_KINDS),
  alpha: z.number().positive(),
  beta: z.number().positive(),
  roomClaimId: z.string().min(1),
  capabilityId: z.string().uuid().nullable().optional(),
});

const actorOf = (req: Request) => req.registryActor?.userId ?? 'unknown';
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

// M11.b resolver: 200 = every ref exists, 207 = at least one missing (Workgraph 422s on 207).
registryRouter.post('/lookup/resolve', wrap(async (req, res) => {
  const { refs } = resolveSchema.parse(req.body);
  const result = await resolveRefs(refs);
  res.status(result.all_ok ? 200 : 207).json(result);
}));

// Rooms → registry promotion (Beta → log-odds).
registryRouter.post('/promotions', wrap(async (req, res) => {
  const body = promoteSchema.parse(req.body);
  res.status(201).json(await promoteFromRoom({ ...body, promotedBy: actorOf(req) }));
}));

// Lifecycle sweeps (a scheduler POSTs these nightly). Each opens ledger rows; none demote.
registryRouter.post('/jobs/decay-recompute', requireServicePrincipal, wrap(async (_req, res) => {
  res.json(await runDecayRecompute());
}));
registryRouter.post('/jobs/contradiction-sweep', requireServicePrincipal, wrap(async (_req, res) => {
  res.json(await runContradictionSweep());
}));
registryRouter.post('/jobs/starvation-sweep', requireServicePrincipal, wrap(async (_req, res) => {
  res.json(await runStarvationSweep());
}));
registryRouter.post('/jobs/sweep-all', requireServicePrincipal, wrap(async (_req, res) => {
  res.json(await runAllSweeps());
}));
