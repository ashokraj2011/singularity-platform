/**
 * claim-registry — service entrypoint (M-CR1). Express + Prisma, API on :8600.
 * Health + the claims API. On startup it will self-register with platform-registry
 * and mint its IAM service token (copied M11 patterns, wired in during hardening).
 */
import express, { type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { claimsRouter } from './routes/claims.router';
import { knowledgeRouter } from './routes/knowledge.router';
import { registryRouter } from './routes/registry.router';
import { ambiguityRouter } from './routes/ambiguity.router';
import { AppError } from './lib/errors';

export const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'claim-registry', plane: 'knowledge' }));

app.use('/api/v1', claimsRouter);
app.use('/api/v1', knowledgeRouter);
app.use('/api/v1', registryRouter);
app.use('/api/v1', ambiguityRouter);

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ code: 'VALIDATION_FAILED', message: 'Invalid request body', issues: err.issues });
    return;
  }
  // eslint-disable-next-line no-console
  console.error('[claim-registry] unhandled error', err);
  res.status(500).json({ code: 'INTERNAL', message: 'Internal error' });
};
app.use(errorHandler);

const PORT = Number(process.env.PORT ?? 8600);
if (require.main === module) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`claim-registry listening on :${PORT}`);
  });
}
