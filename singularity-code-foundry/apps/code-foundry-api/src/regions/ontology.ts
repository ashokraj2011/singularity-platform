/**
 * M42.2 — Typed region ontology. The data structure Patent Chain A claims on.
 *
 * Generated source files carry two kinds of typed region markers:
 *
 *   <generated:protected region="<region-id>">    ← Foundry-owned region.
 *      ...                                          Patches must NOT touch.
 *   </generated:protected>
 *
 *   <llm-editable region="<region-id>">           ← Foundry-owned scaffold,
 *      ...                                          but LLM patches MAY edit
 *   </llm-editable>                                 inside this fence subject
 *                                                   to allowedChanges.
 *
 * Each region's ID maps to a RegionType in the ontology below. The
 * ontology declares allowed/forbidden change classes per region type;
 * the Patch Guard in M42.4 enforces this mechanically — a diff that
 * crosses a region boundary or introduces a forbidden change class is
 * rejected before it touches disk.
 *
 * Regions are declared per language using language-appropriate comment
 * syntax — // for Java/TypeScript, # for Python, <!-- --> for YAML.
 */

export type ChangeClass =
  | 'method_body_only'
  | 'add_field_to_dto'
  | 'add_test_case'
  | 'add_import_within_package'
  | 'modify_string_literal'

export interface RegionTypeSpec {
  /** Stable identifier — appears in the source file header comment. */
  type: string
  /** Human-readable explanation surfaced in the Patch Guard reject message. */
  description: string
  /** Whether an LLM is allowed to edit any byte inside this region. */
  editable: boolean
  /** When editable, the exhaustive list of change classes that are allowed. */
  allowedChanges: ChangeClass[]
  /** Always-forbidden change classes, even if elsewhere allowed. */
  forbiddenChanges: ChangeClass[]
}

export const REGION_TYPES: Record<string, RegionTypeSpec> = {
  // ─── Protected (no LLM edits ever) ──────────────────────────────────────
  'api-contract': {
    type: 'api-contract',
    description: 'Controller / router decorator + signature. Changing this is a public-contract change.',
    editable: false,
    allowedChanges: [],
    forbiddenChanges: [],
  },
  'security-config': {
    type: 'security-config',
    description: 'Security configuration (auth filters, scope checks, mTLS wiring). Cannot be modified by LLM.',
    editable: false,
    allowedChanges: [],
    forbiddenChanges: [],
  },
  'audit-logger': {
    type: 'audit-logger',
    description: 'Audit log emitter + redaction utility. Modifying this risks evidence loss.',
    editable: false,
    allowedChanges: [],
    forbiddenChanges: [],
  },
  'datasource-client': {
    type: 'datasource-client',
    description: 'Datasource client wiring (timeout / retry / circuit breaker). Resilience profile owns this.',
    editable: false,
    allowedChanges: [],
    forbiddenChanges: [],
  },
  'correlation-id-filter': {
    type: 'correlation-id-filter',
    description: 'Correlation-ID filter. Owned by observability profile.',
    editable: false,
    allowedChanges: [],
    forbiddenChanges: [],
  },
  'observability-wiring': {
    type: 'observability-wiring',
    description: 'Metrics, tracing, logging wiring. Owned by observability profile.',
    editable: false,
    allowedChanges: [],
    forbiddenChanges: [],
  },
  'service-impl': {
    type: 'service-impl',
    description: 'Service class declaration + constructor + audit calls. Body of individual methods may be llm-editable.',
    editable: false,
    allowedChanges: [],
    forbiddenChanges: [],
  },

  // ─── LLM-editable (scoped change classes only) ──────────────────────────
  'business-logic': {
    type: 'business-logic',
    description: 'Uncovered business logic inside a service method. LLM may rewrite the method body only.',
    editable: true,
    allowedChanges: ['method_body_only'],
    forbiddenChanges: ['add_field_to_dto', 'add_import_within_package'],
  },
  'test-case': {
    type: 'test-case',
    description: 'Generated test placeholder. LLM may flesh out the assertion list.',
    editable: true,
    allowedChanges: ['add_test_case', 'method_body_only'],
    forbiddenChanges: [],
  },
}

/**
 * Looked up at generation time by the templates and at validation time
 * by the Patch Guard. Unknown region IDs throw — the guard treats
 * unknown regions as "no allowed edits" by default but the Foundry must
 * not emit them in the first place.
 */
export function regionSpec(regionId: string): RegionTypeSpec {
  const entry = REGION_TYPES[regionId]
  if (!entry) {
    throw new Error(`Unknown region type '${regionId}'. Add it to ontology.ts before emitting.`)
  }
  return entry
}

export type RegionMarkerLanguage = 'java' | 'typescript' | 'python' | 'yaml'
