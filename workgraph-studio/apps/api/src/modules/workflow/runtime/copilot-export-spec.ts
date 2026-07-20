/**
 * The design specification carried inside the exported Copilot workflow YAML.
 *
 * A developer exports a run, leaves the platform, implements off-platform, and pushes.
 * When they come back, `validateSubmissionManifest` measures what they built against the
 * spec it was supposed to satisfy. That check keys off exactly two things:
 *
 *   • `specificationHash` — must equal the hash of the bound spec, else the submission is
 *     REJECTED as targeting a different spec (submission.validator `spec-hash-matches`).
 *   • `claims[].requirementId` — every claim must name an IN-SCOPE requirement id, else it
 *     is REJECTED as dangling (submission.validator `claims-reference-in-scope`).
 *
 * Neither is discoverable from a YAML that carries only a work-item code. So the export
 * embeds them: the version id + content hash (the join key) and the in-scope requirements
 * with their acceptance criteria and test obligations.
 *
 * EMBEDDED, not referenced — the same call the world-model grounding made, for the same
 * reason: the handoff targets a laptop that may have neither platform connectivity nor a
 * token, so a fetch-on-run reference cannot be relied on.
 *
 * READ-ONLY over the spec: this module never writes a spec, never re-hashes one, and does
 * not extend the package schema (a schema change would move `specificationContentHash` and
 * invalidate every hash already handed out).
 *
 * DEGRADE, NEVER FAIL: a run whose work item has no spec bound must still export a working
 * YAML. Every resolution failure returns `null` plus a warning rather than throwing — an
 * export that 500s because a spec is missing is worse than one without a spec.
 */
import { prisma } from '../../../lib/prisma'
import { withTenantDbTransaction } from '../../../lib/tenant-db-context'
import { specificationPackageBodySchema } from '../../specifications/specification.schemas'

export type CopilotExportRequirement = {
  id: string
  type: string
  priority: string
  risk: string
  statement: string
  rationale?: string
  acceptanceCriterionIds: string[]
  testObligationIds: string[]
}

export type CopilotExportAcceptanceCriterion = {
  id: string
  requirementIds: string[]
  given: string[]
  when: string[]
  then: string[]
}

export type CopilotExportTestObligation = {
  id: string
  verifies: string[]
  kind: string
  description: string
  requiredEvidence: string[]
  minimumCases: string[]
}

export type CopilotExportSpecification = {
  /** Join key part 1 — the SpecificationVersion this handoff was cut from. */
  versionId: string
  version: number | null
  status: string
  /**
   * Join key part 2 — the hash a returning submission must echo back. This is the
   * binding's `resolvedContentHash` when a binding exists (a binding may resolve a
   * package that differs from the raw version's), else the version's own hash.
   */
  contentHash: string | null
  /** Which record supplied the in-scope requirement ids, so the YAML can say so. */
  scopeSource: 'handoffGeneration' | 'developmentScope' | 'developmentTarget' | 'specificationBinding' | 'none'
  /**
   * false ⇒ no record declared a requirement subset, so every requirement in the package
   * is in scope (`reconciliation.engine`: "an explicit handoff scope wins; otherwise every
   * requirement is in scope").
   */
  scopeDeclared: boolean
  requirements: CopilotExportRequirement[]
  acceptanceCriteria: CopilotExportAcceptanceCriterion[]
  testObligations: CopilotExportTestObligation[]
  reconciliationPolicy: Record<string, unknown>
  /** Where the effective reconciliation policy came from — handoff policy overrides the package's. */
  reconciliationPolicySource: 'handoff' | 'specification'
  warnings: string[]
}

/**
 * The handoff records a returning submission must be registered against. Resolved alongside the
 * specification because it is the SAME lookup — binding → scope → published generation, or the
 * legacy DevelopmentTarget — and resolving it twice invites the two answers to drift.
 *
 * Never embedded in the exported YAML: these are internal record ids, not part of the contract
 * handed to a developer's laptop.
 */
export type CopilotExportHandoffRef = {
  workItemId: string
  /** Scoped path: both ids present. Legacy path: both null, and `target` carries the handoff. */
  developmentScopeId: string | null
  handoffGenerationId: string | null
  /** Repository the submission will be measured against. */
  repository: string
  /** Commit the handoff was cut from. */
  baseCommitSha: string
  /** Legacy DevelopmentTarget path only — submissions require it to be PUBLISHED. */
  targetPublished: boolean
  /** Which path registerSubmission must take. */
  path: 'scoped' | 'legacy'
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * Narrow a full specification package down to the in-scope slice worth embedding. PURE —
 * package + scope in, block out — so the emitted contract is unit-testable without Postgres.
 *
 * Requirement ids are emitted EXACTLY as the package stores them: they are the contract a
 * returning submission claims against, and a normalised id would not match.
 */
export function narrowSpecificationForExport(input: {
  versionId: string
  version: number | null
  status: string
  contentHash: string | null
  packageBody: unknown
  scopeRequirementIds: string[]
  scopeSource: CopilotExportSpecification['scopeSource']
  handoffReconciliationPolicy?: unknown
  warnings?: string[]
}): { specification: CopilotExportSpecification | null; warnings: string[] } {
  const warnings = [...(input.warnings ?? [])]
  const parsed = specificationPackageBodySchema.safeParse(input.packageBody)
  if (!parsed.success) {
    warnings.push('The bound specification package is malformed and could not be read; the export carries no specification block.')
    return { specification: null, warnings }
  }
  const body = parsed.data

  // An explicit handoff scope wins; an empty scope means every requirement is in scope.
  // This mirrors reconciliation.engine exactly, so what the developer is told to build is
  // what they will later be measured on.
  const declaredIds = input.scopeRequirementIds.filter(id => typeof id === 'string' && id.trim())
  const scopeDeclared = declaredIds.length > 0
  const known = new Set(body.requirements.map(r => r.id))
  const unknownScoped = declaredIds.filter(id => !known.has(id))
  if (unknownScoped.length) {
    warnings.push(`The handoff scopes requirement id(s) that are not in the bound specification: ${[...new Set(unknownScoped)].join(', ')}.`)
  }
  const inScopeIds = scopeDeclared ? new Set(declaredIds) : known
  if (!scopeDeclared) {
    warnings.push('No requirement subset was declared for this handoff, so every requirement in the specification is in scope.')
  }

  const requirements: CopilotExportRequirement[] = body.requirements
    .filter(r => inScopeIds.has(r.id))
    .map(r => ({
      id: r.id,
      type: r.type,
      priority: r.priority,
      risk: r.risk,
      statement: r.statement,
      ...(r.rationale ? { rationale: r.rationale } : {}),
      acceptanceCriterionIds: r.acceptanceCriterionIds,
      testObligationIds: r.testObligationIds,
    }))

  if (!requirements.length) {
    warnings.push('The bound specification has no requirements in scope for this handoff.')
  }

  // Link both ways: a requirement points at its criteria/obligations, and criteria/obligations
  // point back. Either direction puts the record in scope, so a spec that only wired one
  // direction still exports a complete, self-consistent slice.
  const wantedCriteria = new Set<string>(requirements.flatMap(r => r.acceptanceCriterionIds))
  const acceptanceCriteria: CopilotExportAcceptanceCriterion[] = body.acceptanceCriteria
    .filter(c => wantedCriteria.has(c.id) || c.requirementIds.some(id => inScopeIds.has(id)))
    .map(c => ({
      id: c.id,
      requirementIds: c.requirementIds.filter(id => inScopeIds.has(id)),
      given: c.given,
      when: c.when,
      then: c.then,
    }))

  const wantedObligations = new Set<string>(requirements.flatMap(r => r.testObligationIds))
  const testObligations: CopilotExportTestObligation[] = body.testObligations
    .filter(t => wantedObligations.has(t.id) || t.verifies.some(id => inScopeIds.has(id)))
    .map(t => ({
      id: t.id,
      verifies: t.verifies.filter(id => inScopeIds.has(id)),
      kind: t.kind,
      description: t.description,
      requiredEvidence: t.requiredEvidence,
      minimumCases: t.minimumCases,
    }))

  // Reconciliation is evaluated against the HANDOFF's policy when it has one
  // (reconciliations.service picks handoff/target policy, not the package's), so the export
  // shows the policy the work will actually be judged by.
  const handoffPolicy = isPlainObject(input.handoffReconciliationPolicy) ? input.handoffReconciliationPolicy : null
  const useHandoffPolicy = Boolean(handoffPolicy && Object.keys(handoffPolicy).length)
  const reconciliationPolicy = (useHandoffPolicy ? handoffPolicy! : (body.reconciliationPolicy as unknown as Record<string, unknown>)) ?? {}

  if (!input.contentHash) {
    warnings.push('The bound specification has no content hash, so a returning submission cannot prove which specification it was built against.')
  }

  return {
    specification: {
      versionId: input.versionId,
      version: input.version,
      status: input.status,
      contentHash: input.contentHash,
      scopeSource: input.scopeSource,
      scopeDeclared,
      requirements,
      acceptanceCriteria,
      testObligations,
      reconciliationPolicy,
      reconciliationPolicySource: useHandoffPolicy ? 'handoff' : 'specification',
      warnings,
    },
    warnings,
  }
}

/**
 * Resolve the specification bound to the run's work item.
 *
 * Precedence follows `reconciliations.service` / `submissions.service` — the two places that
 * will later measure the submission — so the export names the same spec, hash and scope the
 * platform will judge against:
 *
 *   package + hash : the CURRENT WorkItemSpecificationBinding's resolved package/hash if one
 *                    exists (highest bindingGeneration), else the legacy DevelopmentTarget's
 *                    SpecificationVersion.
 *   in-scope ids   : the PUBLISHED HandoffGeneration → its DevelopmentScope → the legacy
 *                    DevelopmentTarget → the binding, first one that declares a subset.
 *
 * Returns `{ specification: null, warnings }` for every miss. Never throws.
 */
export async function loadCopilotExportSpecification(
  workCode: string,
  opts: { repository?: string; tenantId?: string } = {},
): Promise<{ specification: CopilotExportSpecification | null; warnings: string[]; handoffRef: CopilotExportHandoffRef | null }> {
  const warnings: string[] = []
  if (!workCode) {
    return { specification: null, handoffRef: null, warnings: ['This run is not linked to a Work Item, so no design specification could be attached.'] }
  }

  type Resolved =
    | { ok: false; miss: string }
    | {
        ok: true
        workItemId: string
        binding: { specificationVersionId: string; resolvedContentHash: string | null; resolvedPackage: unknown; requirementIds: unknown } | null
        target: { specificationVersionId: string; requirementIds: unknown; reconciliationPolicy: unknown; status: string; repository: string; baseCommitSha: string } | null
        scope: { id: string; requirementIds: unknown } | null
        handoff: { id: string; requirementIds: unknown; reconciliationPolicy: unknown; repository: string; baseCommitSha: string } | null
        spec: { id: string; version: number | null; status: string; contentHash: string | null; package: unknown }
      }

  try {
    const resolved: Resolved = await withTenantDbTransaction(prisma, async (tx): Promise<Resolved> => {
      const workItem = await tx.workItem.findUnique({ where: { workCode }, select: { id: true } })
      if (!workItem) return { ok: false, miss: `Work Item ${workCode} was not found, so no design specification could be attached.` }

      const [binding, target] = await Promise.all([
        tx.workItemSpecificationBinding.findFirst({
          where: { workItemId: workItem.id, status: 'CURRENT' },
          orderBy: { bindingGeneration: 'desc' },
        }),
        tx.developmentTarget.findUnique({ where: { workItemId: workItem.id } }),
      ])
      if (!binding && !target) {
        return { ok: false, miss: `Work Item ${workCode} has no specification bound, so the export carries no specification block. Bind an approved specification to the Work Item to include it.` }
      }

      // Prefer a scope for this run's repository (reconciliations.service matches on
      // repository too); fall back to the most recently updated live scope.
      const scope = await tx.developmentScope.findFirst({
        where: {
          workItemId: workItem.id,
          status: { not: 'CANCELLED' },
          ...(opts.repository ? { repository: opts.repository } : {}),
        },
        orderBy: { updatedAt: 'desc' },
      }) ?? (opts.repository
        ? await tx.developmentScope.findFirst({
            where: { workItemId: workItem.id, status: { not: 'CANCELLED' } },
            orderBy: { updatedAt: 'desc' },
          })
        : null)

      const handoff = scope?.currentHandoffGenerationId
        ? await tx.handoffGeneration.findFirst({ where: { id: scope.currentHandoffGenerationId, status: 'PUBLISHED' } })
        : null

      const specificationVersionId = binding?.specificationVersionId ?? target?.specificationVersionId ?? null
      if (!specificationVersionId) {
        return { ok: false, miss: `Work Item ${workCode} has no specification bound, so the export carries no specification block.` }
      }
      const spec = await tx.specificationVersion.findUnique({
        where: { id: specificationVersionId },
        select: { id: true, version: true, status: true, contentHash: true, package: true },
      })
      if (!spec) {
        return { ok: false, miss: `The specification bound to ${workCode} could not be loaded, so the export carries no specification block.` }
      }
      return { ok: true, workItemId: workItem.id, binding, target, scope, handoff, spec }
    }, opts.tenantId)

    if (!resolved.ok) return { specification: null, handoffRef: null, warnings: [resolved.miss] }
    const { workItemId, binding, target, scope, handoff, spec } = resolved

    // Which record a submission would be registered against. The scoped path needs BOTH a live
    // scope and its PUBLISHED generation (submissions.service rejects a partial set); otherwise
    // the legacy DevelopmentTarget carries the handoff.
    const handoffRef: CopilotExportHandoffRef | null = scope && handoff
      ? {
          workItemId,
          developmentScopeId: scope.id,
          handoffGenerationId: handoff.id,
          repository: handoff.repository,
          baseCommitSha: handoff.baseCommitSha,
          targetPublished: true,
          path: 'scoped',
        }
      : target
        ? {
            workItemId,
            developmentScopeId: null,
            handoffGenerationId: null,
            repository: target.repository,
            baseCommitSha: target.baseCommitSha,
            targetPublished: String(target.status) === 'PUBLISHED',
            path: 'legacy',
          }
        : null

    // First record that declares a subset wins; an undeclared scope means "everything".
    const candidates: Array<[CopilotExportSpecification['scopeSource'], string[]]> = [
      ['handoffGeneration', asStringArray(handoff?.requirementIds)],
      ['developmentScope', asStringArray(scope?.requirementIds)],
      ['developmentTarget', asStringArray(target?.requirementIds)],
      ['specificationBinding', asStringArray(binding?.requirementIds)],
    ]
    const declared = candidates.find(([, ids]) => ids.length > 0)
    const scopeSource: CopilotExportSpecification['scopeSource'] = declared?.[0] ?? 'none'
    const scopeRequirementIds = declared?.[1] ?? []

    if (target && !handoff && String(target.status) !== 'PUBLISHED') {
      warnings.push('The developer handoff for this Work Item is not published yet; the specification below may still change before a submission can be registered against it.')
    }

    const narrowed = narrowSpecificationForExport({
      versionId: spec.id,
      version: spec.version ?? null,
      status: String(spec.status),
      // submissions.service compares against `binding.resolvedContentHash || spec.contentHash`.
      contentHash: binding?.resolvedContentHash || spec.contentHash || null,
      packageBody: binding?.resolvedPackage ?? spec.package,
      scopeRequirementIds,
      scopeSource,
      handoffReconciliationPolicy: handoff?.reconciliationPolicy ?? target?.reconciliationPolicy,
      warnings,
    })
    // When the block is emitted its warnings ride inside it; surface them to the caller only
    // when there is no block to carry them.
    return { specification: narrowed.specification, handoffRef, warnings: narrowed.specification ? [] : narrowed.warnings }
  } catch (err) {
    // A spec lookup must never take the export down with it.
    return {
      specification: null,
      handoffRef: null,
      warnings: [`The design specification could not be loaded (${err instanceof Error ? err.message : 'unknown error'}); the export carries no specification block.`],
    }
  }
}
