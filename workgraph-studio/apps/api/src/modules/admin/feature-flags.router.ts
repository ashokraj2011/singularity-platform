/**
 * M42.0 — Feature-flag admin surface.
 *
 *   GET  /api/admin/feature-flags          List all flags.
 *   GET  /api/admin/feature-flags/:key     Read a single flag.
 *   PUT  /api/admin/feature-flags/:key     Toggle a flag. Requires ADMIN role.
 *
 * Flags are dotted-namespace strings (e.g. 'code_foundry.enabled') stored
 * in the feature_flags table. The Foundry's CLI, REST, and web entry
 * points call GET to check the gate and return FEATURE_DISABLED when off.
 *
 * Toggles emit a FeatureFlagToggled audit event so a security review can
 * reconstruct who turned what on/off and when. ADMIN role is checked via
 * the existing isAdminUser helper used by team-variable / document
 * mutations — keeps the admin-bar consistent across the platform.
 */
import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { ForbiddenError, NotFoundError } from '../../lib/errors'
import { isAdminUser } from '../../lib/permissions/admin'
import { logEvent, publishOutbox } from '../../lib/audit'

export const featureFlagsRouter: Router = Router()

const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/
const toggleSchema = z.object({
  enabled: z.boolean(),
  description: z.string().max(500).optional(),
})

featureFlagsRouter.get('/', async (_req, res, next) => {
  try {
    const flags = await prisma.featureFlag.findMany({ orderBy: { key: 'asc' } })
    res.json({ items: flags })
  } catch (err) {
    next(err)
  }
})

featureFlagsRouter.get('/:key', async (req, res, next) => {
  try {
    if (!KEY_PATTERN.test(req.params.key)) {
      throw new NotFoundError('FeatureFlag', req.params.key)
    }
    const flag = await prisma.featureFlag.findUnique({ where: { key: req.params.key } })
    if (!flag) throw new NotFoundError('FeatureFlag', req.params.key)
    res.json(flag)
  } catch (err) {
    next(err)
  }
})

featureFlagsRouter.put('/:key', validate(toggleSchema), async (req, res, next) => {
  try {
    if (!KEY_PATTERN.test(req.params.key)) {
      throw new NotFoundError('FeatureFlag', req.params.key)
    }
    const actorId = req.user!.userId
    if (!(await isAdminUser(actorId))) {
      throw new ForbiddenError('Only admins can change feature flags')
    }
    const body = req.body as z.infer<typeof toggleSchema>

    const previous = await prisma.featureFlag.findUnique({ where: { key: req.params.key } })
    // PUT creates the row on first toggle so admins can introduce a flag
    // through the UI without a schema change. Description is optional and
    // defaults to whatever was already there (or null).
    const flag = await prisma.featureFlag.upsert({
      where:  { key: req.params.key },
      update: {
        enabled: body.enabled,
        description: body.description ?? previous?.description ?? undefined,
        updatedById: actorId,
      },
      create: {
        key: req.params.key,
        enabled: body.enabled,
        description: body.description,
        updatedById: actorId,
      },
    })

    // Only log + publish when state actually flipped (or row was created)
    // so a UI that fires a redundant PUT doesn't spam the audit ledger.
    const flipped = !previous || previous.enabled !== flag.enabled
    if (flipped) {
      await logEvent('FeatureFlagToggled', 'FeatureFlag', flag.key, actorId, {
        key: flag.key,
        previousEnabled: previous?.enabled ?? null,
        nextEnabled: flag.enabled,
      } as unknown as Prisma.InputJsonValue as unknown as Record<string, unknown>)
      await publishOutbox('FeatureFlag', flag.key, 'FeatureFlagToggled', {
        key: flag.key,
        previousEnabled: previous?.enabled ?? null,
        nextEnabled: flag.enabled,
        actorId,
      })
    }

    res.json(flag)
  } catch (err) {
    next(err)
  }
})
