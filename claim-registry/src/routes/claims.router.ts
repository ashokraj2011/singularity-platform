import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { createClaim, getClaim, attachEvidence, transition } from '../services/claim.service';
import type { MaturityState } from '../lib/maturity';

export const claimsRouter: Router = Router();

const CLAIM_KINDS = ['HYPOTHESIS', 'ASSUMPTION', 'OBSERVATION', 'CONSTRAINT', 'DECISION', 'REQUIREMENT'] as const;
const TIERS = ['T0', 'T1', 'T2', 'T3'] as const;
const DIRECTIONS = ['SUPPORTS', 'CONTRADICTS'] as const;
const EVIDENCE_KINDS = ['DATA_PULL', 'PROD_TELEMETRY', 'EXPERIMENT', 'SPIKE', 'USABILITY_SESSION', 'INTERVIEW', 'EXPERT_OPINION', 'DOCUMENT', 'MARKET_SIGNAL'] as const;
const STATES = ['FRAGMENT', 'HYPOTHESIS', 'VALIDATED', 'REQUIREMENT', 'SPEC_BOUND', 'FALSIFIED'] as const;

const createSchema = z.object({
  kind: z.enum(CLAIM_KINDS),
  statement: z.string().trim().min(1).max(2000),
  capabilityId: z.string().uuid().nullable().optional(),
  subjectRefs: z.array(z.unknown()).max(50).optional(),
  tags: z.array(z.string().max(64)).max(50).optional(),
  provenance: z.record(z.unknown()).optional(),
  force: z.boolean().optional(),
});
const evidenceSchema = z.object({
  tier: z.enum(TIERS),
  kind: z.enum(EVIDENCE_KINDS),
  direction: z.enum(DIRECTIONS),
  logLikelihoodRatio: z.number(),
  sourceKey: z.string().trim().min(1).max(200),
  excerpt: z.string().trim().min(1).max(4000),
  observedAt: z.string().datetime(),
  sourceMeta: z.record(z.unknown()).optional(),
  decayExempt: z.boolean().optional(),
  payloadRef: z.string().optional(),
});
const transitionSchema = z.object({ toState: z.enum(STATES), approvedBy: z.string().optional() });

// Actor resolution — M-CR1 reads x-user-id / x-service-name; the copied IAM
// JWT-verify middleware (mint at bootstrap, verify inbound) lands in hardening.
const actorOf = (req: Request) => String(req.header('x-user-id') ?? req.header('x-service-name') ?? 'system');
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

claimsRouter.post('/claims', wrap(async (req, res) => {
  const body = createSchema.parse(req.body);
  res.status(201).json(await createClaim({ ...body, createdBy: actorOf(req) }));
}));

claimsRouter.get('/claims/:id', wrap(async (req, res) => {
  res.json(await getClaim(String(req.params.id)));
}));

claimsRouter.post('/claims/:id/evidence', wrap(async (req, res) => {
  const body = evidenceSchema.parse(req.body);
  res.status(201).json(await attachEvidence(String(req.params.id), { ...body, attachedBy: actorOf(req) }));
}));

claimsRouter.post('/claims/:id/transition', wrap(async (req, res) => {
  const body = transitionSchema.parse(req.body);
  res.json(await transition(String(req.params.id), body.toState as MaturityState, body.approvedBy ?? actorOf(req)));
}));
