import 'express-async-errors'
import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { z, ZodError } from 'zod'
import { ensureSchema, pool, query } from './db'

const PORT = Number(process.env.PORT ?? 3006)
const SERVICE_TOKEN = process.env.LEARNING_SERVICE_TOKEN ?? process.env.AUDIT_GOV_SERVICE_TOKEN ?? ''

function isProductionClassEnv(): boolean {
  return [
    process.env.NODE_ENV,
    process.env.APP_ENV,
    process.env.ENVIRONMENT,
    process.env.SINGULARITY_ENV,
  ].some((value) => ['production', 'prod', 'staging', 'perf'].includes((value ?? '').toLowerCase()))
}

const AUTH_OPTIONAL = !isProductionClassEnv()
  && (process.env.AUTH_OPTIONAL === 'true' || process.env.NODE_ENV !== 'production')

function requireServiceAuth(req: Request, res: Response, next: NextFunction): void {
  if (!SERVICE_TOKEN && AUTH_OPTIONAL) return next()
  const header = req.headers.authorization
  const token = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice(7)
    : String(req.headers['x-service-token'] ?? '')
  if (token && token === SERVICE_TOKEN) return next()
  res.status(401).json({ error: 'invalid service token' })
}

const app = express()
app.use(helmet())
app.use(cors({ origin: true, credentials: true }))
app.use(express.json({ limit: '2mb' }))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'learning-service' })
})

app.get('/healthz/strict', async (_req, res) => {
  await pool.query('SELECT 1')
  res.json({ ok: true, service: 'learning-service' })
})

app.get('/api/v1/failures/:capabilityId/summary', async (req, res) => {
  const rows = await query(
    `SELECT * FROM learning.capability_failure_summary
      WHERE capability_id = $1
      ORDER BY refreshed_at DESC
      LIMIT 1`,
    [req.params.capabilityId],
  )
  res.json({ summary: rows[0] ?? null })
})

app.get('/api/v1/patterns', async (req, res) => {
  const capabilityType = typeof req.query.capability_type === 'string' ? req.query.capability_type : null
  const capabilityId = typeof req.query.capability_id === 'string' ? req.query.capability_id : null
  const patternKind = typeof req.query.kind === 'string' ? req.query.kind : null
  const minSuccessRate = Number(req.query.min_success_rate ?? 0)
  const limit = Math.min(Math.max(Number(req.query.limit ?? 10) || 10, 1), 50)
  const rows = await query(
    `SELECT * FROM learning.capability_type_pattern
      WHERE ($1::text IS NULL OR capability_type = $1)
        AND ($2::text IS NULL OR capability_id = $2)
        AND ($3::text IS NULL OR pattern_kind = $3)
        AND ($4::numeric IS NULL OR success_rate IS NULL OR success_rate >= $4)
      ORDER BY updated_at DESC
      LIMIT $5`,
    [capabilityType, capabilityId, patternKind, Number.isFinite(minSuccessRate) ? minSuccessRate : null, limit],
  )
  res.json({ items: rows })
})

const patternSchema = z.object({
  capabilityId: z.string().optional(),
  capabilityType: z.string().optional(),
  patternKind: z.string().default('outcome'),
  summary: z.string().min(1),
  evidence: z.record(z.unknown()).default({}),
  successRate: z.number().min(0).max(1).optional(),
})

app.post('/api/v1/patterns', requireServiceAuth, async (req, res) => {
  const input = patternSchema.parse(req.body ?? {})
  const rows = await query<{ id: string }>(
    `INSERT INTO learning.capability_type_pattern
       (capability_id, capability_type, pattern_kind, summary, evidence, success_rate)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)
     RETURNING id`,
    [
      input.capabilityId ?? null,
      input.capabilityType ?? null,
      input.patternKind,
      input.summary,
      JSON.stringify(input.evidence ?? {}),
      input.successRate ?? null,
    ],
  )
  res.status(201).json({ id: rows[0].id, status: 'recorded' })
})

const refreshSchema = z.object({
  capabilityId: z.string(),
  capabilityType: z.string().optional(),
  summary: z.string().min(1),
  evidence: z.record(z.unknown()).default({}),
  lastFailureAt: z.string().optional(),
})

app.post('/api/v1/summarize/refresh', requireServiceAuth, async (req, res) => {
  const input = refreshSchema.parse(req.body ?? {})
  const rows = await query<{ id: string }>(
    `INSERT INTO learning.capability_failure_summary
       (capability_id, capability_type, summary, evidence, last_failure_at)
     VALUES ($1,$2,$3,$4::jsonb,$5)
     RETURNING id`,
    [
      input.capabilityId,
      input.capabilityType ?? null,
      input.summary,
      JSON.stringify(input.evidence ?? {}),
      input.lastFailureAt ?? null,
    ],
  )
  res.status(201).json({ id: rows[0].id, status: 'refreshed' })
})

app.get('/api/v1/state', async (req, res) => {
  const capabilityId = typeof req.query.capabilityId === 'string' ? req.query.capabilityId : null
  const capabilityType = typeof req.query.capabilityType === 'string' ? req.query.capabilityType : null
  const failures = capabilityId
    ? await query(
      `SELECT * FROM learning.capability_failure_summary
        WHERE capability_id = $1
        ORDER BY refreshed_at DESC
        LIMIT 1`,
      [capabilityId],
    )
    : []
  const patterns = await query(
    `SELECT * FROM learning.capability_type_pattern
      WHERE ($1::text IS NULL OR capability_type = $1)
         OR ($2::text IS NOT NULL AND capability_id = $2)
      ORDER BY updated_at DESC
      LIMIT 8`,
    [capabilityType, capabilityId],
  )
  res.json({
    failureSummary: failures[0] ?? null,
    patterns,
    degraded: false,
  })
})

app.get('/api/v1/similar-capabilities/:capabilityId', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 5) || 5, 1), 20)
  const patterns = await query(
    `SELECT * FROM learning.capability_type_pattern
      WHERE capability_id IS NOT NULL AND capability_id <> $1
      ORDER BY updated_at DESC
      LIMIT $2`,
    [req.params.capabilityId, limit],
  )
  res.json({ items: patterns })
})

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'validation', details: err.flatten() })
    return
  }
  console.error('[learning-service] unhandled', err)
  res.status(500).json({ error: (err as Error).message ?? 'internal error' })
})

ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[learning-service] listening on ${PORT}`)
    })
  })
  .catch(err => {
    console.error('[learning-service] startup failed', err)
    process.exit(1)
  })
