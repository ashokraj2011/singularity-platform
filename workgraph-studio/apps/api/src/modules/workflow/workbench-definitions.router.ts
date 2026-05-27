/**
 * M84.s2 — REST surface for first-class workbench definitions.
 *
 * Mounted at /api/workflow-nodes/:nodeId/workbench in app.ts.
 *
 * Endpoints (all gated by assertInstancePermission on the node's
 * parent instance — view for GET, edit for POST/PATCH/DELETE):
 *
 *   GET    /                              — full definition tree
 *   PATCH  /                              — top-level fields
 *   POST   /stages                        — append stage
 *   PATCH  /stages/:stageId               — edit stage
 *   DELETE /stages/:stageId               — remove stage (cascades)
 *   POST   /stages/reorder                — bulk reorder by id list
 *   POST   /stages/:stageId/artifacts     — add artifact
 *   PATCH  /artifacts/:artifactId         — edit artifact
 *   DELETE /artifacts/:artifactId         — remove artifact
 *   POST   /edges                         — create FORWARD or SEND_BACK
 *   DELETE /edges/:edgeId                 — remove edge
 *   POST   /consumes                      — pin a handoff (inferred=false)
 *   DELETE /consumes/:consumesId          — remove handoff binding
 *
 * All write paths return the updated full view so the UI can
 * re-render without a follow-up GET.
 */
import { Router, type Request } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { NotFoundError } from '../../lib/errors'
import * as service from './workbench-definitions.service'

export const workbenchDefinitionsRouter: Router = Router({ mergeParams: true })

// mergeParams pulls :nodeId from the parent mount (app.ts), but the
// TS handler type sees `req.params` as the local-only shape and
// doesn't know about merged params. Cast in one place so the routes
// stay readable.
function nodeIdOf(req: Request): string {
  return (req.params as Record<string, string>).nodeId
}

// ─── Zod schemas ───────────────────────────────────────────────────────────

const policyEnum = z.enum(['NONE', 'READ_ONLY', 'MUTATION', 'VERIFICATION'])
const contextEnum = z.enum(['NONE', 'STORY_ONLY', 'REPO_READ_ONLY', 'CODE_EDIT', 'VERIFY_ONLY', 'EVIDENCE_REVIEW'])
const formatEnum = z.enum(['MARKDOWN', 'TEXT', 'JSON', 'CODE'])
const edgeKindEnum = z.enum(['FORWARD', 'SEND_BACK'])

const patchDefinitionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  goal: z.string().max(8_000).nullable().optional(),
  sourceType: z.enum(['github', 'localdir']).nullable().optional(),
  sourceUri: z.string().max(2_000).nullable().optional(),
  sourceRef: z.string().max(200).nullable().optional(),
  capabilityId: z.string().uuid().nullable().optional(),
  architectAgentTemplateId: z.string().uuid().nullable().optional(),
  developerAgentTemplateId: z.string().uuid().nullable().optional(),
  qaAgentTemplateId: z.string().uuid().nullable().optional(),
  maxLoopsPerStage: z.number().int().min(1).max(20).optional(),
  maxTotalSendBacks: z.number().int().min(0).max(50).optional(),
  gateMode: z.enum(['manual', 'auto']).optional(),
  finalPackKey: z.string().max(200).nullable().optional(),
})

const createStageSchema = z.object({
  stageKey: z.string().min(1).max(80).regex(/^[A-Z][A-Z0-9_]*$/, 'stageKey must be UPPER_SNAKE_CASE'),
  label: z.string().min(1).max(200),
  agentRole: z.string().min(1).max(80),
  agentTemplateId: z.string().uuid().nullable().optional(),
  promptProfileKey: z.string().max(200).nullable().optional(),
  toolPolicy: policyEnum.optional(),
  contextPolicy: contextEnum.optional(),
  required: z.boolean().optional(),
  terminal: z.boolean().optional(),
  approvalRequired: z.boolean().optional(),
  repoAccess: z.boolean().optional(),
  positionX: z.number().nullable().optional(),
  positionY: z.number().nullable().optional(),
})

const patchStageSchema = createStageSchema.partial()

const reorderSchema = z.object({
  stageIds: z.array(z.string().uuid()).min(1),
})

const createArtifactSchema = z.object({
  kind: z.string().min(1).max(120).regex(/^[a-z0-9_]+$/, 'kind must be lower_snake_case'),
  title: z.string().min(1).max(200),
  description: z.string().max(2_000).nullable().optional(),
  format: formatEnum.optional(),
  required: z.boolean().optional(),
  editable: z.boolean().optional(),
})

const patchArtifactSchema = createArtifactSchema.partial()

const createEdgeSchema = z.object({
  fromStageId: z.string().uuid(),
  toStageId: z.string().uuid(),
  kind: edgeKindEnum,
  label: z.string().max(200).nullable().optional(),
})

const pinConsumesSchema = z.object({
  consumerStageId: z.string().uuid(),
  producerArtifactId: z.string().uuid(),
  required: z.boolean().optional(),
})

// ─── Routes ────────────────────────────────────────────────────────────────

workbenchDefinitionsRouter.get('/', async (req, res, next) => {
  try {
    const view = await service.getDefinition(nodeIdOf(req), req.user!.userId)
    if (!view) throw new NotFoundError('WorkbenchDefinition', nodeIdOf(req))
    res.json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.patch('/', validate(patchDefinitionSchema), async (req, res, next) => {
  try {
    const view = await service.patchDefinition(
      nodeIdOf(req),
      req.body as z.infer<typeof patchDefinitionSchema>,
      req.user!.userId,
    )
    res.json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.post('/stages', validate(createStageSchema), async (req, res, next) => {
  try {
    const view = await service.createStage(
      nodeIdOf(req),
      req.body as z.infer<typeof createStageSchema>,
      req.user!.userId,
    )
    res.status(201).json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.post('/stages/reorder', validate(reorderSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof reorderSchema>
    const view = await service.reorderStages(nodeIdOf(req), body.stageIds, req.user!.userId)
    res.json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.patch('/stages/:stageId', validate(patchStageSchema), async (req, res, next) => {
  try {
    const view = await service.patchStage(
      nodeIdOf(req),
      req.params.stageId!,
      req.body as z.infer<typeof patchStageSchema>,
      req.user!.userId,
    )
    res.json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.delete('/stages/:stageId', async (req, res, next) => {
  try {
    const view = await service.deleteStage(nodeIdOf(req), req.params.stageId!, req.user!.userId)
    res.json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.post(
  '/stages/:stageId/artifacts',
  validate(createArtifactSchema),
  async (req, res, next) => {
    try {
      const view = await service.createArtifact(
        nodeIdOf(req),
        req.params.stageId!,
        req.body as z.infer<typeof createArtifactSchema>,
        req.user!.userId,
      )
      res.status(201).json({ data: view })
    } catch (err) { next(err) }
  },
)

workbenchDefinitionsRouter.patch(
  '/artifacts/:artifactId',
  validate(patchArtifactSchema),
  async (req, res, next) => {
    try {
      const view = await service.patchArtifact(
        nodeIdOf(req),
        req.params.artifactId!,
        req.body as z.infer<typeof patchArtifactSchema>,
        req.user!.userId,
      )
      res.json({ data: view })
    } catch (err) { next(err) }
  },
)

workbenchDefinitionsRouter.delete('/artifacts/:artifactId', async (req, res, next) => {
  try {
    const view = await service.deleteArtifact(
      nodeIdOf(req),
      req.params.artifactId!,
      req.user!.userId,
    )
    res.json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.post('/edges', validate(createEdgeSchema), async (req, res, next) => {
  try {
    const view = await service.createEdge(
      nodeIdOf(req),
      req.body as z.infer<typeof createEdgeSchema>,
      req.user!.userId,
    )
    res.status(201).json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.delete('/edges/:edgeId', async (req, res, next) => {
  try {
    const view = await service.deleteEdge(nodeIdOf(req), req.params.edgeId!, req.user!.userId)
    res.json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.post('/consumes', validate(pinConsumesSchema), async (req, res, next) => {
  try {
    const view = await service.pinConsumes(
      nodeIdOf(req),
      req.body as z.infer<typeof pinConsumesSchema>,
      req.user!.userId,
    )
    res.status(201).json({ data: view })
  } catch (err) { next(err) }
})

workbenchDefinitionsRouter.delete('/consumes/:consumesId', async (req, res, next) => {
  try {
    const view = await service.deleteConsumes(
      nodeIdOf(req),
      req.params.consumesId!,
      req.user!.userId,
    )
    res.json({ data: view })
  } catch (err) { next(err) }
})
