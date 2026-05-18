import type { ServiceSpec } from '../spec/schema.js'
import type { Policy, PolicyViolation } from './types.js'
import { builtInPolicies } from './builtIn.js'

const registry: Policy[] = [...builtInPolicies]

export function registerPolicy(policy: Policy): void {
  registry.push(policy)
}

export function listPolicies(): Policy[] {
  return [...registry]
}

export interface PolicyRunResult {
  passed: boolean
  errors: PolicyViolation[]
  warnings: PolicyViolation[]
}

export function runPolicies(spec: ServiceSpec): PolicyRunResult {
  const all: PolicyViolation[] = []
  for (const p of registry) all.push(...p.run(spec))
  const errors = all.filter(v => v.severity === 'error')
  const warnings = all.filter(v => v.severity === 'warning')
  return { passed: errors.length === 0, errors, warnings }
}
