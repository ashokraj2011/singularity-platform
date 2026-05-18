/**
 * M42.5 — Brownfield REST surface (Patent Chains B + C).
 *
 *   POST /api/codegen/repos/scan            (§25.15.1) Scan a repo,
 *                                           persist a CodegenRepoModel
 *                                           row, return it.
 *   GET  /api/codegen/repos/:id             Read a persisted repo model.
 *   POST /api/codegen/enhancements/plan     (§25.15.2) Validate the
 *                                           enhancement + run impact +
 *                                           planner, persist a
 *                                           CodegenChangePlan row.
 *   GET  /api/codegen/change-plans/:id      Read a change plan.
 *   POST /api/codegen/enhancements/apply    (§25.15.3) Run the
 *                                           dispatcher against a plan,
 *                                           write files, kick off LLM
 *                                           tasks for residual
 *                                           operations, create a
 *                                           brownfield CodegenRun, emit
 *                                           a receipt.
 *
 * Every route in this file is gated on `code_foundry.brownfield.enabled`
 * (mounted via router.ts) IN ADDITION to the master master flag.
 */
import { Router, type Request } from 'express'
import yaml from 'yaml'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { sha256 } from '../../spec/hash.js'
import { canonicalize } from '../../spec/canonicalize.js'
import { scanRepo, detectStack } from '../../brownfield/scanner/index.js'
import { enhancementSpecSchema } from '../../brownfield/enhancementSchema.js'
import { analyseImpact, ImpactAnalysisError } from '../../brownfield/impact.js'
import { buildChangePlan, hashPlan, PlannerError } from '../../brownfield/planner.js'
import { dispatchChangePlan } from '../../brownfield/dispatcher.js'
import { persistBrownfieldReceipt } from '../../audit/brownfieldReceipt.js'
import type { Framework, RepoModel } from '../../brownfield/types.js'

export const brownfieldRouter: Router = Router()

/* ─── POST /repos/scan ───────────────────────────────────────────────────── */

brownfieldRouter.post('/repos/scan', async (req, res, next) => {
  try {
    const body = parseJsonBody(req)
    const repoPath = stringField(body, 'repoPath')
    if (!repoPath) throw new ValidationError('Missing repoPath in request body.')
    const fwOpt = optionalEnum(body, 'framework', ['spring-boot', 'fastapi', 'express']) as Framework | undefined
    const framework = fwOpt ?? detectStack(repoPath)
    if (!framework) throw new ValidationError(`Could not auto-detect framework at '${repoPath}'. Pass 'framework'.`)

    const model = scanRepo(repoPath, { framework })
    const modelJson = JSON.parse(canonicalize(model)) as object
    const modelHash = sha256(canonicalize(model))
    const actorId = headerString(req, 'x-actor-id') ?? null

    const row = await prisma.codegenRepoModel.create({
      data: {
        repoPath,
        language: model.application.language,
        framework: model.application.framework,
        modelJson,
        modelHash,
        scannedById: actorId,
      },
    })
    res.json({
      repoModelId: row.id,
      modelHash,
      summary: summariseRepoModel(model),
      model,
    })
  } catch (err) { next(err) }
})

/* ─── GET /repos/:id ─────────────────────────────────────────────────────── */

brownfieldRouter.get('/repos/:id', async (req, res, next) => {
  try {
    const row = await prisma.codegenRepoModel.findUnique({ where: { id: req.params.id } })
    if (!row) throw new NotFoundError('CodegenRepoModel', req.params.id)
    res.json(row)
  } catch (err) { next(err) }
})

/* ─── POST /enhancements/plan ────────────────────────────────────────────── */

brownfieldRouter.post('/enhancements/plan', async (req, res, next) => {
  try {
    const body = parseYamlOrJsonBody(req)
    const repoModelId = pickString(body, 'repoModelId')
    if (!repoModelId) throw new ValidationError('Missing repoModelId.')
    const enhancementRaw = pickObject(body, 'enhancement')
    if (!enhancementRaw) throw new ValidationError('Missing enhancement.')

    const parse = enhancementSpecSchema.safeParse(enhancementRaw)
    if (!parse.success) {
      return res.status(400).json({
        code: 'ENHANCEMENT_INVALID',
        errors: parse.error.issues.map(i => ({ path: i.path.join('.'), code: i.code, message: i.message })),
      })
    }
    const enhancementSpec = parse.data

    const repoRow = await prisma.codegenRepoModel.findUnique({ where: { id: repoModelId } })
    if (!repoRow) throw new NotFoundError('CodegenRepoModel', repoModelId)
    const repoModel = repoRow.modelJson as unknown as RepoModel

    if (enhancementSpec.application.framework !== repoModel.application.framework) {
      return res.status(400).json({
        code: 'FRAMEWORK_MISMATCH',
        message: `Enhancement framework '${enhancementSpec.application.framework}' does not match repo framework '${repoModel.application.framework}'.`,
      })
    }

    const enhancementSpecHash = sha256(canonicalize(enhancementSpec))
    let impact
    try {
      impact = analyseImpact({ enhancementSpec, repoModel })
    } catch (err) {
      if (err instanceof ImpactAnalysisError) {
        return res.status(400).json({ code: err.code, message: err.message })
      }
      throw err
    }

    let plan
    try {
      plan = buildChangePlan({
        enhancementSpec, repoModel, impact,
        enhancementSpecHash,
        repoModelHash: repoRow.modelHash,
      })
    } catch (err) {
      if (err instanceof PlannerError) {
        return res.status(400).json({ code: err.code, message: err.message })
      }
      throw err
    }

    const planJson = JSON.parse(canonicalize(plan)) as object
    const planHash = hashPlan(plan)

    const row = await prisma.codegenChangePlan.create({
      data: {
        repoModelId: repoRow.id,
        enhancementSpecJson: enhancementSpec as unknown as object,
        enhancementSpecHash,
        planJson,
        planHash,
        status: 'PROPOSED',
      },
    })

    res.json({
      changePlanId: row.id,
      planHash,
      enhancementSpecHash,
      repoModelHash: repoRow.modelHash,
      impact,
      plan,
    })
  } catch (err) { next(err) }
})

/* ─── GET /change-plans/:id ──────────────────────────────────────────────── */

brownfieldRouter.get('/change-plans/:id', async (req, res, next) => {
  try {
    const row = await prisma.codegenChangePlan.findUnique({ where: { id: req.params.id } })
    if (!row) throw new NotFoundError('CodegenChangePlan', req.params.id)
    res.json(row)
  } catch (err) { next(err) }
})

/* ─── POST /enhancements/apply ───────────────────────────────────────────── */

brownfieldRouter.post('/enhancements/apply', async (req, res, next) => {
  try {
    const body = parseJsonBody(req)
    const changePlanId = stringField(body, 'changePlanId')
    if (!changePlanId) throw new ValidationError('Missing changePlanId.')
    const apply = body && typeof (body as { apply?: unknown }).apply === 'boolean'
      ? (body as { apply: boolean }).apply
      : true

    const planRow = await prisma.codegenChangePlan.findUnique({ where: { id: changePlanId } })
    if (!planRow) throw new NotFoundError('CodegenChangePlan', changePlanId)
    const repoRow = await prisma.codegenRepoModel.findUnique({ where: { id: planRow.repoModelId } })
    if (!repoRow) throw new NotFoundError('CodegenRepoModel', planRow.repoModelId)

    const repoModel = repoRow.modelJson as unknown as RepoModel
    const plan = planRow.planJson as unknown as ReturnType<typeof buildChangePlan>
    const enhancementSpec = planRow.enhancementSpecJson as unknown as
      ReturnType<typeof enhancementSpecSchema['parse']>

    const outcome = dispatchChangePlan({
      repoPath: repoRow.repoPath,
      enhancementSpec,
      repoModel,
      plan,
      apply,
    })

    const nextStatus = outcome.status === 'OK'
      ? (outcome.unresolvedOperations.length === 0 ? 'APPLIED' : 'PARTIALLY_APPLIED')
      : (outcome.status === 'BLOCKED' ? 'REJECTED' : 'FAILED')

    let runId: string | undefined
    let receiptHash: string | undefined
    let llmTaskIds: string[] = []

    if (apply) {
      await prisma.codegenChangePlan.update({
        where: { id: planRow.id },
        data: {
          status: nextStatus as 'APPLIED' | 'PARTIALLY_APPLIED' | 'REJECTED' | 'FAILED',
          appliedAt: outcome.status === 'OK' ? new Date() : null,
        },
      })

      // Persist the brownfield run + receipt + LLM patch tasks only when
      // we actually wrote to disk. Receipt anchors on
      // (repoModelHash, enhancementSpecHash, changePlanHash) per §25.16.
      if (outcome.status === 'OK') {
        const persisted = await persistBrownfieldReceipt({
          repoModelId: repoRow.id,
          repoModelHash: repoRow.modelHash,
          changePlanId: planRow.id,
          enhancementSpec,
          enhancementSpecHash: planRow.enhancementSpecHash,
          plan,
          planHash: planRow.planHash,
          outputPath: repoRow.repoPath,
          outcome,
          actorId: headerString(req, 'x-actor-id') ?? null,
          workItemId: enhancementSpec.metadata.workItemId ?? null,
        })
        runId = persisted.runId
        receiptHash = persisted.receiptHash
        llmTaskIds = persisted.llmTaskIds
      }
    }

    res.json({
      changePlanId: planRow.id,
      status: outcome.status,
      reason: outcome.reason,
      planStatus: nextStatus,
      apply,
      runId,
      receiptHash,
      llmTaskIds,
      edits: outcome.edits,
      llmTasks: outcome.llmTasks,
      unresolvedOperations: outcome.unresolvedOperations,
      recipeNotes: outcome.recipeNotes,
    })
  } catch (err) { next(err) }
})

// ─────────────────────────────────────────────────────────────────────────

function summariseRepoModel(model: RepoModel) {
  return {
    application: model.application,
    controllers: model.controllers.length,
    endpoints: model.controllers.reduce((sum, c) => sum + c.endpoints.length, 0),
    models: model.models.length,
    services: model.services.length,
    tests: model.tests.length,
    contracts: model.contracts.length,
    auditEvents: model.auditEvents.length,
    securityConfigFiles: model.securityConfigFiles.length,
  }
}

function parseJsonBody(req: Request): Record<string, unknown> {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    return req.body as Record<string, unknown>
  }
  if (typeof req.body === 'string' && req.body.trim()) {
    try { return JSON.parse(req.body) as Record<string, unknown> }
    catch { throw new ValidationError('Invalid JSON body.') }
  }
  throw new ValidationError('Empty body.')
}

function parseYamlOrJsonBody(req: Request): Record<string, unknown> {
  const ct = (req.headers['content-type'] ?? '').toLowerCase()
  if (ct.includes('yaml') || (typeof req.body === 'string' && /\n\s*\w+\s*:/.test(req.body))) {
    const text = typeof req.body === 'string' ? req.body : ''
    if (!text) throw new ValidationError('Empty body.')
    try { return yaml.parse(text) as Record<string, unknown> }
    catch (err) { throw new ValidationError(`Invalid YAML: ${(err as Error).message}`) }
  }
  return parseJsonBody(req)
}

function stringField(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const v = (body as Record<string, unknown>)[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function pickString(body: unknown, key: string): string | undefined {
  return stringField(body, key)
}

function pickObject(body: unknown, key: string): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object') return undefined
  const v = (body as Record<string, unknown>)[key]
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return undefined
}

function optionalEnum(body: unknown, key: string, allowed: string[]): string | undefined {
  const v = stringField(body, key)
  if (v && !allowed.includes(v)) {
    throw new ValidationError(`Invalid '${key}': ${v}. Allowed: ${allowed.join(', ')}.`)
  }
  return v
}

function headerString(req: Request, name: string): string | undefined {
  const v = req.headers[name]
  if (typeof v === 'string' && v.trim()) return v.trim()
  return undefined
}
