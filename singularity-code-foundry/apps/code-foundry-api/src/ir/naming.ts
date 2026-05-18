/**
 * M42.1 — Per-stack naming derivation for IR.
 *
 * Pure functions of (application + endpoint) — same inputs always
 * produce the same names, which is what makes irHash stable across
 * runs.
 */
import type { ServiceSpec } from '../spec/schema.js'

const HTTP_TO_ANNOTATION = {
  GET:    'GetMapping',
  POST:   'PostMapping',
  PUT:    'PutMapping',
  PATCH:  'PatchMapping',
  DELETE: 'DeleteMapping',
} as const

export function httpAnnotation(method: ServiceSpec['api']['endpoints'][number]['method']):
  (typeof HTTP_TO_ANNOTATION)[keyof typeof HTTP_TO_ANNOTATION] {
  return HTTP_TO_ANNOTATION[method]
}

export function controllerNameFor(spec: ServiceSpec): string {
  // 'EligibilityService' → 'EligibilityController'
  const base = spec.application.name.replace(/Service$/, '')
  return `${base}Controller`
}

export function serviceImplBase(spec: ServiceSpec): string {
  // 'EligibilityService' → 'EligibilityApplicationService' (interface)
  const base = spec.application.name.replace(/Service$/, '')
  return `${base}ApplicationService`
}

export function clientClassFor(dsName: string): string {
  // 'customerProfileApi' → 'CustomerProfileClient'
  const camel = dsName
    .replace(/Api$/, '')
    .replace(/Client$/, '')
    .replace(/^([a-z])/, (m) => m.toUpperCase())
  return `${camel}Client`
}
