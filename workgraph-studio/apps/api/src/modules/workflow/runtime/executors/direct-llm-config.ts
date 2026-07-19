import Ajv from 'ajv'

export type DirectLlmPromptSource = 'AGENT_PROFILE' | 'URL' | 'INLINE'
export type DirectLlmValidationMode = 'hard' | 'soft' | 'off'

export type DirectLlmInputBinding = {
  name: string
  path: string
  required: boolean
  description?: string
}

export type DirectLlmOutputField = {
  type: string
  description?: string
  required?: boolean
  enum?: unknown[]
  items?: unknown
  default?: unknown
  examples?: unknown
}

export type CanonicalDirectLlmConfig = {
  connectionAlias?: string
  provider?: string
  model?: string
  baseUrl?: string
  credentialEnv?: string
  agentTemplateId?: string
  capabilityId?: string
  promptProfileKey?: string
  promptSource: DirectLlmPromptSource
  promptUrl?: string
  task?: string
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  composeWithPromptComposer?: boolean
  inputBindings: DirectLlmInputBinding[]
  inputDocumentsPath?: string
  outputContract: {
    fields: Record<string, DirectLlmOutputField>
    jsonSchema?: Record<string, unknown>
    validationMode: DirectLlmValidationMode
  }
  review: {
    required: boolean
    coWork: boolean
    assignmentMode?: string
    assignedToId?: string
    teamId?: string
    roleKey?: string
    skillKey?: string
  }
  loopStrategy?: {
    strategyId: string
    version: number
  }
}

export type DirectLlmConfigFailure = {
  field: string
  message: string
}

export type DirectLlmConfigValidation = {
  ok: boolean
  config: CanonicalDirectLlmConfig
  failures: DirectLlmConfigFailure[]
}

const ajv = new Ajv({ allErrors: true, strict: false })
const OUTPUT_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array'])
const PROMPT_SOURCES = new Set<DirectLlmPromptSource>(['AGENT_PROFILE', 'URL', 'INLINE'])
const VALIDATION_MODES = new Set<DirectLlmValidationMode>(['hard', 'soft', 'off'])
const PATH_RE = /^(?:[A-Za-z_$][A-Za-z0-9_$-]*)(?:(?:\.(?:[A-Za-z_$][A-Za-z0-9_$-]*))|(?:\[(?:0|[1-9]\d*)\]))*$/
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off'].includes(normalized)) return false
  }
  return fallback
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseJson(value: unknown, field: string, failures: DirectLlmConfigFailure[]): unknown {
  if (typeof value !== 'string') return value
  if (!value.trim()) return undefined
  try {
    return JSON.parse(value)
  } catch {
    failures.push({ field, message: 'must contain valid JSON.' })
    return undefined
  }
}

function readRootValue(raw: Record<string, unknown>, direct: Record<string, unknown>, key: string): unknown {
  return direct[key] ?? raw[key] ?? (isRecord(raw.standard) ? raw.standard[key] : undefined)
}

function normalizeInputBindings(value: unknown, field: string, failures: DirectLlmConfigFailure[]): DirectLlmInputBinding[] {
  const parsed = parseJson(value, field, failures)
  if (parsed == null) return []
  const rows: Array<[string, unknown]> = Array.isArray(parsed)
    ? parsed.map((item, index) => [String(index), item])
    : isRecord(parsed) ? Object.entries(parsed) : []
  if (rows.length === 0 && !Array.isArray(parsed) && !isRecord(parsed)) {
    failures.push({ field, message: 'must be an object or array of input bindings.' })
  }
  const bindings: DirectLlmInputBinding[] = []
  const seen = new Set<string>()
  for (const [key, rawSpec] of rows) {
    const spec = isRecord(rawSpec) ? rawSpec : { path: rawSpec }
    const name = text(spec.name) ?? (Array.isArray(parsed) ? '' : key)
    const path = text(spec.path) ?? (typeof rawSpec === 'string' ? rawSpec.trim() : undefined)
    if (!name) {
      failures.push({ field: `${field}.${key}`, message: 'needs a non-empty variable name.' })
      continue
    }
    if (seen.has(name)) {
      failures.push({ field: `${field}.${name}`, message: 'variable names must be unique.' })
      continue
    }
    seen.add(name)
    if (!path) {
      failures.push({ field: `${field}.${name}.path`, message: 'needs a source path.' })
      continue
    }
    if (!PATH_RE.test(path)) {
      failures.push({ field: `${field}.${name}.path`, message: 'must be a valid dotted context path.' })
    }
    bindings.push({
      name,
      path,
      required: typeof spec.required === 'boolean' ? spec.required : true,
      description: text(spec.description),
    })
  }
  return bindings
}

function normalizeFields(value: unknown, field: string, failures: DirectLlmConfigFailure[]): Record<string, DirectLlmOutputField> {
  const parsed = parseJson(value, field, failures)
  if (parsed == null) return {}
  const entries: Array<[string, unknown]> = Array.isArray(parsed)
    ? parsed.map((item, index) => [String(index), item])
    : isRecord(parsed) ? Object.entries(parsed) : []
  if (entries.length === 0 && !Array.isArray(parsed) && !isRecord(parsed)) {
    failures.push({ field, message: 'must be an object or array of output fields.' })
  }
  const fields: Record<string, DirectLlmOutputField> = {}
  for (const [key, rawSpec] of entries) {
    const spec = typeof rawSpec === 'string' ? { type: rawSpec } : isRecord(rawSpec) ? rawSpec : {}
    const name = text(spec.name) ?? (Array.isArray(parsed) ? '' : key)
    if (!name) {
      failures.push({ field: `${field}.${key}`, message: 'needs a non-empty field name.' })
      continue
    }
    const type = text(spec.type) ?? 'string'
    if (!OUTPUT_TYPES.has(type)) {
      failures.push({ field: `${field}.${name}.type`, message: `unsupported type '${type}'.` })
    }
    const enumValues = Array.isArray(spec.enum) ? spec.enum : undefined
    if (enumValues) {
      for (const item of enumValues) {
        if (!valueMatchesType(item, type)) {
          failures.push({ field: `${field}.${name}.enum`, message: `enum value ${JSON.stringify(item)} does not match type '${type}'.` })
        }
      }
    }
    if (type === 'array' && spec.items !== undefined && !isRecord(spec.items)) {
      failures.push({ field: `${field}.${name}.items`, message: 'array item schema must be an object.' })
    }
    fields[name] = {
      type,
      description: text(spec.description),
      required: typeof spec.required === 'boolean' ? spec.required : true,
      enum: enumValues,
      items: spec.items,
      default: spec.default,
      examples: spec.examples,
    }
  }
  return fields
}

function valueMatchesType(value: unknown, type: string): boolean {
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'object') return isRecord(value)
  if (type === 'array') return Array.isArray(value)
  return true
}

function schemaFromFields(fields: Record<string, DirectLlmOutputField>): Record<string, unknown> | undefined {
  if (Object.keys(fields).length === 0) return undefined
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, field] of Object.entries(fields)) {
    const property: Record<string, unknown> = { type: field.type }
    if (field.description) property.description = field.description
    if (field.enum) property.enum = field.enum
    if (field.items) property.items = field.items
    if (field.default !== undefined) property.default = field.default
    if (field.examples !== undefined) property.examples = field.examples
    properties[name] = property
    if (field.required !== false) required.push(name)
  }
  return { type: 'object', additionalProperties: false, properties, required }
}

function validateSchema(schema: Record<string, unknown>, field: string, failures: DirectLlmConfigFailure[]): void {
  if (schema.type !== 'object') {
    failures.push({ field, message: 'must have an object root type.' })
  }
  validateSchemaShape(schema, field, failures)
  try {
    ajv.compile(schema)
  } catch (error) {
    failures.push({ field, message: `is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}` })
  }
}

const NUMERIC_SCHEMA_KEYS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']

function validateSchemaShape(value: unknown, field: string, failures: DirectLlmConfigFailure[]): void {
  if (!isRecord(value)) return
  const properties = isRecord(value.properties) ? value.properties : undefined
  if (Array.isArray(value.required) && properties) {
    for (const required of value.required) {
      if (typeof required === 'string' && !(required in properties)) failures.push({ field: `${field}.required`, message: `required field '${required}' must exist in properties.` })
    }
  }
  for (const key of NUMERIC_SCHEMA_KEYS) {
    if (value[key] === undefined) continue
    const number = typeof value[key] === 'number' ? value[key] : NaN
    if (!Number.isFinite(number) || Math.abs(number) > 1_000_000_000_000) failures.push({ field: `${field}.${key}`, message: 'must be a finite bounded number.' })
  }
  if (typeof value.minimum === 'number' && typeof value.maximum === 'number' && value.minimum > value.maximum) failures.push({ field, message: 'minimum cannot be greater than maximum.' })
  if (Array.isArray(value.enum) && typeof value.type === 'string') {
    for (const item of value.enum) if (!valueMatchesType(item, value.type)) failures.push({ field: `${field}.enum`, message: `value ${JSON.stringify(item)} does not match type '${value.type}'.` })
  }
  if (isRecord(value.properties)) for (const [name, child] of Object.entries(value.properties)) validateSchemaShape(child, `${field}.properties.${name}`, failures)
  if (value.items !== undefined) validateSchemaShape(value.items, `${field}.items`, failures)
  if (isRecord(value.additionalProperties)) validateSchemaShape(value.additionalProperties, `${field}.additionalProperties`, failures)
}

function defaultDirectConfig(): CanonicalDirectLlmConfig {
  return {
    promptSource: 'INLINE',
    inputBindings: [],
    outputContract: { fields: {}, validationMode: 'hard' },
    review: { required: false, coWork: false },
  }
}

export function normalizeDirectLlmConfig(rawValue: unknown, failures: DirectLlmConfigFailure[] = []): CanonicalDirectLlmConfig {
  const raw = isRecord(rawValue) ? rawValue : {}
  const direct = isRecord(raw.directLlm) ? raw.directLlm : {}
  const get = (key: string) => readRootValue(raw, direct, key)
  const agentTemplateId = text(get('agentTemplateId') ?? get('profileId'))
  const promptUrl = text(get('promptUrl') ?? get('promptSourceUrl'))
  const task = text(get('task') ?? get('prompt') ?? get('userPrompt'))
  const explicitSource = text(direct.promptSource ?? raw.promptSource)?.toUpperCase() as DirectLlmPromptSource | undefined
  const promptSource = explicitSource && PROMPT_SOURCES.has(explicitSource)
    ? explicitSource
    : agentTemplateId ? 'AGENT_PROFILE' : promptUrl ? 'URL' : 'INLINE'
  const reviewRaw = isRecord(direct.review) ? direct.review : {}
  const contractRaw = isRecord(direct.outputContract) ? direct.outputContract : {}
  const fieldsValue = contractRaw.fields
    ?? get('outputFields')
    ?? get('keyValueSchema')
    ?? get('fieldSchema')
    ?? get('structuredFields')
  const fields = normalizeFields(fieldsValue, 'outputContract.fields', failures)
  const configuredSchema = parseJson(contractRaw.jsonSchema ?? get('outputJsonSchema'), 'outputContract.jsonSchema', failures)
  const outputSchema = isRecord(configuredSchema) ? configuredSchema : schemaFromFields(fields)
  if (configuredSchema !== undefined && configuredSchema !== null && !isRecord(configuredSchema)) {
    failures.push({ field: 'outputContract.jsonSchema', message: 'must be a JSON object.' })
  }
  if (isRecord(outputSchema)) validateSchema(outputSchema, 'outputContract.jsonSchema', failures)

  const rawMode = text(contractRaw.validationMode ?? get('validationMode'))?.toLowerCase() as DirectLlmValidationMode | undefined
  if (rawMode && !VALIDATION_MODES.has(rawMode)) {
    failures.push({ field: 'outputContract.validationMode', message: 'must be one of hard, soft, or off.' })
  }
  const validationMode = rawMode && VALIDATION_MODES.has(rawMode) ? rawMode : 'hard'
  const inputValue = direct.inputBindings ?? get('inputVariables') ?? get('promptVariables') ?? get('variables')
  const inputBindings = normalizeInputBindings(inputValue, 'inputBindings', failures)
  const loopStrategyRaw = isRecord(direct.loopStrategy)
    ? direct.loopStrategy
    : isRecord(raw.loopStrategy) ? raw.loopStrategy : undefined
  const loopStrategy = loopStrategyRaw && text(loopStrategyRaw.strategyId) && numberValue(loopStrategyRaw.version) !== undefined
    ? { strategyId: text(loopStrategyRaw.strategyId)!, version: Math.trunc(numberValue(loopStrategyRaw.version)!) }
    : undefined
  if (loopStrategyRaw && !loopStrategy) failures.push({ field: 'loopStrategy', message: 'requires strategyId and an integer version.' })
  const timeoutMs = numberValue(get('timeoutMs')) ?? (numberValue(get('timeoutSec')) !== undefined ? numberValue(get('timeoutSec'))! * 1000 : undefined)

  const config: CanonicalDirectLlmConfig = {
    ...defaultDirectConfig(),
    connectionAlias: text(get('connectionAlias') ?? get('modelAlias') ?? get('llmAlias')),
    provider: text(get('provider')),
    model: text(get('model')),
    baseUrl: text(get('baseUrl')),
    credentialEnv: text(get('credentialEnv')),
    agentTemplateId,
    capabilityId: text(get('capabilityId') ?? get('governingCapabilityId')),
    promptProfileKey: text(get('promptProfileKey')),
    promptSource,
    promptUrl,
    task,
    systemPrompt: text(get('systemPrompt')),
    maxTokens: numberValue(get('maxTokens')),
    temperature: numberValue(get('temperature')),
    timeoutMs,
    composeWithPromptComposer: bool(get('composeWithPromptComposer'), Boolean(agentTemplateId)),
    inputBindings,
    inputDocumentsPath: text(get('inputDocumentsPath') ?? get('documentsPath') ?? get('eventDocumentsPath')),
    outputContract: { fields, jsonSchema: outputSchema, validationMode },
    review: {
      required: bool(reviewRaw.required ?? get('reviewRequired'), false),
      coWork: bool(reviewRaw.coWork ?? get('coWork') ?? get('cowork'), false),
      assignmentMode: text(reviewRaw.assignmentMode ?? get('assignmentMode')),
      assignedToId: text(reviewRaw.assignedToId ?? get('assignedToId')),
      teamId: text(reviewRaw.teamId ?? get('teamId')),
      roleKey: text(reviewRaw.roleKey ?? get('roleKey')),
      skillKey: text(reviewRaw.skillKey ?? get('skillKey')),
    },
    loopStrategy,
  }

  if (config.promptSource === 'AGENT_PROFILE' && !config.agentTemplateId) failures.push({ field: 'promptSource', message: 'Agent profile mode requires an agent profile.' })
  if (config.promptSource === 'URL') {
    if (!config.promptUrl) failures.push({ field: 'promptUrl', message: 'URL mode requires a prompt URL.' })
    else {
      if (config.promptUrl.length > 2000) failures.push({ field: 'promptUrl', message: 'must be 2,000 characters or fewer.' })
      try {
        const url = new URL(config.promptUrl)
        if (!['http:', 'https:'].includes(url.protocol)) failures.push({ field: 'promptUrl', message: 'must use http or https.' })
        if (url.username || url.password) failures.push({ field: 'promptUrl', message: 'must not contain embedded credentials.' })
      } catch { failures.push({ field: 'promptUrl', message: 'must be a valid URL.' }) }
    }
  }
  if (config.promptSource === 'INLINE' && !config.task) failures.push({ field: 'task', message: 'inline prompt mode requires a task prompt.' })
  if (config.credentialEnv && !ENV_RE.test(config.credentialEnv)) failures.push({ field: 'credentialEnv', message: 'must be an environment variable name, not a secret.' })
  if (config.credentialEnv && !credentialEnvAllowed(config.credentialEnv)) {
    failures.push({ field: 'credentialEnv', message: 'is not in the server-managed direct LLM credential allowlist.' })
  }
  if (config.maxTokens !== undefined && (!Number.isInteger(config.maxTokens) || config.maxTokens < 1 || config.maxTokens > 32000)) failures.push({ field: 'maxTokens', message: 'must be an integer between 1 and 32,000.' })
  if (config.temperature !== undefined && (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)) failures.push({ field: 'temperature', message: 'must be between 0 and 2.' })
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 600000)) failures.push({ field: 'timeoutMs', message: 'must be between 1,000 and 600,000 milliseconds.' })
  if (config.inputDocumentsPath && !PATH_RE.test(config.inputDocumentsPath)) failures.push({ field: 'inputDocumentsPath', message: 'must be a valid dotted context path.' })
  return config
}

/**
 * Which env vars a direct LLM call may read a key from.
 *
 * Exported because node config is not the only source of `credentialEnv`: an
 * llmConnection row can supply one too, and it takes PRECEDENCE. Validating only
 * at config-parse time therefore left the higher-precedence value unchecked, so
 * the resolver re-applies this to the merged result. Mirrors context-fabric's
 * CONTEXT_FABRIC_DIRECT_LLM_ALLOWED_CREDENTIAL_ENVS.
 */
/**
 * Whether workgraph may egress to an LLM provider directly, bypassing the
 * platform gateway.
 *
 * The direct path reaches api.anthropic.com / api.openai.com without the
 * gateway, so it carries no task tag, no gateway audit line and no cost
 * attribution -- see docs/llm-egress-boundary.md.
 *
 * DEFAULTS TO ALLOWED, because unlike context-fabric's direct route there is no
 * alternative egress in this executor to fall through to: turning it off with no
 * migration in place would break every DIRECT_LLM_TASK rather than reroute it.
 * This is a POLICY CONTROL, not the migration. A deployment that requires all
 * generation to pass the gateway can set WORKGRAPH_ALLOW_DIRECT_LLM=false and
 * have those nodes fail loudly instead of egressing quietly.
 *
 * Mock is exempt at the call sites: it reaches no network.
 */
export function directLlmEgressAllowed(): boolean {
  const raw = (process.env.WORKGRAPH_ALLOW_DIRECT_LLM ?? '').trim().toLowerCase()
  if (!raw) return true
  return !['0', 'false', 'no', 'off'].includes(raw)
}

export function credentialEnvAllowed(name: string): boolean {
  const allowed = new Set(
    (process.env.WORKGRAPH_DIRECT_LLM_ALLOWED_CREDENTIAL_ENVS ?? 'OPENAI_API_KEY,OPENROUTER_API_KEY,ANTHROPIC_API_KEY')
      .split(',').map(value => value.trim()).filter(Boolean),
  )
  return allowed.has(name)
}

export function validateDirectLlmConfig(rawValue: unknown): DirectLlmConfigValidation {
  const failures: DirectLlmConfigFailure[] = []
  const config = normalizeDirectLlmConfig(rawValue, failures)
  return { ok: failures.length === 0, config, failures }
}
