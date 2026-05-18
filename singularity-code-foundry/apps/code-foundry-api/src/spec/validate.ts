/**
 * M42.1 — Spec validator.
 *
 * Combines Zod's structural validation with a small set of cross-field
 * invariants Zod can't express cleanly (path-param coverage, datasource
 * references, etc.). Returns a structured result that both the REST
 * route and the CLI consume — never throws.
 */
import { z } from 'zod'
import { canonicalize } from './canonicalize.js'
import { sha256 } from './hash.js'
import { serviceSpecSchema, type ServiceSpec } from './schema.js'

export interface SpecValidationError {
  code: string
  path: string
  message: string
}

export interface SpecValidationResult {
  valid: boolean
  errors: SpecValidationError[]
  warnings: SpecValidationError[]
  spec?: ServiceSpec
  specHash?: string
  canonicalJson?: string
}

export function validateSpec(input: unknown): SpecValidationResult {
  const parsed = serviceSpecSchema.safeParse(input)
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map(toValidationError),
      warnings: [],
    }
  }
  const spec = parsed.data
  const crossField = checkCrossFieldInvariants(spec)
  if (crossField.length > 0) {
    return { valid: false, errors: crossField, warnings: [] }
  }
  const canonicalJson = canonicalize(spec)
  return {
    valid: true,
    errors: [],
    warnings: warningsFor(spec),
    spec,
    canonicalJson,
    specHash: sha256(canonicalJson),
  }
}

function toValidationError(issue: z.ZodIssue): SpecValidationError {
  return {
    code: zodCode(issue),
    path: issue.path.join('.') || '<root>',
    message: issue.message,
  }
}

function zodCode(issue: z.ZodIssue): string {
  // Map a handful of common Zod issues to memorable, stable codes —
  // makes CI logs and UI grouping easier without depending on Zod's
  // internal enum, which has changed across versions.
  if (issue.code === 'invalid_type') return 'INVALID_TYPE'
  if (issue.code === 'invalid_enum_value') return 'INVALID_ENUM_VALUE'
  if (issue.code === 'unrecognized_keys') return 'UNKNOWN_FIELD'
  if (issue.code === 'invalid_string') return 'INVALID_STRING'
  if (issue.code === 'too_small') return 'TOO_SMALL'
  if (issue.code === 'too_big') return 'TOO_BIG'
  return issue.code.toUpperCase()
}

function checkCrossFieldInvariants(spec: ServiceSpec): SpecValidationError[] {
  const errors: SpecValidationError[] = []

  // Endpoint path params must appear in input.pathParams[] and vice
  // versa. Spec §8.3 example calls out exactly this case.
  for (let i = 0; i < spec.api.endpoints.length; i += 1) {
    const ep = spec.api.endpoints[i]
    const declared = new Set((ep.input?.pathParams ?? []).map(p => p.name))
    const inPath = [...ep.path.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(m => m[1])
    for (const name of inPath) {
      if (!declared.has(name)) {
        errors.push({
          code: 'PATH_PARAM_NOT_DECLARED',
          path: `api.endpoints[${i}].input.pathParams`,
          message: `Path '${ep.path}' contains {${name}} but input.pathParams.${name} is missing.`,
        })
      }
    }
    for (const declaredName of declared) {
      if (!inPath.includes(declaredName)) {
        errors.push({
          code: 'PATH_PARAM_UNUSED',
          path: `api.endpoints[${i}].input.pathParams.${declaredName}`,
          message: `Path param ${declaredName} is declared but not present in path '${ep.path}'.`,
        })
      }
    }
  }

  // Endpoint output.type and error.type must reference a declared model.
  const modelNames = new Set(spec.models?.map(m => m.name) ?? [])
  for (let i = 0; i < spec.api.endpoints.length; i += 1) {
    const ep = spec.api.endpoints[i]
    if (!modelNames.has(ep.output.type)) {
      errors.push({
        code: 'MODEL_REFERENCE_MISSING',
        path: `api.endpoints[${i}].output.type`,
        message: `Output type '${ep.output.type}' is not declared in models[].`,
      })
    }
    for (let e = 0; e < ep.errors.length; e += 1) {
      const err = ep.errors[e]
      if (!modelNames.has(err.type)) {
        errors.push({
          code: 'MODEL_REFERENCE_MISSING',
          path: `api.endpoints[${i}].errors[${e}].type`,
          message: `Error type '${err.type}' is not declared in models[].`,
        })
      }
    }
  }

  // Business-logic rule_reference inputs that reference a datasource
  // must name a declared datasource (e.g. customerProfileApi.beneficiaryStatus).
  if (spec.businessLogic?.type === 'rule_reference') {
    const dataSourceNames = new Set(spec.dataSources.map(d => d.name))
    for (let r = 0; r < spec.businessLogic.rules.length; r += 1) {
      const rule = spec.businessLogic.rules[r]
      for (let i = 0; i < (rule.inputs ?? []).length; i += 1) {
        const ref = rule.inputs[i]
        const dot = ref.indexOf('.')
        if (dot > 0) {
          const dsName = ref.slice(0, dot)
          if (!dataSourceNames.has(dsName)) {
            errors.push({
              code: 'DATASOURCE_REFERENCE_MISSING',
              path: `businessLogic.rules[${r}].inputs[${i}]`,
              message: `Rule input '${ref}' references datasource '${dsName}' which is not declared in dataSources[].`,
            })
          }
        }
      }
    }
  }

  return errors
}

function warningsFor(spec: ServiceSpec): SpecValidationError[] {
  const warnings: SpecValidationError[] = []
  if (!spec.security) {
    warnings.push({
      code: 'SECURITY_PROFILE_MISSING',
      path: 'security',
      message: 'No security profile declared; generation will fall back to oauth2-resource-server default.',
    })
  }
  if (!spec.observability) {
    warnings.push({
      code: 'OBSERVABILITY_PROFILE_MISSING',
      path: 'observability',
      message: 'No observability profile declared; metrics/tracing/logging will use stack-default wiring.',
    })
  }
  return warnings
}
