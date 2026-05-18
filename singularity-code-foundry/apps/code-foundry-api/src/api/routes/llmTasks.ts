/**
 * M42.4 — LLM patch task lifecycle.
 *
 *   POST /api/codegen/runs/:runId/llm-tasks
 *     Build typed patch tasks from the run's LLM-eligible gaps.
 *     Returns the new tasks (idempotent on (runId, gapId)).
 *
 *   GET  /api/codegen/runs/:runId/llm-tasks
 *
 *   POST /api/codegen/llm-tasks/:taskId/dispatch
 *     Call prompt-composer to obtain a unified diff for this task.
 *     Returns COMPOSER_UNCONFIGURED when PROMPT_COMPOSER_URL is unset.
 *
 *   POST /api/codegen/llm-tasks/:taskId/apply-patch
 *     Validate a unified diff against the Patch Guard. On accept,
 *     write to the run's outputPath and flip status GUARD_PASSED.
 *     On reject, persist the reason and flip GUARD_REJECTED.
 *     Body: { diff: string } OR raw text/plain.
 */
import { Router, type Request } from 'express'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { sha256 } from '../../spec/hash.js'
import { buildTaskFromGap } from '../../llm/taskBuilder.js'
import { dispatchPatchTask } from '../../llm/dispatch.js'
import { commitApplied, runGuard, type GuardOutcome } from '../../patchGuard/runChecks.js'

export const llmTasksRouter: Router = Router()

llmTasksRouter.post('/runs/:runId/llm-tasks', async (req, res, next) => {
  try {
    const run = await prisma.codegenRun.findUnique({ where: { id: req.params.runId } })
    if (!run) throw new NotFoundError('CodegenRun', req.params.runId)
    const gaps = await prisma.codegenGap.findMany({
      where: { runId: run.id, llmEligible: true, resolved: false },
    })
    const created: Array<{ id: string; gapId: string | null; taskType: string; regionId: string }> = []
    for (const gap of gaps) {
      const built = buildTaskFromGap(gap)
      if (!built) continue
      // Idempotency: one PENDING task per (runId, gapId, regionId).
      const existing = await prisma.codegenLlmPatchTask.findFirst({
        where: { runId: run.id, gapId: gap.id, status: { in: ['PENDING', 'DISPATCHED'] } },
      })
      if (existing) {
        created.push({ id: existing.id, gapId: existing.gapId, taskType: existing.taskType, regionId: existing.regionId })
        continue
      }
      const row = await prisma.codegenLlmPatchTask.create({
        data: {
          runId: run.id,
          gapId: gap.id,
          taskType: built.taskType,
          status: 'PENDING',
          targetFile: built.targetFile,
          targetClass: built.targetClass ?? null,
          targetMethod: built.targetMethod ?? null,
          regionId: built.regionId,
          allowedChanges: built.allowedChanges,
          forbiddenChanges: built.forbiddenChanges,
          metadata: built.metadata,
        },
      })
      created.push({ id: row.id, gapId: row.gapId, taskType: row.taskType, regionId: row.regionId })
    }
    res.json({ runId: run.id, created: created.length, tasks: created })
  } catch (err) {
    next(err)
  }
})

llmTasksRouter.get('/runs/:runId/llm-tasks', async (req, res, next) => {
  try {
    const items = await prisma.codegenLlmPatchTask.findMany({
      where: { runId: req.params.runId },
      orderBy: [{ createdAt: 'asc' }],
    })
    res.json({ runId: req.params.runId, items })
  } catch (err) { next(err) }
})

llmTasksRouter.post('/llm-tasks/:taskId/dispatch', async (req, res, next) => {
  try {
    const task = await prisma.codegenLlmPatchTask.findUnique({ where: { id: req.params.taskId } })
    if (!task) throw new NotFoundError('CodegenLlmPatchTask', req.params.taskId)
    const result = await dispatchPatchTask({
      promptKey: 'codegen.patch.user-template',
      vars: {
        taskType: task.taskType,
        targetFile: task.targetFile,
        targetClass: task.targetClass,
        targetMethod: task.targetMethod,
        regionId: task.regionId,
        allowedChanges: task.allowedChanges,
        forbiddenChanges: task.forbiddenChanges,
        gapDescription: (task.metadata as { gapDescription?: string } | null)?.gapDescription ?? null,
      },
    })
    await prisma.codegenLlmPatchTask.update({
      where: { id: task.id },
      data: {
        status: result.status === 'OK' ? 'DISPATCHED' : task.status,
        dispatchedAt: result.status === 'OK' ? new Date() : task.dispatchedAt,
        cfCallId: result.cfCallId ?? null,
        bundleHash: result.bundleHash ?? null,
        promptHash: result.diff ? sha256(result.diff) : null,
        metadata: {
          ...(task.metadata as Record<string, unknown> | null ?? {}),
          dispatchStatus: result.status,
          dispatchError: result.error,
        } as object,
      },
    })
    res.json({
      taskId: task.id,
      status: result.status,
      diff: result.diff,
      cfCallId: result.cfCallId,
      bundleHash: result.bundleHash,
      error: result.error,
    })
  } catch (err) {
    next(err)
  }
})

llmTasksRouter.post('/llm-tasks/:taskId/apply-patch', async (req, res, next) => {
  try {
    const task = await prisma.codegenLlmPatchTask.findUnique({ where: { id: req.params.taskId } })
    if (!task) throw new NotFoundError('CodegenLlmPatchTask', req.params.taskId)
    if (task.status === 'GUARD_PASSED') {
      return res.status(409).json({ code: 'ALREADY_APPLIED', message: 'Task already applied.' })
    }
    const run = await prisma.codegenRun.findUnique({ where: { id: task.runId } })
    if (!run?.outputPath) throw new NotFoundError('CodegenRun.outputPath', task.runId)

    const diff = extractDiffFromBody(req)
    if (!diff) throw new ValidationError('Missing diff in request body.')

    const outcome: GuardOutcome = runGuard({
      projectDir: run.outputPath,
      diff,
      targetFile: task.targetFile,
      regionId: task.regionId,
    })

    if (!outcome.passed) {
      await prisma.codegenLlmPatchTask.update({
        where: { id: task.id },
        data: {
          status: 'GUARD_REJECTED',
          completedAt: new Date(),
          metadata: {
            ...(task.metadata as Record<string, unknown> | null ?? {}),
            rejectionStage: outcome.stage,
            rejectionReason: outcome.reason,
            rejectionDetails: outcome.details,
          } as object,
          responseHash: sha256(diff),
        },
      })
      return res.status(400).json({
        taskId: task.id,
        status: 'GUARD_REJECTED',
        stage: outcome.stage,
        reason: outcome.reason,
        details: outcome.details,
      })
    }

    // Accepted — commit to disk.
    commitApplied(run.outputPath, outcome.appliedFiles)

    // Update artifact rows so their content hashes match the new
    // on-disk contents. The receipt + audit chain stays internally
    // consistent.
    for (const f of outcome.appliedFiles) {
      await prisma.codegenArtifact.updateMany({
        where: { runId: run.id, path: f.filePath },
        data: { contentHash: f.afterHash },
      })
    }

    await prisma.codegenLlmPatchTask.update({
      where: { id: task.id },
      data: {
        status: 'GUARD_PASSED',
        completedAt: new Date(),
        responseHash: outcome.responseHash,
      },
    })

    // Mark the originating gap resolved.
    if (task.gapId) {
      await prisma.codegenGap.update({
        where: { id: task.gapId },
        data: { resolved: true, resolvedAt: new Date() },
      })
    }

    res.json({
      taskId: task.id,
      status: 'GUARD_PASSED',
      appliedFiles: outcome.appliedFiles.map(f => ({
        path: f.filePath,
        beforeHash: f.beforeHash,
        afterHash: f.afterHash,
      })),
      responseHash: outcome.responseHash,
    })
  } catch (err) {
    next(err)
  }
})

function extractDiffFromBody(req: Request): string | undefined {
  if (typeof req.body === 'string' && req.body.trim()) return req.body
  if (req.body && typeof req.body === 'object' && typeof (req.body as { diff?: unknown }).diff === 'string') {
    const diff = (req.body as { diff: string }).diff
    return diff.trim() ? diff : undefined
  }
  return undefined
}
