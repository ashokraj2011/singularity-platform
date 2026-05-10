import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { NotFoundError } from '../../lib/errors'
import { logEvent } from '../../lib/audit'

export const artifactTemplatesRouter: Router = Router()

// ─── Schemas ──────────────────────────────────────────────────────────────────

const sectionSchema = z.object({
  id:             z.string(),
  title:          z.string().min(1),
  type:           z.enum(['RICH_TEXT', 'STRUCTURED_FIELDS', 'TABLE', 'CODE_BLOCK', 'SIGNATURE', 'CHECKLIST', 'FILE_ATTACHMENT']),
  required:       z.boolean().default(true),
  filledBy:       z.enum(['AGENT', 'HUMAN', 'SYSTEM', 'ANY']).default('ANY'),
  description:    z.string().optional(),
  placeholder:    z.string().optional(),
  defaultContent: z.string().optional(),
  // STRUCTURED_FIELDS
  fields: z.array(z.object({
    key: z.string(), label: z.string(), type: z.string(), required: z.boolean(),
    options: z.array(z.string()).optional(),
  })).optional(),
  // TABLE
  columns: z.array(z.string()).optional(),
  // CODE_BLOCK
  language: z.string().optional(),
  // CHECKLIST
  items: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
})

const partySchema = z.object({
  id:          z.string(),
  name:        z.string().min(1),
  role:        z.enum(['AGENT', 'HUMAN', 'SYSTEM']),
  required:    z.boolean().default(true),
  description: z.string().optional(),
})

const createSchema = z.object({
  name:        z.string().min(1),
  description: z.string().optional(),
  type:        z.enum(['CONTRACT', 'DELIVERABLE', 'SPECIFICATION', 'APPROVAL_BRIEF', 'HANDOFF', 'REPORT']).default('DELIVERABLE'),
  teamName:    z.string().optional(),
  sections:    z.array(sectionSchema).default([]),
  parties:     z.array(partySchema).default([]),
  metadata:    z.record(z.unknown()).optional(),
})

const updateSchema = z.object({
  name:        z.string().min(1).optional(),
  description: z.string().optional(),
  type:        z.enum(['CONTRACT', 'DELIVERABLE', 'SPECIFICATION', 'APPROVAL_BRIEF', 'HANDOFF', 'REPORT']).optional(),
  teamName:    z.string().optional(),
  sections:    z.array(sectionSchema).optional(),
  parties:     z.array(partySchema).optional(),
  metadata:    z.record(z.unknown()).optional(),
})

// ─── List ─────────────────────────────────────────────────────────────────────

artifactTemplatesRouter.get('/', async (req, res, next) => {
  try {
    const { type, status, search } = req.query as Record<string, string>
    const templates = await prisma.artifactTemplate.findMany({
      where: {
        ...(type   ? { type }   : {}),
        ...(status ? { status } : { status: { not: 'ARCHIVED' } }),
        ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    })
    res.json(templates)
  } catch (err) { next(err) }
})

// ─── Create ───────────────────────────────────────────────────────────────────

artifactTemplatesRouter.post('/', validate(createSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof createSchema>
    const template = await prisma.artifactTemplate.create({
      data: {
        name:        body.name,
        description: body.description,
        type:        body.type ?? 'DELIVERABLE',
        teamName:    body.teamName,
        sections:    (body.sections ?? []) as any,
        parties:     (body.parties  ?? []) as any,
        metadata:    body.metadata  as any ?? undefined,
        createdById: req.user!.userId,
      },
    })
    await logEvent('ArtifactTemplateCreated', 'ArtifactTemplate', template.id, req.user!.userId)
    res.status(201).json(template)
  } catch (err) { next(err) }
})

// ─── Get one ──────────────────────────────────────────────────────────────────

artifactTemplatesRouter.get('/:id', async (req, res, next) => {
  try {
    const t = await prisma.artifactTemplate.findUnique({ where: { id: req.params.id } })
    if (!t) throw new NotFoundError('ArtifactTemplate', req.params.id)
    res.json(t)
  } catch (err) { next(err) }
})

// ─── Update ───────────────────────────────────────────────────────────────────

artifactTemplatesRouter.patch('/:id', validate(updateSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof updateSchema>
    const id = req.params.id as string
    const existing = await prisma.artifactTemplate.findUnique({ where: { id } })
    if (!existing) throw new NotFoundError('ArtifactTemplate', id)

    const t = await prisma.artifactTemplate.update({
      where: { id },
      data: {
        ...(body.name        !== undefined ? { name: body.name }               : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.type        !== undefined ? { type: body.type }               : {}),
        ...(body.teamName    !== undefined ? { teamName: body.teamName }       : {}),
        ...(body.sections    !== undefined ? { sections: body.sections as any }: {}),
        ...(body.parties     !== undefined ? { parties:  body.parties  as any }: {}),
        ...(body.metadata    !== undefined ? { metadata: body.metadata  as any}: {}),
      },
    })
    await logEvent('ArtifactTemplateUpdated', 'ArtifactTemplate', t.id, req.user!.userId)
    res.json(t)
  } catch (err) { next(err) }
})

// ─── Publish ──────────────────────────────────────────────────────────────────

artifactTemplatesRouter.post('/:id/publish', async (req, res, next) => {
  try {
    const t = await prisma.artifactTemplate.update({
      where: { id: req.params.id },
      data:  { status: 'PUBLISHED' },
    })
    await logEvent('ArtifactTemplatePublished', 'ArtifactTemplate', t.id, req.user!.userId)
    res.json(t)
  } catch (err) { next(err) }
})

// ─── Archive ──────────────────────────────────────────────────────────────────

artifactTemplatesRouter.post('/:id/archive', async (req, res, next) => {
  try {
    const t = await prisma.artifactTemplate.update({
      where: { id: req.params.id },
      data:  { status: 'ARCHIVED' },
    })
    await logEvent('ArtifactTemplateArchived', 'ArtifactTemplate', t.id, req.user!.userId)
    res.json(t)
  } catch (err) { next(err) }
})

// ─── Duplicate ────────────────────────────────────────────────────────────────

artifactTemplatesRouter.post('/:id/duplicate', async (req, res, next) => {
  try {
    const src = await prisma.artifactTemplate.findUnique({ where: { id: req.params.id } })
    if (!src) throw new NotFoundError('ArtifactTemplate', req.params.id)
    const newName = (req.body?.name as string | undefined)?.trim() || `${src.name} (copy)`
    const copy = await prisma.artifactTemplate.create({
      data: {
        name:        newName,
        description: src.description ?? undefined,
        type:        src.type,
        teamName:    src.teamName ?? undefined,
        sections:    src.sections as any,
        parties:     src.parties  as any,
        metadata:    src.metadata as any ?? undefined,
        createdById: req.user!.userId,
        status:      'DRAFT',
        version:     1,
      },
    })
    await logEvent('ArtifactTemplateDuplicated', 'ArtifactTemplate', copy.id, req.user!.userId)
    res.status(201).json(copy)
  } catch (err) { next(err) }
})

// ─── Delete ───────────────────────────────────────────────────────────────────

artifactTemplatesRouter.delete('/:id', async (req, res, next) => {
  try {
    await prisma.artifactTemplate.delete({ where: { id: req.params.id } })
    await logEvent('ArtifactTemplateDeleted', 'ArtifactTemplate', req.params.id, req.user!.userId)
    res.status(204).send()
  } catch (err) { next(err) }
})
