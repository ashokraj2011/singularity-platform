/**
 * M42.1 — Default Code Foundry policies.
 *
 * These are intentionally narrow; the spec §8.4 + §9.5 baseline policies
 * are the safety floor every spec must clear. Operators can register
 * additional policies later via the registry. Each policy returns a
 * (possibly empty) list of violations.
 *
 * Severity = 'error' blocks the spec from advancing past POLICY_APPROVED
 * (the lifecycle gate). Severity = 'warning' surfaces in the validation
 * response but does not block.
 */
import type { Policy, PolicyViolation } from './types.js'

const serviceNameMustEndWithService: Policy = {
  id: 'service_name_must_end_with_service',
  description: 'Service application name must end with "Service".',
  defaultSeverity: 'error',
  run(spec) {
    if (spec.application.name.endsWith('Service')) return []
    return [{
      policyId: this.id,
      severity: this.defaultSeverity,
      path: 'application.name',
      message: `application.name '${spec.application.name}' must end with 'Service'.`,
    }]
  },
}

const eligibilityApiRequiresAudit: Policy = {
  id: 'eligibility_api_requires_audit',
  description: 'Endpoints whose operationId contains "eligibility" must enable audit.',
  defaultSeverity: 'error',
  run(spec) {
    const out: PolicyViolation[] = []
    const hasEligibility = spec.api.endpoints.some(e =>
      e.operationId.toLowerCase().includes('eligibility'),
    )
    if (hasEligibility && spec.audit?.enabled !== true) {
      out.push({
        policyId: this.id,
        severity: this.defaultSeverity,
        path: 'audit.enabled',
        message: 'Eligibility endpoints must enable audit (audit.enabled: true).',
      })
    }
    return out
  },
}

const externalApiRequiresTimeout: Policy = {
  id: 'external_api_requires_timeout',
  description: 'REST data sources must declare a non-zero timeoutMs.',
  defaultSeverity: 'error',
  run(spec) {
    return spec.dataSources
      .filter(ds => ds.type === 'rest' && (ds.timeoutMs === undefined || ds.timeoutMs <= 0))
      .map(ds => ({
        policyId: this.id,
        severity: this.defaultSeverity,
        path: `dataSources[${spec.dataSources.indexOf(ds)}].timeoutMs`,
        message: `Datasource '${ds.name}' is type=rest but has no timeoutMs (or zero). Required for resilience.`,
      }))
  },
}

const externalDatasourceRequiresResilience: Policy = {
  id: 'external_datasource_requires_resilience',
  description: 'Per §9.5 — every REST datasource must declare a resilience profile.',
  defaultSeverity: 'error',
  run(spec) {
    return spec.dataSources
      .filter(ds => ds.type === 'rest' && !ds.resilience)
      .map(ds => ({
        policyId: this.id,
        severity: this.defaultSeverity,
        path: `dataSources[${spec.dataSources.indexOf(ds)}].resilience`,
        message: `Datasource '${ds.name}' is type=rest but has no resilience block. Add retry / circuit-breaker / bulkhead / fallback.`,
      }))
  },
}

export const builtInPolicies: Policy[] = [
  serviceNameMustEndWithService,
  eligibilityApiRequiresAudit,
  externalApiRequiresTimeout,
  externalDatasourceRequiresResilience,
]
