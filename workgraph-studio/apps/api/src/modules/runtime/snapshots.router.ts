/**
 * Browser-runtime snapshot endpoints.
 *
 *   POST /api/runs/:runId/snapshot   — upsert a run snapshot (OCC by version)
 *   GET  /api/runs/:runId/snapshot   — fetch latest blob for a run
 *   GET  /api/runs?mine=true         — list snapshots created by the caller
 *
 * The browser owns the runtime state machine; this router is dumb storage:
 *   - first POST inserts; subsequent POSTs only succeed when the incoming
 *     `version` is strictly greater than the stored one (409 otherwise);
 *   - `GET /:runId/snapshot` returns the full payload so a fresh tab can
 *     hydrate when IndexedDB is empty.
 */

import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { logEvent } from '../../lib/audit'
import { ForbiddenError } from '../../lib/errors'
import { requireTenantFromRequest, resolveTenantFromRequest, tenantIsolationStrict } from '../../lib/tenant-isolation'
import { withTenantDbTransaction } from '../../lib/tenant-db-context'

export const snapshotsRouter: Router = Router()

const snapshotPayload = z.object({
  workflowId:  z.string().min(1),
  name:        z.string().min(1),
  status:      z.string().min(1),
  version:     z.number().int().positive(),
  payload:     z.unknown(),
})

// ── POST /:runId/snapshot ────────────────────────────────────────────────────

snapshotsRouter.post('/:runId/snapshot', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = snapshotPayload.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid snapshot payload', details: parsed.error.format() })
    }
    const runId = req.params.runId as string
    const { workflowId, name, status, version, payload } = parsed.data
    const userId = (req as any).user?.userId as string | undefined
    const tenantId = tenantIsolationStrict()
      ? requireTenantFromRequest(req, 'run snapshot write')
      : resolveTenantFromRequest(req)

    const result = await withTenantDbTransaction(prisma, async () => {
      // Ensure the workflow actually exists (defensive — FK would catch it too).
      const wf = await prisma.workflow.findUnique({ where: { id: workflowId }, select: { id: true } })
      if (!wf) return { statusCode: 404, body: { error: 'Workflow not found' } }

      const existing = await prisma.runSnapshot.findUnique({ where: { runId } })

      if (!existing) {
        const created = await prisma.runSnapshot.create({
          data: {
            runId,
            workflowId,
            name,
            status,
            version,
            payload: payload as any,
            createdById: userId,
            tenantId: tenantId ?? null,
          },
        })
        await logEvent('RunSnapshotCreated', 'RunSnapshot', created.id, userId, { runId, workflowId, version })
        return { statusCode: 201, body: created }
      }

      if (tenantIsolationStrict()) {
        if (!existing.tenantId) {
          throw new ForbiddenError('Tenant isolation is strict but this run snapshot has no tenantId')
        }
        if (existing.tenantId !== tenantId) {
          throw new ForbiddenError('Tenant isolation denied run snapshot access')
        }
      }

      if (version <= existing.version) {
        return {
          statusCode: 409,
          body: {
            error: 'Stale snapshot version',
            stored: { version: existing.version, status: existing.status, updatedAt: existing.updatedAt },
          },
        }
      }

      const updated = await prisma.runSnapshot.update({
        where: { runId },
        data: { name, status, version, payload: payload as any, ...(tenantId && !existing.tenantId ? { tenantId } : {}) },
      })
      await logEvent('RunSnapshotUpdated', 'RunSnapshot', updated.id, userId, { runId, version, status })
      return { statusCode: 200, body: updated }
    }, tenantId)

    return res.status(result.statusCode).json(result.body)
  } catch (err) {
    next(err)
  }
})

// ── GET /:runId/snapshot ─────────────────────────────────────────────────────

snapshotsRouter.get('/:runId/snapshot', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const runId = req.params.runId as string
    const tenantId = tenantIsolationStrict()
      ? requireTenantFromRequest(req, 'run snapshot read')
      : resolveTenantFromRequest(req)
    const snap = await withTenantDbTransaction(prisma, async () => {
      return tenantIsolationStrict()
        ? prisma.runSnapshot.findFirst({ where: { runId, tenantId } })
        : prisma.runSnapshot.findUnique({ where: { runId } })
    }, tenantId)
    if (!snap) return res.status(404).json({ error: 'Run not found' })
    return res.json(snap)
  } catch (err) {
    next(err)
  }
})

// ── GET / — list snapshots ──────────────────────────────────────────────────

snapshotsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?.userId as string | undefined
    const mine = req.query.mine === 'true'
    const workflowId = typeof req.query.workflowId === 'string' ? req.query.workflowId : undefined
    const status = typeof req.query.status === 'string' ? req.query.status : undefined
    const tenantId = tenantIsolationStrict()
      ? requireTenantFromRequest(req, 'run snapshot listing')
      : resolveTenantFromRequest(req)

    const snaps = await withTenantDbTransaction(prisma, async () => {
      return prisma.runSnapshot.findMany({
        where: {
          ...(mine && userId ? { createdById: userId } : {}),
          ...(workflowId ? { workflowId } : {}),
          ...(status ? { status } : {}),
          ...(tenantIsolationStrict() ? { tenantId } : {}),
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
        include: {
          workflow: { select: { id: true, name: true } },
        },
      })
    }, tenantId)
    return res.json(snaps)
  } catch (err) {
    next(err)
  }
})

// ── DELETE /:runId — abandon a run ──────────────────────────────────────────

snapshotsRouter.delete('/:runId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const runId = req.params.runId as string
    const userId = (req as any).user?.userId as string | undefined
    const tenantId = tenantIsolationStrict()
      ? requireTenantFromRequest(req, 'run snapshot delete')
      : resolveTenantFromRequest(req)
    const deleted = await withTenantDbTransaction(prisma, async () => {
      const existing = tenantIsolationStrict()
        ? await prisma.runSnapshot.findFirst({ where: { runId, tenantId } })
        : await prisma.runSnapshot.findUnique({ where: { runId } })
      if (!existing) return null
      await prisma.runSnapshot.delete({ where: { runId } })
      await logEvent('RunSnapshotDeleted', 'RunSnapshot', existing.id, userId, { runId })
      return existing
    }, tenantId)
    if (!deleted) return res.status(404).json({ error: 'Run not found' })
    return res.status(204).end()
  } catch (err) {
    next(err)
  }
})
