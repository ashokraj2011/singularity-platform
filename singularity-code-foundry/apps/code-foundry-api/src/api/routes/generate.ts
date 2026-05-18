/**
 * M42.2 — Code generation REST surface.
 *
 *   POST /api/codegen/generate    Validate + freeze + generate + write
 *                                 files to disk. Returns runId, paths,
 *                                 receipt.
 *
 * Output directory rules:
 *   - Caller may pass `out` in the request body (relative or absolute).
 *   - If omitted, defaults to /workspace/<runId>/ inside the container.
 *     This matches the Foundry's sandbox volume mount.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { resolve } from 'node:path'
import yaml from 'yaml'
import { prisma } from '../../lib/prisma.js'
import { ValidationError } from '../../lib/errors.js'
import { validateSpec } from '../../spec/validate.js'
import { transitionSpec } from '../../spec/lifecycle.js'
import { runPolicies } from '../../policy/registry.js'
import { buildIr } from '../../ir/build.js'
import { generate as runGenerator } from '../../generator/registry.js'
import { writeFiles } from '../../generator/writer.js'
import { buildAndPersistReceipt } from '../../audit/receipt.js'
import { config } from '../../config.js'

export const generateRouter: Router = Router()

generateRouter.post('/generate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { spec: specInput, out: outOpt, workItemId, actorId } = parseGenerateBody(req)

    const validation = validateSpec(specInput)
    if (!validation.valid) {
      return res.status(400).json({ code: 'SPEC_INVALID', errors: validation.errors })
    }
    const policy = runPolicies(validation.spec!)
    if (!policy.passed) {
      return res.status(400).json({ code: 'POLICY_VIOLATIONS', errors: policy.errors })
    }
    const ir = buildIr({ spec: validation.spec!, specHash: validation.specHash! })

    // Persist (or upsert) the spec the same way /spec/freeze does.
    const existing = await prisma.codegenSpec.findUnique({
      where: { specName_version: { specName: validation.spec!.metadata.id, version: validation.spec!.metadata.version! } },
    })
    if (existing && existing.specHash !== validation.specHash) {
      return res.status(409).json({
        code: 'SPEC_HASH_DRIFT',
        message: `Spec '${existing.specName}@${existing.version}' already exists with a different hash. Bump metadata.version.`,
        existingHash: existing.specHash,
        attemptedHash: validation.specHash,
      })
    }
    const spec = existing
      ? await prisma.codegenSpec.update({
          where: { id: existing.id },
          data: { irJson: ir as unknown as object, irHash: ir.meta.irHash, workItemId: workItemId ?? existing.workItemId },
        })
      : await prisma.codegenSpec.create({
          data: {
            specName: validation.spec!.metadata.id,
            version: validation.spec!.metadata.version!,
            kind: validation.spec!.kind,
            state: 'DRAFT',
            yaml: typeof req.body === 'string' ? req.body : yaml.stringify(specInput),
            canonicalJson: JSON.parse(validation.canonicalJson!),
            specHash: validation.specHash!,
            irJson: ir as unknown as object,
            irHash: ir.meta.irHash,
            workItemId: workItemId ?? null,
            createdById: actorId,
          },
        })

    if (spec.state === 'DRAFT') {
      await transitionSpec({ specId: spec.id, toState: 'VALIDATED', actorId, reason: 'generate.validate' })
      await transitionSpec({ specId: spec.id, toState: 'POLICY_APPROVED', actorId, reason: 'generate.policy' })
      await transitionSpec({ specId: spec.id, toState: 'FROZEN', actorId, reason: 'generate.freeze' })
    } else if (spec.state === 'VALIDATED') {
      await transitionSpec({ specId: spec.id, toState: 'POLICY_APPROVED', actorId, reason: 'generate.policy' })
      await transitionSpec({ specId: spec.id, toState: 'FROZEN', actorId, reason: 'generate.freeze' })
    } else if (spec.state === 'POLICY_APPROVED') {
      await transitionSpec({ specId: spec.id, toState: 'FROZEN', actorId, reason: 'generate.freeze' })
    }

    // Render templates → files.
    const files = runGenerator(ir)
    // The generator may stamp a different templateVersion on the IR
    // (per-stack). Re-build a stamped IR so the receipt + manifest
    // record the correct version.
    const stampedIr = { ...ir, meta: { ...ir.meta, templateVersion: files[0]?.generatedBy?.split('/')[0]
      ? deriveTemplateVersion(ir.application.framework)
      : ir.meta.templateVersion } }

    const outDir = resolve(
      outOpt && typeof outOpt === 'string' && outOpt.length > 0
        ? outOpt
        : `${config.WORKSPACE_ROOT}/${spec.id}`,
    )
    const writeResult = writeFiles(outDir, stampedIr, files)

    // After generate is complete, fold artifacts into the receipt.
    const persisted = await buildAndPersistReceipt({
      specId: spec.id,
      specName: spec.specName,
      specVersion: spec.version,
      specHash: spec.specHash,
      ir: stampedIr,
      workItemId: spec.workItemId,
      actorId,
      generatedArtifacts: writeResult.files.map(f => ({
        path: f.path,
        contentHash: f.contentHash,
        protected: f.protected,
        fileType: f.fileType,
      })),
      outputPath: outDir,
    })

    res.json({
      specId: spec.id,
      runId: persisted.runId,
      receiptHash: persisted.receiptHash,
      specHash: spec.specHash,
      irHash: ir.meta.irHash,
      templateVersion: stampedIr.meta.templateVersion,
      outputPath: outDir,
      generatedFileCount: writeResult.files.length,
      manifestPath: writeResult.manifestPath,
      // Coverage summary so callers see at a glance whether LLM patches
      // will be required for any endpoint.
      coverage: ir.endpoints.map(e => ({
        operationId: e.operationId,
        coverage: e.businessLogicCoverage,
        willEmitEditableRegion: e.businessLogicCoverage !== 'FULL',
      })),
    })
  } catch (err) {
    next(err)
  }
})

function parseGenerateBody(req: Request): {
  spec: unknown
  out?: string
  workItemId?: string
  actorId?: string
} {
  const ct = (req.headers['content-type'] ?? '').toLowerCase()
  if (ct.includes('yaml') || typeof req.body === 'string') {
    const text = typeof req.body === 'string' ? req.body : ''
    if (!text) throw new ValidationError('Empty body.')
    return {
      spec: yaml.parse(text),
      out: stringHeader(req, 'x-output-dir'),
      workItemId: stringHeader(req, 'x-work-item-id'),
      actorId: stringHeader(req, 'x-actor-id'),
    }
  }
  if (!req.body || typeof req.body !== 'object') {
    throw new ValidationError('POST a JSON object with a `spec` field, or YAML body.')
  }
  // JSON shape:  { spec: <obj>, out?: '<dir>', workItemId?, actorId? }
  const body = req.body as Record<string, unknown>
  if (!body.spec) throw new ValidationError('Missing `spec` in JSON body.')
  return {
    spec: body.spec,
    out: typeof body.out === 'string' ? body.out : undefined,
    workItemId: typeof body.workItemId === 'string' ? body.workItemId : undefined,
    actorId: typeof body.actorId === 'string' ? body.actorId : undefined,
  }
}

function stringHeader(req: Request, name: string): string | undefined {
  const v = req.headers[name]
  if (typeof v === 'string' && v.trim()) return v.trim()
  return undefined
}

function deriveTemplateVersion(framework: string): string {
  return `${framework}-template-0.1.0`
}
