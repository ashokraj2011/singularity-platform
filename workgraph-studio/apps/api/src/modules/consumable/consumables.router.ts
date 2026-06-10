import { Router } from 'express'
import { z } from 'zod'
import Ajv from 'ajv'
import { Prisma, ConsumableType, ConsumableVersion } from '@prisma/client'
import { prisma } from '../../lib/prisma'
import { validate } from '../../middleware/validate'
import { parsePagination, toPageResponse } from '../../lib/pagination'
import { NotFoundError, ValidationError } from '../../lib/errors'
import { logEvent, createReceipt, publishOutbox } from '../../lib/audit'
import { contextFabricClient } from '../../lib/context-fabric/client'
import { resolveLlmRouting } from '../llm-routing/resolve'

export const consumablesRouter: Router = Router()

const ajv = new Ajv()

const createConsumableSchema = z.object({
  typeId: z.string().uuid(),
  instanceId: z.string().uuid().optional(),
  name: z.string().min(1),
})

const createVersionSchema = z.object({
  payload: z.record(z.unknown()).default({}),
})

consumablesRouter.post('/', validate(createConsumableSchema), async (req, res, next) => {
  try {
    const consumable = await prisma.consumable.create({
      data: { ...req.body, createdById: req.user!.userId },
      include: { type: true },
    })
    await logEvent('ConsumableCreated', 'Consumable', consumable.id, req.user!.userId)
    res.status(201).json(consumable)
  } catch (err) {
    next(err)
  }
})

consumablesRouter.get('/', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query as Record<string, unknown>)
    const { typeId, status, instanceId, nodeId } = req.query
    const where: Record<string, unknown> = {}
    if (typeId)     where.typeId     = typeId
    if (status)     where.status     = status
    if (instanceId) where.instanceId = instanceId
    if (nodeId)     where.nodeId     = nodeId

    const [consumables, total] = await Promise.all([
      prisma.consumable.findMany({
        where, skip: pg.skip, take: pg.take,
        include: { type: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.consumable.count({ where }),
    ])
    res.json(toPageResponse(consumables, total, pg))
  } catch (err) {
    next(err)
  }
})

consumablesRouter.get('/:id', async (req, res, next) => {
  try {
    const consumable = await prisma.consumable.findUnique({
      where: { id: req.params.id },
      include: { type: true, versions: { orderBy: { version: 'desc' } } },
    })
    if (!consumable) throw new NotFoundError('Consumable', req.params.id)
    res.json(consumable)
  } catch (err) {
    next(err)
  }
})

consumablesRouter.post('/:id/versions', validate(createVersionSchema), async (req, res, next) => {
  try {
    const { payload } = req.body as z.infer<typeof createVersionSchema>
    const id = req.params.id as string
    const consumable = await prisma.consumable.findUnique({
      where: { id },
      include: { type: true, versions: { orderBy: { version: 'desc' }, take: 1 } },
    }) as (Awaited<ReturnType<typeof prisma.consumable.findUnique>> & { type: ConsumableType; versions: ConsumableVersion[] }) | null
    if (!consumable) throw new NotFoundError('Consumable', id)

    // Schema validation against ConsumableType.schemaDef
    const schema = consumable.type.schemaDef as Record<string, unknown>
    if (schema && Object.keys(schema).length > 0) {
      const valid = ajv.validate(schema, payload)
      if (!valid) {
        throw new ValidationError(`Payload does not match consumable type schema: ${ajv.errorsText()}`)
      }
    }

    const nextVersion = (consumable.versions[0]?.version ?? 0) + 1
    const version = await prisma.consumableVersion.create({
      data: {
        consumableId: id,
        version: nextVersion,
        payload: payload as unknown as Prisma.InputJsonValue,
        createdById: req.user!.userId,
      },
    })
    await prisma.consumable.update({
      where: { id },
      data: { currentVersion: nextVersion },
    })
    res.status(201).json(version)
  } catch (err) {
    next(err)
  }
})

async function transitionStatus(
  consumableId: string,
  newStatus: string,
  actorId: string,
  receiptType?: string,
): Promise<void> {
  const consumable = await prisma.consumable.update({
    where: { id: consumableId },
    data: { status: newStatus as never },
  })
  const eventId = await logEvent(`Consumable${newStatus}`, 'Consumable', consumableId, actorId)
  if (receiptType) {
    await createReceipt(receiptType, 'Consumable', consumableId, {
      consumableId, status: newStatus, actorId,
    }, eventId)
  }
  await publishOutbox('Consumable', consumableId, `Consumable${newStatus}`, { consumableId, status: newStatus })
  void consumable
}

// ── Verifier agent ──────────────────────────────────────────────────────────
// Reads the standards/policies a document must satisfy (the run's acceptance
// criteria / definition-of-done + any configured verification policy + a baseline
// doc standard), then LLM-judges the document against them (AUDIT_JUDGE model via
// llm-routing). Falls back to deterministic structural checks when no LLM is
// available or its output can't be parsed, so verify never hard-fails.
type Verdict = {
  method: string
  passed: boolean
  findings: string[]
  rationale?: string
  standardsSummary?: string
  modelAlias?: string | null
  verifiedById: string
  verifiedAt: string
}

function structuralFindings(content: string): string[] {
  const findings: string[] = []
  if (content.trim().length < 50) findings.push('Very short (<50 chars) — likely incomplete.')
  if (!/#{1,6}\s|(^|\n)\s*[-*]\s/.test(content)) findings.push('No headings or bullet lists — add structure.')
  if (/\b(TODO|TBD|FIXME|XXX)\b/i.test(content)) findings.push('Contains TODO/TBD/FIXME placeholders.')
  return findings
}

async function gatherStandards(
  consumable: { instanceId: string | null },
): Promise<{ text: string; capabilityId: string | null }> {
  const parts: string[] = []
  let capabilityId: string | null = null
  if (consumable.instanceId) {
    const inst = await prisma.workflowInstance
      .findUnique({ where: { id: consumable.instanceId }, select: { context: true } })
      .catch(() => null)
    const ctx = (inst?.context ?? {}) as Record<string, unknown>
    const vars = (ctx._vars ?? ctx.vars ?? {}) as Record<string, unknown>
    const globals = (ctx._globals ?? ctx.globals ?? {}) as Record<string, unknown>
    if (typeof vars.parentCapabilityId === 'string' && vars.parentCapabilityId.trim()) {
      capabilityId = vars.parentCapabilityId.trim()
    }
    const pick = (k: string): string | undefined =>
      [vars[k], globals[k]].find(v => typeof v === 'string' && (v as string).trim()) as string | undefined
    const ac = pick('acceptanceCriteria')
    const dod = pick('definitionOfDone')
    const policy = pick('verificationPolicy') ?? pick('reviewPolicy')
    if (ac) parts.push(`Acceptance criteria:\n${ac}`)
    if (dod) parts.push(`Definition of done:\n${dod}`)
    if (policy) parts.push(`Verification policy:\n${policy}`)
  }
  parts.push(
    'Baseline document standards:\n' +
    '- Complete and self-contained for its stated purpose; no placeholder text (TODO/TBD/FIXME).\n' +
    '- Well structured (clear headings / sections) and internally consistent.\n' +
    '- Specific and unambiguous; claims are actionable and testable where applicable.',
  )
  return { text: parts.join('\n\n'), capabilityId }
}

function parseVerdict(text: string): { passed: boolean; findings: string[]; rationale?: string } | null {
  const m = text?.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>
    if (typeof o.passed !== 'boolean') return null
    const findings = Array.isArray(o.findings)
      ? o.findings.filter(f => typeof f === 'string').map(f => String(f))
      : []
    return { passed: o.passed, findings, rationale: typeof o.rationale === 'string' ? o.rationale : undefined }
  } catch {
    return null
  }
}

async function runVerification(
  consumable: { id: string; name: string; instanceId: string | null; formData: unknown },
  userId: string,
): Promise<Verdict> {
  const content = String((consumable.formData as Record<string, unknown> | null)?.content ?? '')
  const verifiedAt = new Date().toISOString()
  if (!content.trim()) {
    return { method: 'structural-v1', passed: false, findings: ['Document is empty.'], modelAlias: null, verifiedById: userId, verifiedAt }
  }

  const { text: standards, capabilityId } = await gatherStandards(consumable)
  const modelAlias = await resolveLlmRouting('AUDIT_JUDGE', { userId, capabilityId })

  const systemPrompt =
    'You are a meticulous compliance verifier. You are given a DOCUMENT and the STANDARDS/POLICIES it must satisfy. ' +
    'Judge ONLY whether the document meets the standards — do not rewrite the document. ' +
    'Respond with ONLY a JSON object (no prose, no code fence) of the form: ' +
    '{"passed": boolean, "findings": string[], "rationale": string}. ' +
    'findings = specific, actionable gaps against the standards (empty array when it passes). ' +
    'rationale = one or two sentences summarising the decision. Pass only when the document genuinely meets the standards.'
  const task =
    `## Standards / policies\n${standards}\n\n## Document: ${consumable.name}\n${content.slice(0, 24000)}`

  try {
    const resp = await contextFabricClient.executeGovernedTurn({
      system_prompt: systemPrompt,
      task,
      model_overrides: { modelAlias: modelAlias ?? undefined, temperature: 0, maxOutputTokens: 1200 },
      limits: { timeoutSec: 120 },
      run_context: { userId, capability_id: capabilityId ?? undefined, purpose: 'document_verification' },
    })
    const parsed = parseVerdict(resp.finalResponse ?? '')
    if (parsed) {
      return {
        method: 'policy-llm-v1',
        passed: parsed.passed,
        findings: parsed.findings,
        rationale: parsed.rationale,
        standardsSummary: standards.slice(0, 600),
        modelAlias: modelAlias ?? null,
        verifiedById: userId,
        verifiedAt,
      }
    }
  } catch {
    // fall through to the deterministic checks
  }
  const findings = structuralFindings(content)
  return { method: 'structural-fallback', passed: findings.length === 0, findings, modelAlias: modelAlias ?? null, verifiedById: userId, verifiedAt }
}

consumablesRouter.post('/:id/submit-review', async (req, res, next) => {
  try {
    await transitionStatus(req.params.id, 'UNDER_REVIEW', req.user!.userId)
    const c = await prisma.consumable.findUnique({ where: { id: req.params.id } })
    res.json(c)
  } catch (err) {
    next(err)
  }
})

consumablesRouter.post('/:id/approve', async (req, res, next) => {
  try {
    const force = req.query.force === 'true' || (req.body as { force?: unknown } | null)?.force === true
    const existing = await prisma.consumable.findUnique({ where: { id: req.params.id } })
    if (!existing) return res.status(404).json({ error: 'consumable not found' })
    // Verify-before-approve gate: refuse to approve a document that FAILED
    // verification (a recorded passed===false verdict). Un-verified docs still
    // approve (backward compatible). ?force=true overrides.
    const v = (existing.formData as Record<string, unknown> | null)?._verification as Verdict | undefined
    if (!force && v && v.passed === false) {
      return res.status(409).json({
        error: 'verification_failed',
        message: 'This document failed verification against the standards. Resolve the findings and re-verify, or approve with force=true.',
        verification: v,
      })
    }
    await transitionStatus(req.params.id, 'APPROVED', req.user!.userId, 'CONSUMABLE_APPROVAL')
    const c = await prisma.consumable.findUnique({ where: { id: req.params.id } })
    res.json(c)
  } catch (err) {
    next(err)
  }
})

consumablesRouter.post('/:id/reject', async (req, res, next) => {
  try {
    await transitionStatus(req.params.id, 'REJECTED', req.user!.userId)
    const c = await prisma.consumable.findUnique({ where: { id: req.params.id } })
    res.json(c)
  } catch (err) {
    next(err)
  }
})

// Verify a document — the verifier agent reads the run's standards/policies and
// LLM-judges the document against them (falling back to structural checks). The
// verdict is stored on the consumable (formData._verification) and gates approval.
// Used by the run-graph artifact catalog "Verify" button.
consumablesRouter.post('/:id/verify', async (req, res, next) => {
  try {
    const c = await prisma.consumable.findUnique({ where: { id: req.params.id } })
    if (!c) return res.status(404).json({ error: 'consumable not found' })
    const verdict = await runVerification(c, req.user!.userId)
    const formData = { ...((c.formData ?? {}) as Record<string, unknown>), _verification: verdict }
    await prisma.consumable.update({ where: { id: c.id }, data: { formData: formData as Prisma.InputJsonValue } })
    res.json({ id: c.id, ...verdict })
  } catch (err) {
    next(err)
  }
})

consumablesRouter.post('/:id/publish', async (req, res, next) => {
  try {
    await transitionStatus(req.params.id, 'PUBLISHED', req.user!.userId)
    const c = await prisma.consumable.findUnique({ where: { id: req.params.id } })
    res.json(c)
  } catch (err) {
    next(err)
  }
})

consumablesRouter.post('/:id/supersede', async (req, res, next) => {
  try {
    await transitionStatus(req.params.id, 'SUPERSEDED', req.user!.userId)
    const c = await prisma.consumable.findUnique({ where: { id: req.params.id } })
    res.json(c)
  } catch (err) {
    next(err)
  }
})

// ─── Consumable Form Submission ───────────────────────────────────────────────

const consumableFormSubmissionSchema = z.object({
  data: z.record(z.unknown()),
  attachmentIds: z.array(z.string().uuid()).optional(),
})

consumablesRouter.post('/:id/form-submission', validate(consumableFormSubmissionSchema), async (req, res, next) => {
  try {
    const id = req.params.id as string
    const { data, attachmentIds } = req.body as z.infer<typeof consumableFormSubmissionSchema>

    const consumable = await prisma.consumable.findUnique({ where: { id } })
    if (!consumable) throw new NotFoundError('Consumable', id)

    const updated = await prisma.consumable.update({
      where: { id },
      data: { formData: data as unknown as Prisma.InputJsonValue },
    })

    if (attachmentIds && attachmentIds.length > 0) {
      await prisma.document.updateMany({
        where: { id: { in: attachmentIds } },
        data: { instanceId: consumable.instanceId },
      })
    }

    await logEvent('ConsumableFormSubmitted', 'Consumable', id, req.user!.userId, {
      instanceId: consumable.instanceId,
      attachmentCount: attachmentIds?.length ?? 0,
    })

    res.json({ consumable: updated, formData: data, attachmentIds: attachmentIds ?? [] })
  } catch (err) {
    next(err)
  }
})
