import { Router, type Response } from 'express'
import { z } from 'zod'
import { validate } from '../../middleware/validate'
import { prisma } from '../../lib/prisma'
import { ValidationError } from '../../lib/errors'
import { normalizeMetadataKey } from '../metadata/metadata.service'
import {
  composeBusinessRisks,
  createBusinessChangeRequest,
  createBusinessMilestone,
  createBusinessObjective,
  exportBusinessJiraCsv,
  generateBusinessReadout,
  getBusinessProjectRollup,
  getObjectiveCoverage,
  getSponsorGateDecision,
  listBusinessMilestones,
  listBusinessObjectives,
  listBusinessReadouts,
  listExternalTaxonomyMappings,
  requestBusinessChangeSponsorReview,
  requestBusinessReadoutSponsorApproval,
  updateBusinessObjective,
  updateBusinessRisk,
  upsertExternalTaxonomyMapping,
} from './business-alignment.service'
import {
  assertBusinessDocumentFormat,
  exportDecisionLog,
  exportSignedReadoutArchive,
  exportSpendByObjective,
  exportTraceabilityMatrix,
  type BusinessExportArtifact,
  withBusinessExportTenant,
} from './business-alignment.exports'

export const businessAlignmentRouter: Router = Router()

const objectiveSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(5000),
  ownerId: z.string().trim().min(1).max(200),
  targetMetric: z.object({
    name: z.string().trim().min(1).max(200),
    baseline: z.union([z.string(), z.number()]).optional(),
    target: z.union([z.string(), z.number()]),
    unit: z.string().trim().max(80).optional(),
    byDate: z.string().datetime().optional(),
    // Optional reference into the BUSINESS_METRIC catalog. A SOFT key, not a FK:
    // targetMetric is JSON and the catalog is versioned + scoped, so a relational
    // constraint does not fit -- and more importantly a soft key lets every
    // existing free-text objective keep working untouched. Absent => today's
    // free-text behaviour exactly.
    metricKey: z.string().trim().min(1).max(120).optional(),
  }),
  valueScore: z.number().int().min(1).max(5),
  valueRationale: z.string().trim().min(1).max(2000).optional().nullable(),
  budgetLineRef: z.string().trim().min(1).max(200).optional().nullable(),
  period: z.object({ start: z.string().datetime(), end: z.string().datetime() }).refine(value => new Date(value.end) >= new Date(value.start), 'Objective period end must not precede start'),
  status: z.enum(['ACTIVE', 'ACHIEVED_DECLARED', 'DROPPED', 'DEFERRED']).optional(),
  projectIds: z.array(z.string().uuid()).min(1),
  studioProjectId: z.string().uuid().optional().nullable(),
})


/**
 * Resolve targetMetric.metricKey against the BUSINESS_METRIC catalog.
 *
 * Two jobs: reject a key that names nothing usable, and fill `unit` / `direction`
 * from the definition when the caller omitted them, so a catalogued metric is
 * described consistently no matter who created the objective.
 *
 * Only ACTIVE definitions resolve. A DEPRECATED or ARCHIVED metric is exactly the
 * one nobody should be attaching new objectives to, and silently accepting it
 * would defeat having a lifecycle at all.
 *
 * Caller-supplied values WIN over the catalog. The catalog is a default, not an
 * override -- an objective measuring the same metric in a different unit is a
 * real case, and rewriting the caller's unit under them would be worse than
 * letting it differ.
 */
async function resolveMetricKey(targetMetric: Record<string, unknown> | undefined): Promise<void> {
  const key = typeof targetMetric?.metricKey === 'string' ? targetMetric.metricKey.trim() : ''
  if (!key) return
  const definition = await prisma.metadataDefinition.findFirst({
    where: { kind: 'BUSINESS_METRIC', key: normalizeMetadataKey(key), status: 'ACTIVE' },
    orderBy: { version: 'desc' },
  })
  if (!definition) {
    throw new ValidationError(
      `Metric "${key}" is not an active entry in the business metric catalog. `
      + 'Pick a catalogued metric, add it to the catalog first, or leave metricKey empty and type the metric name.',
    )
  }
  const ui = (definition.ui ?? {}) as Record<string, unknown>
  const schemaJson = (definition.schema ?? {}) as Record<string, unknown>
  if (targetMetric && targetMetric.unit == null) {
    const unit = ui.unit ?? schemaJson.unit
    if (typeof unit === 'string' && unit.trim()) targetMetric.unit = unit.trim()
  }
  if (targetMetric && targetMetric.direction == null) {
    const direction = ui.direction ?? schemaJson.direction
    if (direction === 'HIGHER_IS_BETTER' || direction === 'LOWER_IS_BETTER') targetMetric.direction = direction
  }
}

businessAlignmentRouter.get('/business-alignment/objectives', async (req, res, next) => {
  try { res.json({ items: await listBusinessObjectives(typeof req.query.projectId === 'string' ? req.query.projectId : undefined) }) } catch (error) { next(error) }
})

businessAlignmentRouter.post('/business-alignment/objectives', validate(objectiveSchema), async (req, res, next) => {
  try { await resolveMetricKey(req.body?.targetMetric); res.status(201).json(await createBusinessObjective(req.body, req.user!.userId)) } catch (error) { next(error) }
})

businessAlignmentRouter.patch('/business-alignment/objectives/:objectiveId', validate(objectiveSchema.partial()), async (req, res, next) => {
  try { await resolveMetricKey(req.body?.targetMetric); res.json(await updateBusinessObjective(String(req.params.objectiveId), req.body, req.user!.userId)) } catch (error) { next(error) }
})

businessAlignmentRouter.get('/business-alignment/projects/:projectId/coverage', async (req, res, next) => {
  try {
    const mode = z.enum(['hub', 'lock', 'portfolio']).catch('hub').parse(req.query.mode)
    res.json(await getObjectiveCoverage(String(req.params.projectId), mode))
  } catch (error) { next(error) }
})

const milestoneSchema = z.object({
  name: z.string().trim().min(1).max(300),
  valueStatement: z.string().trim().min(1).max(3000),
  targetDate: z.string().datetime(),
  completionDefinition: z.object({ rule: z.literal('ALL').default('ALL'), planRowIds: z.array(z.string().uuid()).default([]), workItemIds: z.array(z.string().uuid()).default([]) }).refine(value => value.planRowIds.length + value.workItemIds.length > 0, 'A milestone needs at least one plan row or WorkItem'),
})

businessAlignmentRouter.get('/business-alignment/projects/:projectId/milestones', async (req, res, next) => {
  try { res.json({ items: await listBusinessMilestones(String(req.params.projectId)) }) } catch (error) { next(error) }
})

businessAlignmentRouter.post('/business-alignment/projects/:projectId/milestones', validate(milestoneSchema), async (req, res, next) => {
  try { res.status(201).json(await createBusinessMilestone(String(req.params.projectId), { ...req.body, targetDate: new Date(req.body.targetDate) }, req.user!.userId)) } catch (error) { next(error) }
})

businessAlignmentRouter.get('/business-alignment/projects/:projectId/risks', async (req, res, next) => {
  try { res.json({ items: await composeBusinessRisks(String(req.params.projectId)) }) } catch (error) { next(error) }
})

businessAlignmentRouter.patch('/business-alignment/risks/:riskId', validate(z.object({ ownerId: z.string().trim().min(1).max(200).optional().nullable(), mitigation: z.string().trim().min(1).max(5000).optional().nullable(), status: z.enum(['OPEN', 'MITIGATING', 'ACCEPTED', 'CLOSED']).optional() })), async (req, res, next) => {
  try { res.json(await updateBusinessRisk(String(req.params.riskId), req.body, req.user!.userId)) } catch (error) { next(error) }
})

const readoutSchema = z.object({
  kind: z.enum(['SPONSOR', 'WEEKLY']).default('SPONSOR'),
  objectiveId: z.string().uuid().optional(),
  specificationVersionId: z.string().uuid().optional(),
  periodStart: z.string().datetime().optional(),
  periodEnd: z.string().datetime().optional(),
})

businessAlignmentRouter.get('/business-alignment/projects/:projectId/readouts', async (req, res, next) => {
  try { res.json({ items: await listBusinessReadouts(String(req.params.projectId)) }) } catch (error) { next(error) }
})

businessAlignmentRouter.post('/business-alignment/projects/:projectId/readouts', validate(readoutSchema), async (req, res, next) => {
  try { res.status(201).json(await generateBusinessReadout(String(req.params.projectId), { ...req.body, periodStart: req.body.periodStart ? new Date(req.body.periodStart) : undefined, periodEnd: req.body.periodEnd ? new Date(req.body.periodEnd) : undefined }, req.user!.userId)) } catch (error) { next(error) }
})

businessAlignmentRouter.post('/business-alignment/readouts/:readoutId/sponsor-review', async (req, res, next) => {
  try { res.status(201).json(await requestBusinessReadoutSponsorApproval(String(req.params.readoutId), req.user!.userId)) } catch (error) { next(error) }
})

businessAlignmentRouter.get('/business-alignment/projects/:projectId/sponsor-gate', async (req, res, next) => {
  try { res.json(await getSponsorGateDecision(String(req.params.projectId))) } catch (error) { next(error) }
})

businessAlignmentRouter.get('/business-alignment/projects/:projectId/rollup', async (req, res, next) => {
  try { res.json(await getBusinessProjectRollup(String(req.params.projectId))) } catch (error) { next(error) }
})

const changeRequestSchema = z.object({
  specificationVersionId: z.string().uuid(),
  title: z.string().trim().min(1).max(300),
  reason: z.string().trim().min(20).max(5000),
  requirementDeltas: z.object({ added: z.array(z.string().min(1)).default([]), changed: z.array(z.string().min(1)).default([]), removed: z.array(z.string().min(1)).default([]) }),
})

businessAlignmentRouter.post('/business-alignment/projects/:projectId/change-requests', validate(changeRequestSchema), async (req, res, next) => {
  try { res.status(201).json(await createBusinessChangeRequest(String(req.params.projectId), req.body, req.user!.userId)) } catch (error) { next(error) }
})

businessAlignmentRouter.post('/business-alignment/change-requests/:changeRequestId/sponsor-review', async (req, res, next) => {
  try { res.status(201).json(await requestBusinessChangeSponsorReview(String(req.params.changeRequestId), req.user!.userId)) } catch (error) { next(error) }
})

businessAlignmentRouter.put('/business-alignment/projects/:projectId/taxonomy-mappings', validate(z.object({ entityType: z.string().trim().min(1).max(100), entityId: z.string().trim().min(1).max(200), externalSystem: z.string().trim().min(1).max(100), externalType: z.string().trim().min(1).max(100), externalLabel: z.string().trim().max(300).optional().nullable(), costCenterRef: z.string().trim().max(200).optional().nullable(), metadata: z.record(z.unknown()).optional() })), async (req, res, next) => {
  try { res.json(await upsertExternalTaxonomyMapping(String(req.params.projectId), req.body, req.user!.userId)) } catch (error) { next(error) }
})

businessAlignmentRouter.get('/business-alignment/projects/:projectId/taxonomy-mappings', async (req, res, next) => {
  try { res.json({ items: await listExternalTaxonomyMappings(String(req.params.projectId)) }) } catch (error) { next(error) }
})

businessAlignmentRouter.get('/business-alignment/projects/:projectId/exports/jira.csv', async (req, res, next) => {
  try {
    const csv = await exportBusinessJiraCsv(String(req.params.projectId))
    res.setHeader('content-type', 'text/csv; charset=utf-8')
    res.setHeader('content-disposition', `attachment; filename="${String(req.params.projectId)}-jira-import.csv"`)
    res.send(csv)
  } catch (error) { next(error) }
})

function sendArtifact(res: Response, artifact: BusinessExportArtifact) {
  res.setHeader('content-type', artifact.contentType)
  res.setHeader('content-disposition', `attachment; filename="${artifact.filename}"`)
  res.setHeader('content-length', String(artifact.body.length))
  res.send(artifact.body)
}

businessAlignmentRouter.get('/business-alignment/projects/:projectId/exports/traceability.xlsx', async (req, res, next) => {
  try {
    sendArtifact(res, await withBusinessExportTenant(() => exportTraceabilityMatrix(String(req.params.projectId))))
  } catch (error) { next(error) }
})

businessAlignmentRouter.get('/business-alignment/projects/:projectId/exports/spend.xlsx', async (req, res, next) => {
  try {
    sendArtifact(res, await withBusinessExportTenant(() => exportSpendByObjective(String(req.params.projectId))))
  } catch (error) { next(error) }
})

businessAlignmentRouter.get('/business-alignment/projects/:projectId/exports/signed-readouts.:format', async (req, res, next) => {
  try {
    const format = assertBusinessDocumentFormat(req.params.format)
    sendArtifact(res, await withBusinessExportTenant(() => exportSignedReadoutArchive(String(req.params.projectId), format)))
  } catch (error) { next(error) }
})

businessAlignmentRouter.get('/business-alignment/projects/:projectId/exports/decision-log.:format', async (req, res, next) => {
  try {
    const format = assertBusinessDocumentFormat(req.params.format)
    sendArtifact(res, await withBusinessExportTenant(() => exportDecisionLog(String(req.params.projectId), format)))
  } catch (error) { next(error) }
})
