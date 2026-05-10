/**
 * /api/v1/* — Service + Contract Registry routes (M11.a).
 *
 * Auth model: POST /register requires a token from REGISTER_TOKENS env (or
 * is open in dev when REGISTER_TOKENS is empty). All GET routes are public
 * read-only — the registry is meant to be browseable by humans + tools.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { pool } from '../db/pool.js'
import { allowedRegisterTokens } from '../config.js'

export const registryRoutes: Router = Router()

// ── helpers ────────────────────────────────────────────────────────────────

function bearerFrom(req: Request): string | undefined {
  const h = req.headers.authorization
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return undefined
  return h.slice(7)
}

function requireRegisterToken(req: Request, res: Response, next: NextFunction): void {
  if (allowedRegisterTokens.size === 0) return next()  // dev mode
  const tok = bearerFrom(req)
  if (!tok || !allowedRegisterTokens.has(tok)) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'register-token required' })
    return
  }
  next()
}

// ── schemas ────────────────────────────────────────────────────────────────

const capabilitySchema = z.object({
  capability_key: z.string().min(1),
  description:    z.string().optional(),
  metadata:       z.record(z.string(), z.unknown()).optional(),
})

const contractSchema = z.object({
  kind:         z.enum(['openapi', 'tool-schema', 'event-contract', 'workflow-node-contract']),
  contract_key: z.string().min(1),
  version:      z.string().min(1),
  source_url:   z.string().url(),
  sha256:       z.string().optional(),
  metadata:     z.record(z.string(), z.unknown()).optional(),
})

const registerSchema = z.object({
  service_name:  z.string().min(1),
  display_name:  z.string().min(1),
  version:       z.string().min(1),
  base_url:      z.string().url(),
  internal_url:  z.string().optional(),
  health_path:   z.string().default('/health'),
  auth_mode:     z.enum(['none', 'bearer-iam', 'bearer-static', 'mtls']),
  owner_team:    z.string().optional(),
  metadata:      z.record(z.string(), z.unknown()).optional(),
  capabilities:  z.array(capabilitySchema).default([]),
  contracts:     z.array(contractSchema).default([]),
})

// ── POST /register ─────────────────────────────────────────────────────────

registryRoutes.post('/register', requireRegisterToken, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'invalid payload', details: parsed.error.flatten() })
  }
  const r = parsed.data
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO service_registrations
         (service_name, display_name, version, base_url, internal_url, health_path,
          auth_mode, owner_team, metadata, registered_at, last_seen_at, last_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now(), now(), 'registered')
       ON CONFLICT (service_name) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         version      = EXCLUDED.version,
         base_url     = EXCLUDED.base_url,
         internal_url = EXCLUDED.internal_url,
         health_path  = EXCLUDED.health_path,
         auth_mode    = EXCLUDED.auth_mode,
         owner_team   = EXCLUDED.owner_team,
         metadata     = EXCLUDED.metadata,
         last_seen_at = now(),
         last_status  = 'registered'`,
      [
        r.service_name, r.display_name, r.version, r.base_url, r.internal_url ?? null,
        r.health_path, r.auth_mode, r.owner_team ?? null, JSON.stringify(r.metadata ?? {}),
      ],
    )
    // Replace capabilities (idempotent re-register).
    await client.query('DELETE FROM service_capabilities WHERE service_name = $1', [r.service_name])
    for (const c of r.capabilities) {
      await client.query(
        `INSERT INTO service_capabilities (service_name, capability_key, description, metadata)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (service_name, capability_key) DO NOTHING`,
        [r.service_name, c.capability_key, c.description ?? null, JSON.stringify(c.metadata ?? {})],
      )
    }
    // Upsert contracts (kept across registrations so version history is preserved).
    for (const c of r.contracts) {
      await client.query(
        `INSERT INTO service_contracts (service_name, kind, contract_key, version, source_url, sha256, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (service_name, kind, contract_key, version) DO UPDATE SET
           source_url = EXCLUDED.source_url,
           sha256     = EXCLUDED.sha256,
           metadata   = EXCLUDED.metadata,
           fetched_at = now()`,
        [r.service_name, c.kind, c.contract_key, c.version, c.source_url, c.sha256 ?? null, JSON.stringify(c.metadata ?? {})],
      )
    }
    await client.query('COMMIT')
    res.status(201).json({ ok: true, service_name: r.service_name, registered_at: new Date().toISOString() })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ code: 'INTERNAL', message: (err as Error).message })
  } finally {
    client.release()
  }
})

// ── GET /services + /services/:name ────────────────────────────────────────

registryRoutes.get('/services', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT s.service_name, s.display_name, s.version, s.base_url, s.internal_url,
           s.health_path, s.auth_mode, s.owner_team, s.metadata,
           s.registered_at, s.last_seen_at, s.last_status,
           COALESCE(jsonb_agg(DISTINCT c.capability_key) FILTER (WHERE c.capability_key IS NOT NULL), '[]'::jsonb) AS capabilities
    FROM service_registrations s
    LEFT JOIN service_capabilities c USING (service_name)
    GROUP BY s.service_name
    ORDER BY s.service_name
  `)
  res.json({ items: rows, total: rows.length })
})

registryRoutes.get('/services/:name', async (req, res) => {
  const name = req.params.name
  const svc = await pool.query(
    `SELECT * FROM service_registrations WHERE service_name = $1`, [name],
  )
  if (svc.rowCount === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: `service ${name} not registered` })
  }
  const caps = await pool.query(
    `SELECT capability_key, description, metadata
     FROM service_capabilities WHERE service_name = $1
     ORDER BY capability_key`, [name],
  )
  const contracts = await pool.query(
    `SELECT id, kind, contract_key, version, source_url, sha256, metadata, fetched_at
     FROM service_contracts WHERE service_name = $1
     ORDER BY kind, contract_key, version DESC`, [name],
  )
  res.json({
    ...svc.rows[0],
    capabilities: caps.rows,
    contracts:    contracts.rows,
  })
})

// ── GET /contracts (cross-service browse) ──────────────────────────────────

registryRoutes.get('/contracts', async (req, res) => {
  const kind = (req.query.kind as string | undefined) ?? undefined
  const key  = (req.query.contract_key as string | undefined) ?? undefined
  const conditions: string[] = []
  const params: unknown[] = []
  if (kind) { params.push(kind);                       conditions.push(`kind = $${params.length}`) }
  if (key)  { params.push(key);                        conditions.push(`contract_key = $${params.length}`) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const { rows } = await pool.query(
    `SELECT service_name, kind, contract_key, version, source_url, sha256, fetched_at
     FROM service_contracts ${where}
     ORDER BY service_name, kind, contract_key, version DESC`,
    params,
  )
  res.json({ items: rows, total: rows.length })
})

// ── POST /services/:name/heartbeat — light-touch liveness signal ───────────

registryRoutes.post('/services/:name/heartbeat', requireRegisterToken, async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE service_registrations
     SET last_seen_at = now(), last_status = 'healthy'
     WHERE service_name = $1`,
    [req.params.name],
  )
  if (rowCount === 0) return res.status(404).json({ code: 'NOT_FOUND' })
  res.json({ ok: true })
})

// ── GET /capabilities — flat search across services ───────────────────────

registryRoutes.get('/capabilities', async (req, res) => {
  const key = req.query.key as string | undefined
  const conditions: string[] = []
  const params: unknown[] = []
  if (key) { params.push(`%${key}%`); conditions.push(`capability_key ILIKE $${params.length}`) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const { rows } = await pool.query(
    `SELECT service_name, capability_key, description, metadata, created_at
     FROM service_capabilities ${where}
     ORDER BY capability_key, service_name`,
    params,
  )
  res.json({ items: rows, total: rows.length })
})
