import { Router } from 'express'
import { z } from 'zod'
import Ajv from 'ajv'
import { Prisma, ConsumableType, ConsumableVersion } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { parsePagination, toPageResponse } from '../../lib/pagination'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { logEvent, createReceipt, publishOutbox } from '../../lib/audit'
import { commitDeliverableConsumable, pushCodeForConsumable } from '../workflow/lib/commit-deliverable'
import { type Verdict, runVerification } from './verify.service'
import {
  assertConsumableTenant,
  assertWorkflowInstanceTenant,
  requireTenantFromRequest,
  tenantIsolationStrict,
} from '../../lib/tenant-isolation'
import { withTenantDbTransaction } from '../../lib/tenant-db-context'

export const consumablesRouter: Router = Router()

const ajv = new Ajv()

const createConsumableSchema = z.object({
  typeId: z.string().uuid(),
  instanceId: z.string().uuid().optional(),
  name: z.string().min(1),
})

const createVersionSchema = z.object({
  payload: z.record(z.unknown()).default({}),
})

consumablesRouter.post('/', validate(createConsumableSchema), async (req, res, next) => {
  try {
    if (tenantIsolationStrict() && !req.body.instanceId) {
      throw new ValidationError('TENANT_ISOLATION_MODE=strict requires instanceId when creating a consumable')
    }
    const consumable = await withTenantDbTransaction(prisma, async () => {
      if (req.body.instanceId) await assertWorkflowInstanceTenant(req, req.body.instanceId)
      const created = await prisma.consumable.create({
        data: { ...req.body, createdById: req.user!.userId },
        include: { type: true },
      })
      await logEvent('ConsumableCreated', 'Consumable', created.id, req.user!.userId)
      return created
    })
    res.status(201).json(consumable)
  } catch (err) {
    next(err)
  }
})

consumablesRouter.get('/', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const { typeId, status, instanceId, nodeId } = req.query
    const tenantId = requireTenantFromRequest(req, 'consumable listing')
    const where: Record<string, unknown> = {}
    if (typeId)     where.typeId     = typeId
    if (status)     where.status     = status
    if (instanceId) where.instanceId = instanceId
    if (nodeId)     where.nodeId     = nodeId
    if (tenantIsolationStrict()) where.instance = { tenantId }

    const [consumables, total] = await withTenantDbTransaction(prisma, () => Promise.all([
        prisma.consumable.findMany({
          where, skip: pg.skip, take: pg.take,
          include: { type: true },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.consumable.count({ where }),
      ]),
      tenantId,
    )
    res.json(toPageResponse(consumables, total, pg))
  } catch (err) {
    next(err)
  }
})

consumablesRouter.get('/:id', async (req, res, next) => {
  try {
    const consumable = await withTenantDbTransaction(prisma, async () => {
      await assertConsumableTenant(req, req.params.id)
      return prisma.consumable.findUnique({
        where: { id: req.params.id },
        include: { type: true, versions: { orderBy: { version: 'desc' } } },
      })
    })
    if (!consumable) throw new NotFoundError('Consumable', req.params.id)
    res.json(consumable)
  } catch (err) {
    next(err)
  }
})

consumablesRouter.post('/:id/versions', validate(createVersionSchema), async (req, res, next) => {
  try {
    const { payload } = req.body as z.infer<typeof createVersionSchema>
    const id = req.params.id as string
    const consumable = await withTenantDbTransaction(prisma, async () => {
      const found = await prisma.consumable.findUnique({
        where: { id },
        include: { type: true, versions: { orderBy: { version: 'desc' }, take: 1 } },
      }) as (Awaited<ReturnType<typeof prisma.consumable.findUnique>> & { type: ConsumableType; versions: ConsumableVersion[] }) | null
      if (!found) throw new NotFoundError('Consumable', id)
      await assertConsumableTenant(req, id)
      return found
    })

    // Schema validation against ConsumableType.schemaDef
    const schema = consumable.type.schemaDef as Record<string, unknown>
    if (schema && Object.keys(schema).length > 0) {
      const valid = ajv.validate(schema, payload)
      if (!valid) {
        throw new ValidationError(`Payload does not match consumable type schema: ${ajv.errorsText()}`)
      }
    }

    const nextVersion = (consumable.versions[0]?.version ?? 0) + 1
    const version = await withTenantDbTransaction(prisma, async () => {
      const created = await prisma.consumableVersion.create({
        data: {
          consumableId: id,
          version: nextVersion,
          payload: payload as unknown as Prisma.InputJsonValue,
          createdById: req.user!.userId,
        },
      })
      await prisma.consumable.update({
        where: { id },
        data: { currentVersion: nextVersion },
      })
      return created
    })
    res.status(201).json(version)
  } catch (err) {
    next(err)
  }
})

// PATCH /:id/content — human-edit an agent-generated document's content.
// Writes formData.content, snapshots a new version for audit, and RE-OPENS the
// governance gate: the prior verification verdict is dropped (the content changed,
// so it no longer applies) and an UNDER_REVIEW / APPROVED consumable falls back to
// DRAFT so the edit must be re-verified before it can be approved/published again.
// Blocked once terminal (PUBLISHED / CONSUMED / SUPERSEDED) — supersede to fork a
// new editable version instead.
const editContentSchema = z.object({ content: z.string(), note: z.string().max(500).optional() })
const EDIT_LOCKED_STATUSES = new Set(['PUBLISHED', 'CONSUMED', 'SUPERSEDED'])
consumablesRouter.patch('/:id/content', validate(editContentSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const { content, note } = req.body as z.infer<typeof editContentSchema>
    const existing = await withTenantDbTransaction(prisma, async () => {
      const found = await prisma.consumable.findUnique({
        where: { id },
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      })
      if (!found) throw new NotFoundError('Consumable', id)
      await assertConsumableTenant(req, id)
      return found
    })
    if (EDIT_LOCKED_STATUSES.has(String(existing.status))) {
      return res.status(409).json({
        error: `Cannot edit a ${existing.status} document — supersede it to create a new editable version.`,
      })
    }
    const prevForm = (existing.formData ?? {}) as Record<string, unknown>
    const { _verification: _staleVerdict, ...restForm } = prevForm
    void _staleVerdict
    const nextForm = { ...restForm, content }
    const reopen = existing.status === 'UNDER_REVIEW' || existing.status === 'APPROVED'
    const nextVersion = (existing.versions[0]?.version ?? 0) + 1
    const updated = await withTenantDbTransaction(prisma, async () => {
      await assertConsumableTenant(req, id)
      await prisma.consumableVersion.create({
        data: {
          consumableId: id,
          version: nextVersion,
          payload: { ...nextForm, _editedBy: req.user!.userId, _editNote: note ?? null } as unknown as Prisma.InputJsonValue,
          createdById: req.user!.userId,
        },
      })
      return prisma.consumable.update({
        where: { id },
        data: {
          formData: nextForm as Prisma.InputJsonValue,
          currentVersion: nextVersion,
          ...(reopen ? { status: 'DRAFT' as never } : {}),
        },
      })
    })
    const eventId = await logEvent('ConsumableEdited', 'Consumable', id, req.user!.userId)
    await createReceipt('ConsumableEdited', 'Consumable', id, {
      consumableId: id, version: nextVersion, reopened: reopen, editedBy: req.user!.userId, note: note ?? null,
    }, eventId)
    await publishOutbox('Consumable', id, 'ConsumableEdited', { consumableId: id, version: nextVersion, reopened: reopen })
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

async function transitionStatus(
  consumableId: string,
  newStatus: string,
  actorId: string,
  receiptType?: string,
): Promise<void> {
  const consumable = await prisma.consumable.update({
    where: { id: consumableId },
    data: { status: newStatus as never },
  })
  const eventId = await logEvent(`Consumable${newStatus}`, 'Consumable', consumableId, actorId)
  if (receiptType) {
    await createReceipt(receiptType, 'Consumable', consumableId, {
      consumableId, status: newStatus, actorId,
    }, eventId)
  }
  await publishOutbox('Consumable', consumableId, `Consumable${newStatus}`, { consumableId, status: newStatus })

  // S2 — when a deliverable is finalized, commit it to the run's wi/<code> branch
  // cloud-side (via the GitHub connector), so each phase's documents land on git as
  // they're approved. Fire-and-forget + non-fatal: a git failure logs but must never
  // break the approve/publish transition itself.
  if (newStatus === 'APPROVED' || newStatus === 'PUBLISHED') {
    void commitDeliverableConsumable(consumableId).catch((err) =>
      logEvent('DeliverableCommitFailed', 'Consumable', consumableId, actorId, {
        reason: err instanceof Error ? err.message : String(err),
      }),
    )
    // S3 — optionally also push the working-tree CODE via the laptop runtime
    // (opt-in globals.pushEachPhase). Fire-and-forget + non-fatal: rides the
    // dial-in bridge and no-ops (logged) while it's down.
    void pushCodeForConsumable(consumableId).catch((err) =>
      logEvent('PhaseCodePushFailed', 'Consumable', consumableId, actorId, {
        reason: err instanceof Error ? err.message : String(err),
      }),
    )
  }
  void consumable
}


consumablesRouter.post('/:id/submit-review', async (req, res, next) => {
  try {
    const c = await withTenantDbTransaction(prisma, async () => {
      await assertConsumableTenant(req, req.params.id)
      await transitionStatus(req.params.id, 'UNDER_REVIEW', req.user!.userId)
      return prisma.consumable.findUnique({ where: { id: req.params.id } })
    })
    res.json(c)
  } catch (err) {
    next(err)
  }
})

consumablesRouter.post('/:id/approve', async (req, res, next) => {
  try {
    const force = req.query.force === 'true' || (req.body as { force?: unknown } | null)?.force === true
    const existing = await withTenantDbTransaction(prisma, async () => {
      const found = await prisma.consumable.findUnique({ where: { id: req.params.id } })
      if (!found) return null
      await assertConsumableTenant(req, req.params.id)
      return found
    })
    if (!existing) return res.status(404).json({ error: 'consumable not found' })
    // Verify-before-approve gate. Auto-verify: if this document was never
    // verified, run the verifier agent now (and persist the verdict) so every
    // approval has a standards check behind it; then refuse to approve a
    // document that FAILED. ?force=true skips verification + the gate.
    if (!force) {
      let v = (existing.formData as Record<string, unknown> | null)?._verification as Verdict | undefined
      if (!v) {
        v = await runVerification(existing, req.user!.userId)
        const formData = { ...((existing.formData ?? {}) as Record<string, unknown>), _verification: v }
        await withTenantDbTransaction(prisma, async () => {
          await assertConsumableTenant(req, req.params.id)
          await prisma.consumable.update({ where: { id: existing.id }, data: { formData: formData as Prisma.InputJsonValue } })
        })
      }
      if (v.passed === false) {
        return res.status(409).json({
          error: 'verification_failed',
          message: 'This document failed verification against the standards. Resolve the findings and re-verify, or approve with force=true.',
          verification: v,
        })
      }
    }
    const c = await withTenantDbTransaction(prisma, async () => {
      await assertConsumableTenant(req, req.params.id)
      await transitionStatus(req.params.id, 'APPROVED', req.user!.userId, 'CONSUMABLE_APPROVAL')
      return prisma.consumable.findUnique({ where: { id: req.params.id } })
    })
    res.json(c)
  } catch (err) {
    next(err)
  }
})

consumablesRouter.post('/:id/reject', async (req, res, next) => {
  try {
    const c = await withTenantDbTransaction(prisma, async () => {
      await assertConsumableTenant(req, req.params.id)
      await transitionStatus(req.params.id, 'REJECTED', req.user!.userId)
      return prisma.consumable.findUnique({ where: { id: req.params.id } })
    })
    res.json(c)
  } catch (err) {
    next(err)
  }
})

// Verify a document — the verifier agent reads the run's standards/policies and
// LLM-judges the document against them (falling back to structural checks). The
// verdict is stored on the consumable (formData._verification) and gates approval.
// Used by the run-graph artifact catalog "Verify" button.
consumablesRouter.post('/:id/verify', async (req, res, next) => {
  try {
    const c = await withTenantDbTransaction(prisma, async () => {
      const found = await prisma.consumable.findUnique({ where: { id: req.params.id } })
      if (!found) return null
      await assertConsumableTenant(req, req.params.id)
      return found
    })
    if (!c) return res.status(404).json({ error: 'consumable not found' })
    const verdict = await runVerification(c, req.user!.userId)
    const formData = { ...((c.formData ?? {}) as Record<string, unknown>), _verification: verdict }
    await withTenantDbTransaction(prisma, async () => {
      await assertConsumableTenant(req, req.params.id)
      await prisma.consumable.update({ where: { id: c.id }, data: { formData: formData as Prisma.InputJsonValue } })
    })
    res.json({ id: c.id, ...verdict })
  } catch (err) {
    next(err)
  }
})

consumablesRouter.post('/:id/publish', async (req, res, next) => {
  try {
    const c = await withTenantDbTransaction(prisma, async () => {
      await assertConsumableTenant(req, req.params.id)
      await transitionStatus(req.params.id, 'PUBLISHED', req.user!.userId)
      return prisma.consumable.findUnique({ where: { id: req.params.id } })
    })
    res.json(c)
  } catch (err) {
    next(err)
  }
})

consumablesRouter.post('/:id/supersede', async (req, res, next) => {
  try {
    const c = await withTenantDbTransaction(prisma, async () => {
      await assertConsumableTenant(req, req.params.id)
      await transitionStatus(req.params.id, 'SUPERSEDED', req.user!.userId)
      return prisma.consumable.findUnique({ where: { id: req.params.id } })
    })
    res.json(c)
  } catch (err) {
    next(err)
  }
})

// ─── Consumable Form Submission ───────────────────────────────────────────────

const consumableFormSubmissionSchema = z.object({
  data: z.record(z.unknown()),
  attachmentIds: z.array(z.string().uuid()).optional(),
})

consumablesRouter.post('/:id/form-submission', validate(consumableFormSubmissionSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const { data, attachmentIds } = req.body as z.infer<typeof consumableFormSubmissionSchema>

    const { updated } = await withTenantDbTransaction(prisma, async () => {
      const found = await prisma.consumable.findUnique({ where: { id } })
      if (!found) throw new NotFoundError('Consumable', id)
      await assertConsumableTenant(req, id)

      const saved = await prisma.consumable.update({
        where: { id },
        data: { formData: data as unknown as Prisma.InputJsonValue },
      })

      if (attachmentIds && attachmentIds.length > 0) {
        await prisma.document.updateMany({
          where: { id: { in: attachmentIds } },
          data: { instanceId: found.instanceId },
        })
      }

      await logEvent('ConsumableFormSubmitted', 'Consumable', id, req.user!.userId, {
        instanceId: found.instanceId,
        attachmentCount: attachmentIds?.length ?? 0,
      })
      return { consumable: found, updated: saved }
    })

    res.json({ consumable: updated, formData: data, attachmentIds: attachmentIds ?? [] })
  } catch (err) {
    next(err)
  }
})
