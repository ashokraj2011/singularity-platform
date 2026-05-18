/**
 * M42.5 — Brownfield data shapes. Patent Chain B's structured Repo
 * Model + Chain C's typed Change Plan. Kept in one file so the
 * scanner / impact / planner / recipe modules all agree on the wire
 * format.
 */
export type Language = 'java' | 'python' | 'typescript'
export type Framework = 'spring-boot' | 'fastapi' | 'express'

// ─── Repo Model (§25.5) ─────────────────────────────────────────────────

export interface RepoEndpoint {
  operationId: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  responseType?: string
  controllerClass?: string
  routerFile?: string
  serviceMethod?: string
}

export interface RepoModelField {
  name: string
  type: string  // language-native type string ('String', 'str', 'string', etc.)
  required?: boolean
}

export interface RepoModelEntry {
  name: string
  file: string
  kind: 'class' | 'record' | 'pydantic_model' | 'zod_schema' | 'typescript_interface'
  fields: RepoModelField[]
}

export interface RepoService {
  className: string
  file: string
  methods: Array<{ name: string; returnType?: string; parameters: Array<{ name: string; type: string }> }>
}

export interface RepoTest {
  className: string
  file: string
}

export interface RepoContract {
  type: 'openapi' | 'swagger'
  file: string
}

export interface RepoAuditEvent {
  // Class name of the audit logger + the event-name constant we found.
  loggerClass: string
  file: string
  eventName?: string
}

export interface RepoModel {
  application: {
    name: string
    language: Language
    framework: Framework
    packageName?: string
    repoPath: string
  }
  controllers: Array<{
    className: string
    file: string
    basePath?: string
    endpoints: RepoEndpoint[]
  }>
  models: RepoModelEntry[]
  services: RepoService[]
  tests: RepoTest[]
  contracts: RepoContract[]
  auditEvents: RepoAuditEvent[]
  // Path → presence flag for security/observability config files we
  // detect. The Brownfield Patch Guard uses this for the
  // "preserve security configuration" rule.
  securityConfigFiles: string[]
}

// ─── Enhancement Spec (§25.3) ──────────────────────────────────────────────

export interface EnhancementSpec {
  specVersion: string
  kind: 'code_enhancement'
  metadata: {
    workItemId?: string
    title?: string
    ownerTeam?: string
    capability?: string
  }
  repo: {
    url?: string
    path?: string
    branch?: string
    baseBranch?: string
  }
  application: {
    language: Language
    framework: Framework
    buildTool?: string
  }
  enhancement: {
    type: 'ADD_RESPONSE_FIELD'
    targetEndpoint: string  // operationId of the endpoint that returns the model
    targetModel: string     // name of the model to extend
  }
  field: {
    name: string
    type: 'string' | 'integer' | 'long' | 'number' | 'double' | 'boolean' | 'datetime' | 'date' | 'uuid'
    required?: boolean
  }
  mapping?: {
    source?: string  // existing field name to derive from
    rules?: Array<{ when: string; value: string }>
  }
  update?: {
    dto?: boolean
    openapi?: boolean
    serviceMapping?: boolean
    tests?: boolean
    audit?: boolean
  }
  llm?: {
    allowed?: boolean
    allowedTasks?: string[]
    forbiddenChanges?: string[]
  }
}

// ─── Change Plan (§25.7) ──────────────────────────────────────────────────

export type ChangeOperationType =
  | 'ADD_FIELD'                 // add field to DTO/model
  | 'UPDATE_OPENAPI_SCHEMA'     // add property to OpenAPI components.schemas.X
  | 'UPDATE_SERVICE_MAPPING'    // set the new field inside service body (LLM-eligible)
  | 'UPDATE_TEST_EXPECTATION'   // extend test assertions (LLM-eligible)

export interface ChangeOperation {
  operation: ChangeOperationType
  targetFile: string
  // Optional structured fields per operation type.
  targetClass?: string
  targetMethod?: string
  field?: { name: string; type: string; required?: boolean }
  schemaName?: string
  deterministic: boolean   // false → produces an LLM patch task
  llmEligible?: boolean
  description: string
}

export interface ChangePlan {
  planVersion: '1.0.0'
  changeType: 'ADD_RESPONSE_FIELD' | string
  knownPattern: boolean
  riskLevel: 'low' | 'medium' | 'high'
  publicContractChange: boolean
  requiresHumanApproval: boolean
  operations: ChangeOperation[]
  enhancementSpecHash: string
  repoModelHash: string
}

// ─── Impact Report (§25.6) ────────────────────────────────────────────────

export interface ImpactReport {
  enhancementType: string
  knownPattern: boolean
  riskLevel: 'low' | 'medium' | 'high'
  affectedFiles: string[]
  publicContractChange: boolean
  requiresHumanApproval: boolean
  llmNeeded: boolean
  llmReason?: string
}
