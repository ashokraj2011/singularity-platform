import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { parsePagination, toPageResponse } from '../../lib/pagination'
import { NotFoundError, ForbiddenError } from '../../lib/errors'
import { logEvent } from '../../lib/audit'
import { isAdminUser } from '../../lib/permissions/admin'

// ── Admin role detection ─────────────────────────────────────────────────────

const ADMIN_ROLE_NAMES = ['ADMIN', 'admin', 'Admin', 'SYSTEM_ADMIN', 'SystemAdmin', 'WORKFLOW_ADMIN', 'WorkflowAdmin']

async function isUserAdmin(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { roles: { include: { role: { select: { name: true } } } } },
  })
  if (!user) return false
  return user.roles.some(ur => ADMIN_ROLE_NAMES.includes(ur.role.name))
}

async function assertCanManageTeamVariables(userId: string, teamId: string): Promise<void> {
  // Admins always allowed.
  if (await isUserAdmin(userId)) return
  // Otherwise the user must be a member of the team.
  const member = await prisma.teamMember.findFirst({
    where: { teamId, userId },
    select: { id: true },
  })
  if (!member) {
    throw new ForbiddenError('Only team members or admins can manage team variables')
  }
}

export const teamsRouter: Router = Router()

const createTeamSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  departmentId: z.string().uuid().optional(),
})

teamsRouter.post('/', validate(createTeamSchema), async (req, res, next) => {
  try {
    const team = await prisma.team.create({ data: req.body, include: { department: true } })
    res.status(201).json(team)
  } catch (err) {
    next(err)
  }
})

teamsRouter.get('/', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const [teams, total] = await Promise.all([
      prisma.team.findMany({
        skip: pg.skip, take: pg.take,
        include: { department: true, _count: { select: { members: true } } },
        orderBy: { name: 'asc' },
      }),
      prisma.team.count(),
    ])
    res.json(toPageResponse(teams, total, pg))
  } catch (err) {
    next(err)
  }
})

teamsRouter.get('/:id', async (req, res, next) => {
  try {
    const team = await prisma.team.findUnique({
      where: { id: req.params.id },
      include: { department: true, members: true, _count: { select: { members: true } } },
    })
    if (!team) throw new NotFoundError('Team', req.params.id)
    res.json(team)
  } catch (err) {
    next(err)
  }
})

teamsRouter.post('/:id/members', async (req, res, next) => {
  try {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body)
    await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: req.params.id, userId } },
      create: { teamId: req.params.id, userId },
      update: {},
    })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

teamsRouter.delete('/:id/members/:userId', async (req, res, next) => {
  try {
    await prisma.teamMember.delete({
      where: { teamId_userId: { teamId: req.params.id, userId: req.params.userId } },
    })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

// ─── Team variables ──────────────────────────────────────────────────────────
//
// Variables are read-only at runtime (referenced as `globals.X`) and edited
// at design-time by team members or admins.  Each row stores a typed value;
// the runtime injects the whole set into `instance.context._globals` when an
// instance starts.

const VAR_TYPES        = ['STRING', 'NUMBER', 'BOOLEAN', 'JSON'] as const
const VAR_SCOPES       = ['GLOBAL', 'INSTANCE'] as const                // legacy mutability axis
const VAR_VISIBILITIES = ['ORG_GLOBAL', 'CAPABILITY', 'WORKFLOW'] as const
const VAR_EDITABLE_BY  = ['USER', 'SYSTEM'] as const

const variableCreateSchema = z.object({
  key:               z.string().min(1).max(80).regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Key must be a valid identifier'),
  label:             z.string().optional(),
  type:              z.enum(VAR_TYPES).default('STRING'),
  scope:             z.enum(VAR_SCOPES).default('GLOBAL'),
  visibility:        z.enum(VAR_VISIBILITIES).default('ORG_GLOBAL'),
  visibilityScopeId: z.string().optional().nullable(),
  editableBy:        z.enum(VAR_EDITABLE_BY).default('USER'),
  value:             z.unknown(),
  description:       z.string().optional(),
})

const variablePatchSchema = z.object({
  label:             z.string().optional(),
  type:              z.enum(VAR_TYPES).optional(),
  scope:             z.enum(VAR_SCOPES).optional(),
  visibility:        z.enum(VAR_VISIBILITIES).optional(),
  visibilityScopeId: z.string().optional().nullable(),
  editableBy:        z.enum(VAR_EDITABLE_BY).optional(),
  value:             z.unknown().optional(),
  description:       z.string().optional(),
})

teamsRouter.get('/:id/variables', async (req, res, next) => {
  try {
    const teamId = req.params.id as string
    const vars = await prisma.teamVariable.findMany({
      where: { teamId },
      orderBy: { key: 'asc' },
    })
    res.json(vars)
  } catch (err) { next(err) }
})

teamsRouter.post('/:id/variables', validate(variableCreateSchema), async (req, res, next) => {
  try {
    const teamId = req.params.id as string
    await assertCanManageTeamVariables(req.user!.userId, teamId)
    const body = req.body as z.infer<typeof variableCreateSchema>

    // SYSTEM-tagged variables can only be created by ADMIN users.
    if (body.editableBy === 'SYSTEM' && !(await isAdminUser(req.user!.userId))) {
      return res.status(403).json({ error: 'Only admins can create SYSTEM variables' })
    }

    const created = await prisma.teamVariable.create({
      data: {
        teamId,
        key:               body.key,
        label:             body.label,
        type:              body.type,
        scope:             body.scope,
        visibility:        body.visibility,
        visibilityScopeId: body.visibilityScopeId ?? null,
        editableBy:        body.editableBy,
        value:             body.value as Prisma.InputJsonValue,
        description:       body.description,
        createdById:       req.user!.userId,
      },
    })
    await logEvent('TeamVariableCreated', 'TeamVariable', created.id, req.user!.userId, {
      teamId, key: body.key, scope: body.scope,
      visibility: body.visibility, editableBy: body.editableBy,
    })
    res.status(201).json(created)
  } catch (err) { next(err) }
})

teamsRouter.patch('/:id/variables/:varId', validate(variablePatchSchema), async (req, res, next) => {
  try {
    const teamId = req.params.id as string
    const varId  = req.params.varId as string
    await assertCanManageTeamVariables(req.user!.userId, teamId)
    const body = req.body as z.infer<typeof variablePatchSchema>

    const existing = await prisma.teamVariable.findUnique({ where: { id: varId } })
    if (!existing || existing.teamId !== teamId) throw new NotFoundError('TeamVariable', varId)

    // SYSTEM-tagged variables can only be edited by ADMIN users.  Non-admins
    // also can't toggle a USER variable into SYSTEM mode.
    const isAdmin = await isAdminUser(req.user!.userId)
    if (existing.editableBy === 'SYSTEM' && !isAdmin) {
      return res.status(403).json({ error: 'Only admins can edit SYSTEM variables' })
    }
    if (body.editableBy === 'SYSTEM' && !isAdmin) {
      return res.status(403).json({ error: 'Only admins can promote variables to SYSTEM' })
    }

    const updated = await prisma.teamVariable.update({
      where: { id: varId },
      data: {
        ...(body.label             !== undefined ? { label:             body.label }                            : {}),
        ...(body.type              !== undefined ? { type:              body.type }                             : {}),
        ...(body.scope             !== undefined ? { scope:             body.scope }                            : {}),
        ...(body.visibility        !== undefined ? { visibility:        body.visibility }                       : {}),
        ...(body.visibilityScopeId !== undefined ? { visibilityScopeId: body.visibilityScopeId ?? null }        : {}),
        ...(body.editableBy        !== undefined ? { editableBy:        body.editableBy }                       : {}),
        ...(body.value             !== undefined ? { value:             body.value as Prisma.InputJsonValue }   : {}),
        ...(body.description       !== undefined ? { description:       body.description }                      : {}),
      },
    })
    await logEvent('TeamVariableUpdated', 'TeamVariable', varId, req.user!.userId, { teamId })
    res.json(updated)
  } catch (err) { next(err) }
})

teamsRouter.delete('/:id/variables/:varId', async (req, res, next) => {
  try {
    const teamId = req.params.id as string
    const varId  = req.params.varId as string
    await assertCanManageTeamVariables(req.user!.userId, teamId)

    const existing = await prisma.teamVariable.findUnique({ where: { id: varId } })
    if (!existing || existing.teamId !== teamId) throw new NotFoundError('TeamVariable', varId)
    if (existing.editableBy === 'SYSTEM' && !(await isAdminUser(req.user!.userId))) {
      return res.status(403).json({ error: 'Only admins can delete SYSTEM variables' })
    }

    await prisma.teamVariable.delete({ where: { id: varId } })
    await logEvent('TeamVariableDeleted', 'TeamVariable', varId, req.user!.userId, { teamId })
    res.status(204).send()
  } catch (err) { next(err) }
})

teamsRouter.get('/:id/queue', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const [items, total] = await Promise.all([
      prisma.teamQueueItem.findMany({
        where: { teamId: req.params.id, claimedById: null },
        include: { task: true },
        skip: pg.skip, take: pg.take,
        orderBy: { enqueuedAt: 'asc' },
      }),
      prisma.teamQueueItem.count({ where: { teamId: req.params.id, claimedById: null } }),
    ])
    res.json(toPageResponse(items, total, pg))
  } catch (err) {
    next(err)
  }
})
