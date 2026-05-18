/**
 * M42.1 — Per-endpoint business-logic coverage tag.
 *
 * Spec §9.2 defines three tags:
 *   FULL     — rule DSL fully covers the endpoint; generator emits a
 *              deterministic body, no llm-editable region.
 *   PARTIAL  — rule DSL covers some of it; generator emits
 *              deterministic scaffolding + a scoped llm-editable region.
 *   NONE     — no rule DSL for the endpoint; placeholder body + LLM
 *              region for the whole method.
 *
 * For M42.1 there are no generators yet, but the tag IS recorded on the
 * IR so the receipt and the M42.2 generator dispatcher can rely on it.
 */
import type { ServiceSpec } from '../spec/schema.js'
import type { BusinessLogicCoverage } from './types.js'

export function coverageFor(spec: ServiceSpec, operationId: string): BusinessLogicCoverage {
  if (!spec.businessLogic) return 'NONE'
  if (spec.businessLogic.type === 'llm_only') return 'NONE'
  if (spec.businessLogic.type === 'external_rule_engine') return 'FULL'
  // rule_reference — a rule whose id == operationId OR whose
  // description names the operation is treated as full coverage. A
  // looser heuristic than the spec example but sufficient for M42.1.
  const matched = spec.businessLogic.rules.find(r =>
    r.id === operationId ||
    r.id.toLowerCase().includes(operationId.toLowerCase()) ||
    operationId.toLowerCase().includes(r.id.toLowerCase()),
  )
  if (!matched) return 'NONE'
  // A rule with both then and else branches is FULL; a then-only rule
  // is PARTIAL (operator still needs to define the negative path).
  return matched.logic.else ? 'FULL' : 'PARTIAL'
}
