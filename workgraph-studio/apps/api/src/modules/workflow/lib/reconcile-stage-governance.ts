/**
 * G8 — per-stage governance reconciler.
 *
 * Materializes the per-stage governance INTENT stored on WorkbenchStage
 * (governancePolicyId / governanceEnforcement / governancePriority /
 * governanceContributions) into scope=STAGE IAM governance attachments
 * (target_kind=STAGE_KEY, target_key=stageKey) on the run's capability, so the
 * existing resolver binds them per stage at run time.
 *
 * Contract (mirrors the G8 plan):
 *   - Runs ONLY on an explicit definition save (the service mutators call it
 *     AFTER writeThroughToLegacy / after the prisma writes commit) — never
 *     inside getDefinition, never inside a $transaction, never per-run.
 *   - NEVER throws — collects errors into the returned summary. A reconcile
 *     failure must not break the save.
 *   - Serialized per capability (in-process advisory lock); cross-process races
 *     are caught by the IAM partial unique index (POST → 409 → next save
 *     converges via PATCH).
 *   - Dark-launch: gated by GOVERNANCE_STAGE_RECONCILE_ENABLED (default OFF).
 *     Enabling requires the workgraph→IAM service token to carry the
 *     `governance:author` scope (and `governance:enforce` for REQUIRED/BLOCKING)
 *     — see IAM app/governance/authz.py.
 *   - capability_id normalized to the IAM business key (the resolver filters on
 *     it verbatim — using the wrong identifier would silently fail-open).
 *   - Create/PATCH desired BEFORE deactivating stale, so a renamed stage is
 *     never momentarily ungoverned.
 */
import { type PrismaClient } from '@prisma/client'
import {
  listGovernedByAttachments, attachGovernedBy, patchGovernanceAttachment,
  deactivateGovernanceAttachment, getCapability,
} from '../../../lib/iam/client'

const STAGE_SCOPE = 'STAGE'
const STAGE_TARGET_KIND = 'STAGE_KEY'

export interface ReconcileSummary {
  ran: boolean
  reason?: string
  attached: number
  patched: number
  deactivated: number
  errors: string[]
}

// In-process per-capability serialization (chained promises).
const chains = new Map<string, Promise<unknown>>()
function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  chains.set(key, run.catch(() => {}))
  return run
}

export async function reconcileStageGovernance(
  prisma: PrismaClient, nodeId: string,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { ran: false, attached: 0, patched: 0, deactivated: 0, errors: [] }
  if (process.env.GOVERNANCE_STAGE_RECONCILE_ENABLED !== 'true') {
    summary.reason = 'GOVERNANCE_STAGE_RECONCILE_ENABLED is off (dark-launch)'
    return summary
  }
  try {
    const def = await prisma.workbenchDefinition.findUnique({
      where: { workflowNodeId: nodeId },
      include: { stages: true },
    })
    if (!def) { summary.reason = 'no workbench definition'; return summary }
    if (!def.capabilityId) { summary.reason = 'definition has no capabilityId — nothing to materialize'; return summary }

    const cap = await getCapability(def.capabilityId).catch(() => null)
    const capabilityId = cap?.id ?? def.capabilityId

    return await runExclusive(capabilityId, async () => {
      summary.ran = true
      const desired = def.stages
        .filter(s => s.governancePolicyId)
        .map(s => ({
          stageKey: s.stageKey,
          governing: s.governancePolicyId as string,
          mode: (s.governanceEnforcement || 'ADVISORY').toUpperCase(),
          priority: s.governancePriority ?? 100,
          contributions: (s.governanceContributions ?? {}) as Record<string, unknown>,
        }))
      const desiredKeys = new Set(desired.map(d => `${d.governing}::${d.stageKey}`))

      const existing = (await listGovernedByAttachments(capabilityId, true))
        .filter(a => a.scope === STAGE_SCOPE)
      const activeByKey = new Map<string, (typeof existing)[number]>()
      for (const a of existing) {
        if (a.is_active && a.target_key) activeByKey.set(`${a.governing_capability_id}::${a.target_key}`, a)
      }

      // 1) Create / PATCH desired.
      for (const d of desired) {
        const cur = activeByKey.get(`${d.governing}::${d.stageKey}`)
        try {
          if (!cur) {
            await attachGovernedBy(capabilityId, {
              governing_capability_id: d.governing, mode: d.mode, scope: STAGE_SCOPE,
              target_kind: STAGE_TARGET_KIND, target_key: d.stageKey, priority: d.priority,
              contributions: d.contributions,
            })
            summary.attached++
          } else if (cur.mode !== d.mode || cur.priority !== d.priority) {
            await patchGovernanceAttachment(capabilityId, cur.id, { mode: d.mode, priority: d.priority })
            summary.patched++
          }
        } catch (e) { summary.errors.push(`stage ${d.stageKey}: ${(e as Error).message}`) }
      }

      // 2) Deactivate active STAGE attachments no longer desired (stage cleared/renamed/removed).
      for (const a of existing) {
        if (!a.is_active || !a.target_key) continue
        if (!desiredKeys.has(`${a.governing_capability_id}::${a.target_key}`)) {
          try { await deactivateGovernanceAttachment(capabilityId, a.id); summary.deactivated++ }
          catch (e) { summary.errors.push(`deactivate ${a.target_key}: ${(e as Error).message}`) }
        }
      }

      if (summary.errors.length) {
        // eslint-disable-next-line no-console
        console.warn(`[stage-governance] node=${nodeId} cap=${capabilityId} reconcile errors:`, summary.errors)
      }
      return summary
    })
  } catch (e) {
    summary.errors.push((e as Error).message)
    // eslint-disable-next-line no-console
    console.warn(`[stage-governance] node=${nodeId} reconcile failed:`, (e as Error).message)
    return summary
  }
}
