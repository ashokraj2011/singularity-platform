import type { ServiceSpec } from '../spec/schema.js'

export type PolicySeverity = 'error' | 'warning'

export interface PolicyViolation {
  policyId: string
  severity: PolicySeverity
  path: string
  message: string
}

export interface Policy {
  id: string
  description: string
  defaultSeverity: PolicySeverity
  run: (spec: ServiceSpec) => PolicyViolation[]
}
