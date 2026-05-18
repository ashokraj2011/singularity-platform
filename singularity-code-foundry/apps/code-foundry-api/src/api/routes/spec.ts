/**
 * M42.1 — Spec REST surface.
 *
 *   POST /api/codegen/spec/validate        Validate a spec; return errors
 *                                          + IR preview + hashes.
 *   POST /api/codegen/spec/freeze          Persist a frozen spec, build
 *                                          the IR, persist the run, write
 *                                          the receipt. Returns specId,
 *                                          runId, receiptHash.
 *   GET  /api/codegen/specs/:id            Read a persisted spec.
 *   GET  /api/codegen/specs/:id/history    List spec lifecycle events.
 *
 * Every route is gated on `code_foundry.enabled` (master) via the
 * featureGate middleware mounted in api/router.ts.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { validateSpec } from '../../spec/validate.js'
import { transitionSpec } from '../../spec/lifecycle.js'
import { buildIr } from '../../ir/build.js'
import { runPolicies } from '../../policy/registry.js'
import { buildAndPersistReceipt } from '../../audit/receipt.js'
import yaml from 'yaml'

export const specRouter: Router = Router()

/* ─── POST /spec/validate ───────────────────────────────────────────────── */

specRouter.post('/spec/validate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = parseYamlOrJsonBody(req)
    const result = validateSpec(raw)
    if (!result.valid) {
      return res.status(400).json({
        valid: false,
        errors: result.errors,
        warnings: result.warnings,
      })
    }
    const policy = runPolicies(result.spec!)
    const ir = buildIr({ spec: result.spec!, specHash: result.specHash! })
    res.json({
      valid: policy.passed,
      errors: policy.errors,
      warnings: [...result.warnings, ...policy.warnings],
      specHash: result.specHash,
      irHash: ir.meta.irHash,
      ir,
    })
  } catch (err) {
    next(err)
  }
})

/* ─── POST /spec/freeze ─────────────────────────────────────────────────── */

specRouter.post('/spec/freeze', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = parseYamlOrJsonBody(req)
    const validation = validateSpec(raw)
    if (!validation.valid) {
      return res.status(400).json({ code: 'SPEC_INVALID', errors: validation.errors })
    }
    const policy = runPolicies(validation.spec!)
    if (!policy.passed) {
      return res.status(400).json({ code: 'POLICY_VIOLATIONS', errors: policy.errors })
    }
    const ir = buildIr({ spec: validation.spec!, specHash: validation.specHash! })

    // Upsert the spec — re-freezing the same (specName, version) is
    // idempotent if its hash matches. A version change → new row.
    const existing = await prisma.codegenSpec.findUnique({
      where: { specName_version: { specName: validation.spec!.metadata.id, version: validation.spec!.metadata.version! } },
    })
    if (existing && existing.specHash !== validation.specHash) {
      return res.status(409).json({
        code: 'SPEC_HASH_DRIFT',
        message: `Spec '${existing.specName}@${existing.version}' already exists with a different hash. Bump metadata.version to register a new version.`,
        existingHash: existing.specHash,
        attemptedHash: validation.specHash,
      })
    }

    const actorId = headerString(req, 'x-actor-id')
    const workItemId = headerString(req, 'x-work-item-id') ?? null

    const spec = existing
      ? await prisma.codegenSpec.update({
          where: { id: existing.id },
          data: {
            irJson: ir as unknown as object,
            irHash: ir.meta.irHash,
            workItemId,
          },
        })
      : await prisma.codegenSpec.create({
          data: {
            specName: validation.spec!.metadata.id,
            version: validation.spec!.metadata.version!,
            kind: validation.spec!.kind,
            state: 'DRAFT',
            yaml: typeof req.body === 'string' ? req.body : yaml.stringify(raw),
            canonicalJson: JSON.parse(validation.canonicalJson!),
            specHash: validation.specHash!,
            irJson: ir as unknown as object,
            irHash: ir.meta.irHash,
            workItemId,
            createdById: actorId,
          },
        })

    // March through the legal transitions. transitionSpec emits the
    // SpecLifecycleEvent rows AND fans out to audit-gov.
    if (spec.state === 'DRAFT') {
      await transitionSpec({ specId: spec.id, toState: 'VALIDATED', actorId, reason: 'validate' })
      await transitionSpec({ specId: spec.id, toState: 'POLICY_APPROVED', actorId, reason: 'policy_approved' })
      await transitionSpec({ specId: spec.id, toState: 'FROZEN', actorId, reason: 'freeze' })
    } else if (spec.state === 'VALIDATED') {
      await transitionSpec({ specId: spec.id, toState: 'POLICY_APPROVED', actorId, reason: 'policy_approved' })
      await transitionSpec({ specId: spec.id, toState: 'FROZEN', actorId, reason: 'freeze' })
    } else if (spec.state === 'POLICY_APPROVED') {
      await transitionSpec({ specId: spec.id, toState: 'FROZEN', actorId, reason: 'freeze' })
    }

    const persisted = await buildAndPersistReceipt({
      specId: spec.id,
      specName: spec.specName,
      specVersion: spec.version,
      specHash: spec.specHash,
      ir,
      workItemId,
      actorId,
    })

    res.json({
      specId: spec.id,
      specName: spec.specName,
      version: spec.version,
      specHash: spec.specHash,
      irHash: ir.meta.irHash,
      state: 'FROZEN',
      runId: persisted.runId,
      receiptHash: persisted.receiptHash,
    })
  } catch (err) {
    next(err)
  }
})

/* ─── GET /specs/:id ────────────────────────────────────────────────────── */

specRouter.get('/specs/:id', async (req, res, next) => {
  try {
    const spec = await prisma.codegenSpec.findUnique({ where: { id: req.params.id } })
    if (!spec) throw new NotFoundError('CodegenSpec', req.params.id)
    res.json(spec)
  } catch (err) {
    next(err)
  }
})

/* ─── GET /specs/:id/history ────────────────────────────────────────────── */

specRouter.get('/specs/:id/history', async (req, res, next) => {
  try {
    const spec = await prisma.codegenSpec.findUnique({ where: { id: req.params.id } })
    if (!spec) throw new NotFoundError('CodegenSpec', req.params.id)
    const events = await prisma.specLifecycleEvent.findMany({
      where: { specId: spec.id },
      orderBy: { occurredAt: 'asc' },
    })
    res.json({ items: events })
  } catch (err) {
    next(err)
  }
})

/* ─── GET /specs/:id/runs/:runId/receipt ────────────────────────────────── */

specRouter.get('/runs/:runId/receipt', async (req, res, next) => {
  try {
    const receipt = await prisma.codegenReceipt.findFirst({ where: { runId: req.params.runId } })
    if (!receipt) throw new NotFoundError('CodegenReceipt', req.params.runId)
    res.json(receipt)
  } catch (err) {
    next(err)
  }
})

// ─────────────────────────────────────────────────────────────────────────

function parseYamlOrJsonBody(req: Request): unknown {
  const ct = (req.headers['content-type'] ?? '').toLowerCase()
  if (ct.includes('yaml') || typeof req.body === 'string') {
    const text = typeof req.body === 'string' ? req.body : ''
    if (!text) throw new ValidationError('Empty body. Send YAML as content-type: application/yaml or JSON.')
    try {
      return yaml.parse(text)
    } catch (err) {
      throw new ValidationError(`Invalid YAML: ${(err as Error).message}`)
    }
  }
  if (req.body === null || req.body === undefined || (typeof req.body === 'object' && Object.keys(req.body).length === 0)) {
    throw new ValidationError('Empty body. POST a service spec as JSON or YAML.')
  }
  return req.body
}

function headerString(req: Request, name: string): string | undefined {
  const v = req.headers[name]
  if (typeof v === 'string' && v.trim()) return v.trim()
  return undefined
}
