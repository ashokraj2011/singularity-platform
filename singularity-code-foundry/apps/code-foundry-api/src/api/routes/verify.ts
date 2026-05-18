/**
 * M42.3 — Verification + Gap detection REST surface.
 *
 *   POST /api/codegen/runs/:runId/verify
 *     Run the per-stack verifier against the run's output directory.
 *     Persist a CodegenVerification row and return its body.
 *
 *   POST /api/codegen/runs/:runId/detect-gaps
 *     Run the static gap detector (and fold in the latest verification
 *     result if present). Replaces any existing UNRESOLVED gap rows
 *     for the run.
 *
 *   GET  /api/codegen/runs/:runId/gaps
 *     List the current gaps for a run.
 *
 *   GET  /api/codegen/runs/:runId/verification
 *     Return the latest verification result for the run.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../lib/errors.js'
import { runVerification } from '../../verify/runner.js'
import type { VerificationResult } from '../../verify/types.js'
import { detectGaps } from '../../gaps/detect.js'

export const verifyRouter: Router = Router()

verifyRouter.post('/runs/:runId/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const run = await prisma.codegenRun.findUnique({ where: { id: req.params.runId } })
    if (!run) throw new NotFoundError('CodegenRun', req.params.runId)
    if (!run.outputPath) {
      return res.status(409).json({
        code: 'NO_OUTPUT',
        message: `Run ${run.id} has no outputPath — generate the project first via POST /api/codegen/generate.`,
      })
    }
    const spec = await prisma.codegenSpec.findUnique({ where: { id: run.specId } })
    if (!spec?.irJson) throw new NotFoundError('CodegenSpec.ir', run.specId)
    // The IR JSON stored on CodegenSpec is the same shape we feed the
    // runner. Cast once at the boundary.
    const ir = spec.irJson as unknown as Parameters<typeof runVerification>[0]
    const result = await runVerification(ir, run.outputPath)
    const persisted = await prisma.codegenVerification.create({
      data: {
        runId: run.id,
        status: result.status,
        result: result as unknown as object,
      },
    })
    // Bump the run's status once a real verifier has run (skipped =
    // no change).
    if (result.status === 'PASSED') {
      await prisma.codegenRun.update({ where: { id: run.id }, data: { status: 'VERIFIED', completedAt: new Date() } })
    } else if (result.status === 'FAILED') {
      await prisma.codegenRun.update({ where: { id: run.id }, data: { status: 'GAPS_DETECTED' } })
    }
    res.json({ id: persisted.id, ...result })
  } catch (err) {
    next(err)
  }
})

verifyRouter.post('/runs/:runId/detect-gaps', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const run = await prisma.codegenRun.findUnique({ where: { id: req.params.runId } })
    if (!run) throw new NotFoundError('CodegenRun', req.params.runId)
    if (!run.outputPath) {
      return res.status(409).json({
        code: 'NO_OUTPUT',
        message: `Run ${run.id} has no outputPath — generate the project first.`,
      })
    }
    const latestVerify = await prisma.codegenVerification.findFirst({
      where: { runId: run.id },
      orderBy: { createdAt: 'desc' },
    })
    const verification = latestVerify ? (latestVerify.result as unknown as VerificationResult) : undefined
    const detected = detectGaps({ projectDir: run.outputPath, verification })

    // Replace UNRESOLVED gaps for the run with the latest scan.
    // Resolved gaps are kept for the audit trail.
    await prisma.codegenGap.deleteMany({ where: { runId: run.id, resolved: false } })
    if (detected.length > 0) {
      await prisma.codegenGap.createMany({
        data: detected.map((g) => ({
          runId: run.id,
          gapType: g.type,
          severity: g.severity,
          filePath: g.filePath,
          className: g.className,
          methodName: g.methodName,
          regionId: g.regionId,
          description: g.description,
          recommendedResolution: g.recommendedResolution,
          llmEligible: g.llmEligible,
        })),
      })
    }
    if (detected.length > 0) {
      await prisma.codegenRun.update({ where: { id: run.id }, data: { status: 'GAPS_DETECTED' } })
    }
    res.json({ runId: run.id, gapCount: detected.length, gaps: detected })
  } catch (err) {
    next(err)
  }
})

verifyRouter.get('/runs/:runId/gaps', async (req, res, next) => {
  try {
    const items = await prisma.codegenGap.findMany({
      where: { runId: req.params.runId },
      orderBy: [{ resolved: 'asc' }, { severity: 'desc' }, { createdAt: 'asc' }],
    })
    res.json({ runId: req.params.runId, items })
  } catch (err) { next(err) }
})

verifyRouter.get('/runs/:runId/verification', async (req, res, next) => {
  try {
    const row = await prisma.codegenVerification.findFirst({
      where: { runId: req.params.runId },
      orderBy: { createdAt: 'desc' },
    })
    if (!row) throw new NotFoundError('CodegenVerification', req.params.runId)
    res.json({ id: row.id, status: row.status, createdAt: row.createdAt, ...(row.result as object) })
  } catch (err) { next(err) }
})
