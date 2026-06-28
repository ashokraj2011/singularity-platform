import type { WorkflowInstance, WorkflowNode } from '@prisma/client'
import { prisma } from '../../../../../lib/prisma'
import { postJson } from '../../../../../lib/audit-gov/client'
import { analyzeWorkflowInstance, shouldBlockFormalResult } from '../../../formal-verification'
import type { GovernanceOverlay } from './evaluateBlock'

/**
 * v2 control → evidence resolution for GOVERNANCE_GATE. A control is "satisfied"
 * when its bound evidence is present/passing. Bindings come from node config
 * (v2); v3 moves them into the IAM overlay so the governing body owns both which
 * controls apply AND how they are evidenced.
 *
 * The pure orchestration (`resolveSatisfiedControls`) is unit-tested; the I/O
 * (`makeEvidenceChecker`) reuses the existing receipt / evaluator / formal /
 * artifact engines and is runtime-verified on a live stack.
 */

export interface ControlBinding {
  type: 'context' | 'receipt' | 'evaluator' | 'artifact' | 'formal'
  evaluatorIds?: string[]
  minPassRate?: number
  artifactName?: string
  evidenceKey?: string
}
export type BindingMap = Record<string, ControlBinding>
export type BindingChecker = (controlKey: string, binding: ControlBinding) => Promise<boolean>

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v))
}

/** Every controlKey the overlay actually evaluates (requiredEvidence + blockingControls). */
export function controlsReferenced(overlay: GovernanceOverlay | null | undefined): string[] {
  if (!overlay) return []
  const keys = new Set<string>()
  for (const ev of overlay.requiredEvidence ?? []) if (typeof ev?.evidenceKey === 'string') keys.add(ev.evidenceKey)
  for (const c of overlay.blockingControls ?? []) if (typeof c?.controlKey === 'string') keys.add(c.controlKey)
  return [...keys]
}

/**
 * Pure orchestration: for each referenced control NOT already in `base`, look up
 * its binding and run `check`. A throwing/false check leaves the control
 * unsatisfied (the gate's missing-evidence policy then applies). Injectable
 * `check` keeps the decision logic separable from I/O.
 */
export async function resolveSatisfiedControls(
  overlay: GovernanceOverlay | null | undefined,
  bindings: BindingMap,
  base: ReadonlySet<string>,
  check: BindingChecker,
): Promise<Set<string>> {
  const satisfied = new Set(base)
  for (const key of controlsReferenced(overlay)) {
    if (satisfied.has(key)) continue
    const binding = bindings[key]
    if (!binding) continue
    try {
      if (await check(key, binding)) satisfied.add(key)
    } catch {
      // evidence-source error ≠ satisfied
    }
  }
  return satisfied
}

async function traceIdsForInstance(instanceId: string): Promise<string[]> {
  const runs = await prisma.agentRun
    .findMany({
      where: { instanceId },
      select: {
        outputs: {
          where: { outputType: { in: ['EXECUTION_TRACE', 'LLM_RESPONSE', 'APPROVAL_REQUIRED'] } },
          select: { rawContent: true, structuredPayload: true },
        },
      },
    })
    .catch(() => [] as Array<{ outputs: Array<{ rawContent: string | null; structuredPayload: unknown }> }>)
  const ids = new Set<string>()
  for (const run of runs)
    for (const o of run.outputs) {
      const p = isRecord(o.structuredPayload) ? o.structuredPayload : {}
      const t =
        typeof p.traceId === 'string' ? p.traceId
        : typeof p.trace_id === 'string' ? p.trace_id
        : o.rawContent?.startsWith('wf-') ? o.rawContent
        : undefined
      if (t) ids.add(t)
    }
  return [...ids]
}

/** Real evidence checker (I/O) — reuses existing engines; runtime-verified on a stack. */
export function makeEvidenceChecker(instance: WorkflowInstance, node: WorkflowNode, actorId?: string): BindingChecker {
  return async (controlKey, binding) => {
    switch (binding.type) {
      case 'artifact': {
        const name = binding.artifactName ?? controlKey
        const found = await prisma.consumable
          .findFirst({
            where: { instanceId: instance.id, name: { contains: name, mode: 'insensitive' }, status: { in: ['APPROVED', 'PUBLISHED'] } },
            select: { id: true },
          })
          .catch(() => null)
        return Boolean(found)
      }
      case 'evaluator': {
        const traceIds = await traceIdsForInstance(instance.id)
        if (traceIds.length === 0) return false
        const minPassRate = typeof binding.minPassRate === 'number' ? binding.minPassRate : 1
        let pass = 0
        let total = 0
        for (const traceId of traceIds) {
          const run = await postJson<{ passed_count: number; failed_count: number }>('api/v1/engine/evaluators/run-trace', {
            traceId,
            evaluatorIds: binding.evaluatorIds ?? [],
            metadata: { workflowInstanceId: instance.id, workflowNodeId: node.id, controlKey },
          })
          if (run) {
            pass += Number(run.passed_count ?? 0)
            total += Number(run.passed_count ?? 0) + Number(run.failed_count ?? 0)
          }
        }
        return total > 0 && pass / total >= minPassRate
      }
      case 'receipt': {
        const wantKey = binding.evidenceKey ?? controlKey
        const runs = await prisma.agentRun
          .findMany({ where: { instanceId: instance.id }, select: { outputs: { select: { structuredPayload: true } } } })
          .catch(() => [] as Array<{ outputs: Array<{ structuredPayload: unknown }> }>)
        for (const run of runs)
          for (const o of run.outputs) {
            const p = isRecord(o.structuredPayload) ? o.structuredPayload : {}
            const k = p.evidence_key ?? p.evidenceKey
            const status = String(p.status ?? '').toLowerCase()
            const ok = p.tool_success === true || ['passed', 'pass', 'ok', 'satisfied'].includes(status)
            if (k === wantKey && ok) return true
          }
        return false
      }
      case 'formal': {
        const out = await analyzeWorkflowInstance(instance.id, actorId, node.id).catch(() => null)
        if (!out) return false
        const rec = out as Record<string, unknown>
        const res = isRecord(rec.result) ? (rec.result as Record<string, unknown>) : rec
        return !shouldBlockFormalResult(res, {})
      }
      case 'context':
      default:
        return false // context-stamped keys are handled by the base set
    }
  }
}
