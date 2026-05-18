/**
 * M42.6 — Run + artifact list/detail surface for the approval UI.
 *
 *   GET /api/codegen/runs                       List runs (newest first).
 *                                               Optional filters: status,
 *                                               mode, specId, take, skip.
 *   GET /api/codegen/runs/:runId                Full run row + spec name
 *                                               + counts of artifacts /
 *                                               gaps / tasks for the
 *                                               header strip in the SPA.
 *   GET /api/codegen/runs/:runId/artifacts      List artifact rows for
 *                                               the run (already in DB).
 *   GET /api/codegen/runs/:runId/file?path=...  Stream a single file's
 *                                               contents from disk. Used
 *                                               by the SPA's file viewer.
 *                                               Path is resolved against
 *                                               the run's outputPath; any
 *                                               attempt to escape it via
 *                                               `..` is rejected.
 *   GET /api/codegen/repos                      List CodegenRepoModel rows.
 *   GET /api/codegen/change-plans               List CodegenChangePlan rows.
 *   GET /api/codegen/llm-tasks/:taskId          Single task with its
 *                                               metadata blob.
 *
 * All endpoints are read-only and inherit the master+greenfield (or
 * brownfield) flag gates from the parent router mount.
 */
import { Router } from 'express'
import { readFileSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'

export const runsRouter: Router = Router()

const MAX_TAKE = 100
const DEFAULT_TAKE = 25
const MAX_FILE_BYTES = 1024 * 1024 // 1 MB

runsRouter.get('/runs', async (req, res, next) => {
  try {
    const take = clampInt(req.query.take, DEFAULT_TAKE, 1, MAX_TAKE)
    const skip = clampInt(req.query.skip, 0, 0, 10000)
    const where: Record<string, unknown> = {}
    if (typeof req.query.status === 'string') where.status = req.query.status
    if (typeof req.query.mode === 'string') where.mode = req.query.mode
    if (typeof req.query.specId === 'string') where.specId = req.query.specId

    const [total, items] = await Promise.all([
      prisma.codegenRun.count({ where }),
      prisma.codegenRun.findMany({
        where,
        orderBy: [{ startedAt: 'desc' }],
        take,
        skip,
        include: {
          spec: { select: { specName: true, version: true, kind: true } },
        },
      }),
    ])
    res.json({
      total,
      take,
      skip,
      items: items.map(r => ({
        id: r.id,
        specId: r.specId,
        specName: r.spec?.specName,
        specVersion: r.spec?.version,
        specKind: r.spec?.kind,
        mode: r.mode,
        status: r.status,
        templateVersion: r.templateVersion,
        generatorVersion: r.generatorVersion,
        outputPath: r.outputPath,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        brownfieldPlanId: r.brownfieldPlanId,
      })),
    })
  } catch (err) { next(err) }
})

runsRouter.get('/runs/:runId', async (req, res, next) => {
  try {
    const run = await prisma.codegenRun.findUnique({
      where: { id: req.params.runId },
      include: {
        spec: { select: { specName: true, version: true, kind: true, specHash: true, irHash: true } },
        receipt: { select: { id: true, receiptHash: true, createdAt: true } },
        changePlan: { select: { id: true, status: true, planHash: true, repoModelId: true } },
      },
    })
    if (!run) throw new NotFoundError('CodegenRun', req.params.runId)
    const [artifactCount, gapCount, openGapCount, taskCount, openTaskCount] = await Promise.all([
      prisma.codegenArtifact.count({ where: { runId: run.id } }),
      prisma.codegenGap.count({ where: { runId: run.id } }),
      prisma.codegenGap.count({ where: { runId: run.id, resolved: false } }),
      prisma.codegenLlmPatchTask.count({ where: { runId: run.id } }),
      prisma.codegenLlmPatchTask.count({ where: { runId: run.id, status: { in: ['PENDING', 'DISPATCHED'] } } }),
    ])
    res.json({
      ...run,
      counts: {
        artifacts: artifactCount,
        gaps: gapCount,
        openGaps: openGapCount,
        llmTasks: taskCount,
        openLlmTasks: openTaskCount,
      },
    })
  } catch (err) { next(err) }
})

runsRouter.get('/runs/:runId/artifacts', async (req, res, next) => {
  try {
    const run = await prisma.codegenRun.findUnique({ where: { id: req.params.runId } })
    if (!run) throw new NotFoundError('CodegenRun', req.params.runId)
    const items = await prisma.codegenArtifact.findMany({
      where: { runId: run.id },
      orderBy: [{ path: 'asc' }],
    })
    res.json({ runId: run.id, outputPath: run.outputPath, items })
  } catch (err) { next(err) }
})

runsRouter.get('/runs/:runId/file', async (req, res, next) => {
  try {
    const run = await prisma.codegenRun.findUnique({ where: { id: req.params.runId } })
    if (!run) throw new NotFoundError('CodegenRun', req.params.runId)
    if (!run.outputPath) throw new ValidationError('Run has no outputPath; file content unavailable.')
    const rel = typeof req.query.path === 'string' ? req.query.path : ''
    if (!rel) throw new ValidationError('Missing ?path=<relative-file-path>.')

    // Reject absolute paths + .. traversal — file content must live
    // strictly under the run's outputPath. We resolve both sides and
    // require the absolute result to start with outputPath + sep.
    if (rel.startsWith('/') || rel.includes('\\') || rel.split(/[/\\]/).some(s => s === '..')) {
      throw new ValidationError(`Invalid path '${rel}'.`)
    }
    const base = resolve(run.outputPath)
    const abs = resolve(base, rel)
    if (!(abs === base || abs.startsWith(base + sep))) {
      throw new ValidationError(`Path '${rel}' escapes the run output directory.`)
    }
    let stat
    try { stat = statSync(abs) } catch {
      return res.status(404).json({ code: 'NOT_FOUND', message: `File '${rel}' not found.` })
    }
    if (!stat.isFile()) {
      return res.status(400).json({ code: 'NOT_A_FILE', message: `Path '${rel}' is not a file.` })
    }
    if (stat.size > MAX_FILE_BYTES) {
      return res.status(413).json({
        code: 'FILE_TOO_LARGE',
        message: `File '${rel}' is ${stat.size} bytes; viewer limit is ${MAX_FILE_BYTES}.`,
        size: stat.size,
        limit: MAX_FILE_BYTES,
      })
    }
    const content = readFileSync(abs, 'utf8')
    res.json({
      path: rel,
      bytes: stat.size,
      content,
      modifiedAt: stat.mtime,
    })
  } catch (err) { next(err) }
})

runsRouter.get('/repos', async (_req, res, next) => {
  try {
    const items = await prisma.codegenRepoModel.findMany({
      orderBy: [{ scannedAt: 'desc' }],
      take: 50,
    })
    res.json({
      items: items.map(r => ({
        id: r.id,
        repoPath: r.repoPath,
        language: r.language,
        framework: r.framework,
        modelHash: r.modelHash,
        scannedAt: r.scannedAt,
      })),
    })
  } catch (err) { next(err) }
})

runsRouter.get('/change-plans', async (req, res, next) => {
  try {
    const repoModelId = typeof req.query.repoModelId === 'string' ? req.query.repoModelId : undefined
    const items = await prisma.codegenChangePlan.findMany({
      where: repoModelId ? { repoModelId } : undefined,
      orderBy: [{ createdAt: 'desc' }],
      take: 50,
      select: {
        id: true,
        repoModelId: true,
        planHash: true,
        enhancementSpecHash: true,
        status: true,
        createdAt: true,
        appliedAt: true,
      },
    })
    res.json({ items })
  } catch (err) { next(err) }
})

runsRouter.get('/llm-tasks/:taskId', async (req, res, next) => {
  try {
    const task = await prisma.codegenLlmPatchTask.findUnique({ where: { id: req.params.taskId } })
    if (!task) throw new NotFoundError('CodegenLlmPatchTask', req.params.taskId)
    res.json(task)
  } catch (err) { next(err) }
})

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'string') return fallback
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}
