import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { captureEvent, lowerEvent, listCandidates, acceptCandidate, rejectCandidate } from '../services/knowledge.service';

export const knowledgeRouter: Router = Router();

const SOURCES = ['TRANSCRIPT', 'SLACK', 'CONFLUENCE', 'BOARD_EXPORT', 'WORKBENCH', 'MANUAL'] as const;

const captureSchema = z.object({
  source: z.enum(SOURCES),
  content: z.string().min(1).max(500_000),
  externalRef: z.string().max(500).optional(),
  capabilityId: z.string().uuid().nullable().optional(),
});

const actorOf = (req: Request) => req.registryActor?.userId ?? 'unknown';
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

// Permissive intake (invariant 6) — capture is never blocked.
knowledgeRouter.post('/knowledge-events', wrap(async (req, res) => {
  const body = captureSchema.parse(req.body);
  res.status(201).json(await captureEvent({ ...body, capturedBy: actorOf(req) }));
}));

knowledgeRouter.post('/knowledge-events/:id/lower', wrap(async (req, res) => {
  res.status(201).json(await lowerEvent(String(req.params.id)));
}));

knowledgeRouter.get('/lowering-candidates', wrap(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  res.json(await listCandidates(status));
}));

knowledgeRouter.post('/lowering-candidates/:id/accept', wrap(async (req, res) => {
  res.json(await acceptCandidate(String(req.params.id), actorOf(req)));
}));

knowledgeRouter.post('/lowering-candidates/:id/reject', wrap(async (req, res) => {
  res.json(await rejectCandidate(String(req.params.id), actorOf(req)));
}));
