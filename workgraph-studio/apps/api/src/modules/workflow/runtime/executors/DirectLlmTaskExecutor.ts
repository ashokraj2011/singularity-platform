import { lookup } from 'node:dns/promises'
import net from 'node:net'
import { Prisma, type WorkflowInstance, type WorkflowNode } from '@prisma/client'
import { workflowNodeTraceId } from '@workgraph/shared-types'
import { prisma } from '../../../../lib/prisma'
import { withTenantDbTransaction } from '../../../../lib/tenant-db-context'
import { logEvent, publishOutbox } from '../../../../lib/audit'
import { recordWorkflowLlmUsage } from '../budget'
import { classifyAddress } from '../../../../lib/ssrf-guard'
import {
  DirectLlmHarnessError,
  runDirectLlmHarness,
  type DirectLlmChatResult,
  type DirectLlmHarnessOptions,
  type DirectLlmHarnessPhase,
  type DirectLlmProviderRequest,
} from './DirectLlmHarness'
import type { ComposeArtifact } from '../../../../lib/prompt-composer/client'

type DirectLlmOutput = {
  directLlmFields?: Record<string, unknown> | null
  directLlm: {
    passed: boolean
    provider?: string
    model?: string
    modelAlias?: string
    response?: string
    traceId?: string
    agentRunId?: string
    artifactId?: string
    approvalRequestId?: string
    reviewRequired?: boolean
    coWork?: boolean
    promptUrl?: string
    promptVariables?: Array<Record<string, unknown>>
    workEvent?: Record<string, unknown>
    bypassedRuntimeFabric: true
    harness?: Record<string, unknown>
    structuredOutput?: Record<string, unknown> | null
    outputSchema?: Record<string, unknown>
    outputFields?: Record<string, unknown>
    usage?: {
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
    }
    error?: string
    code?: string
  }
}

type DirectLlmResult =
  | { passed: true; reviewRequired: boolean; output: DirectLlmOutput }
  | { passed: false; output: DirectLlmOutput }

type ResolvedDirectLlmConfig = {
  provider: string
  model: string
  baseUrl?: string
  modelAlias?: string
  credentialEnv?: string
  systemPrompt?: string
  prompt: string
  temperature?: number
  maxTokens: number
  timeoutMs: number
  reviewRequired: boolean
  coWork: boolean
  promptUrl?: string
  promptVariables?: Array<Record<string, unknown>>
  outputPath?: string
  outputSchema?: Record<string, unknown>
  outputFields?: Record<string, unknown>
  inputArtifacts: ComposeArtifact[]
  harness: DirectLlmHarnessOptions
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function cfgValue(node: WorkflowNode, key: string): unknown {
  const cfg = isRecord(node.config) ? node.config : {}
  const standard = isRecord(cfg.standard) ? cfg.standard : {}
  return cfg[key] ?? standard[key]
}

function harnessValue(node: WorkflowNode, key: string): unknown {
  const cfg = isRecord(node.config) ? node.config : {}
  const standard = isRecord(cfg.standard) ? cfg.standard : {}
  const harness = isRecord(cfg.harness)
    ? cfg.harness
    : isRecord(cfg.directLlmHarness)
      ? cfg.directLlmHarness
      : isRecord(standard.harness)
        ? standard.harness
        : isRecord(standard.directLlmHarness)
          ? standard.directLlmHarness
          : {}
  return harness[key] ?? cfg[key] ?? standard[key]
}

function cfgString(node: WorkflowNode, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = cfgValue(node, key)
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function cfgNumber(node: WorkflowNode, key: string, fallback: number): number {
  const value = cfgValue(node, key)
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : fallback
}

function cfgBool(node: WorkflowNode, key: string, fallback: boolean): boolean {
  const value = cfgValue(node, key)
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y'].includes(v)) return true
    if (['false', '0', 'no', 'n'].includes(v)) return false
  }
  return fallback
}

function harnessString(node: WorkflowNode, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = harnessValue(node, key)
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function harnessNumber(node: WorkflowNode, key: string, fallback: number): number {
  const value = harnessValue(node, key)
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : fallback
}

function harnessBool(node: WorkflowNode, key: string, fallback: boolean): boolean {
  const value = harnessValue(node, key)
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y'].includes(v)) return true
    if (['false', '0', 'no', 'n'].includes(v)) return false
  }
  return fallback
}

function harnessStringArray(node: WorkflowNode, key: string, fallback: string[] = []): string[] {
  const value = harnessValue(node, key)
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean)
  return fallback
}

function harnessJsonObject(node: WorkflowNode, key: string): Record<string, unknown> | undefined {
  const value = harnessValue(node, key)
  if (isRecord(value)) return value
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return isRecord(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

function safeJsonParseObject(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (fenced?.[1]) {
      try {
        const parsed = JSON.parse(fenced[1])
        return isRecord(parsed) ? parsed : undefined
      } catch {
        // Fall through to embedded-object extraction below.
      }
    }
    const embedded = trimmed.match(/\{[\s\S]*\}/)
    if (!embedded?.[0]) return undefined
    try {
      const parsed = JSON.parse(embedded[0])
      return isRecord(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
}

function jsonSafeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function nestedLookup(root: Record<string, unknown>, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && !Array.isArray(acc)) return (acc as Record<string, unknown>)[key]
    return undefined
  }, root)
}

function interpolate(template: string, instance: WorkflowInstance, node: WorkflowNode): string {
  const context = isRecord(instance.context) ? instance.context : {}
  const vars = isRecord(context._vars) ? context._vars : isRecord(context.vars) ? context.vars : {}
  const globals = isRecord(context._globals) ? context._globals : isRecord(context.globals) ? context.globals : {}
  const scope: Record<string, unknown> = {
    context,
    vars,
    globals,
    instance: { id: instance.id, templateId: instance.templateId, createdById: instance.createdById },
    node: { id: node.id, label: node.label, type: node.nodeType },
  }
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath) => {
    const value = nestedLookup(scope, String(rawPath).trim())
    if (value == null) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return JSON.stringify(value)
  })
}

type PromptVariableSpec = {
  name: string
  path?: string
  description?: string
  required?: boolean
  value?: unknown
}

type ResolvedPromptVariable = {
  name: string
  path: string
  description?: string
  required?: boolean
  missing?: boolean
  value?: unknown
}

const DEFAULT_PROMPT_URL_MAX_BYTES = 256_000

function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name]
  if (value == null || value === '') return fallback
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.trim().toLowerCase())
}

function promptUrlMaxBytes(): number {
  const raw = Number(process.env.WORKGRAPH_PROMPT_URL_MAX_BYTES)
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.trunc(raw), 2_000_000) : DEFAULT_PROMPT_URL_MAX_BYTES
}

function parseJsonUnknown(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function normalizePromptVariableSpecs(raw: unknown): PromptVariableSpec[] {
  const value = typeof raw === 'string' && raw.trim()
    ? (parseJsonUnknown(raw.trim()) ?? raw.trim())
    : raw
  if (typeof value === 'string') {
    return value.split(',').map(item => item.trim()).filter(Boolean).map(name => ({ name }))
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      if (typeof item === 'string' && item.trim()) return [{ name: item.trim() }]
      if (!isRecord(item)) return []
      const name = typeof item.name === 'string' && item.name.trim()
        ? item.name.trim()
        : typeof item.key === 'string' && item.key.trim()
          ? item.key.trim()
          : ''
      if (!name) return []
      return [{
        name,
        path: typeof item.path === 'string' && item.path.trim() ? item.path.trim() : undefined,
        description: typeof item.description === 'string' ? item.description : undefined,
        required: typeof item.required === 'boolean' ? item.required : undefined,
        value: item.value,
      }]
    })
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([name, spec]): PromptVariableSpec[] => {
      const cleanName = name.trim()
      if (!cleanName) return []
      if (typeof spec === 'string' && spec.trim()) return [{ name: cleanName, path: spec.trim() }]
      if (isRecord(spec)) {
        return [{
          name: cleanName,
          path: typeof spec.path === 'string' && spec.path.trim() ? spec.path.trim() : undefined,
          description: typeof spec.description === 'string' ? spec.description : undefined,
          required: typeof spec.required === 'boolean' ? spec.required : undefined,
          value: spec.value,
        }]
      }
      return [{ name: cleanName, value: spec }]
    })
  }
  return []
}

function valueForPrompt(value: unknown, limit = 4000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`
}

function resolvePromptVariables(node: WorkflowNode, instance: WorkflowInstance): {
  variables: ResolvedPromptVariable[]
  section?: string
} {
  const specs = normalizePromptVariableSpecs(
    cfgValue(node, 'inputVariables')
      ?? cfgValue(node, 'promptVariables')
      ?? cfgValue(node, 'variables')
      ?? harnessValue(node, 'inputVariables')
      ?? harnessValue(node, 'promptVariables'),
  )
  if (specs.length === 0) return { variables: [] }
  const variables = specs.map(spec => {
    const path = spec.path ?? spec.name
    const value = spec.value !== undefined ? spec.value : lookupContextValue(instance, path)
    return {
      name: spec.name,
      path,
      description: spec.description,
      required: spec.required,
      missing: value === undefined || value === null || value === '',
      value,
    }
  })
  return {
    variables,
    section: [
      '# Named Input Variables',
      'The following named values were resolved by WorkGraph and are part of the task context. Use them when filling the requested output schema.',
      ...variables.map(variable => [
        `## ${variable.name}`,
        variable.description ? `Description: ${variable.description}` : undefined,
        `Source path: ${variable.path}`,
        variable.missing
          ? `Value: ${variable.required ? 'MISSING REQUIRED VALUE' : 'not provided'}`
          : `Value:\n${valueForPrompt(variable.value)}`,
      ].filter(Boolean).join('\n')),
    ].join('\n\n'),
  }
}

async function validatePromptUrl(rawUrl: string): Promise<{ ok: true; url: URL } | { ok: false; error: string }> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, error: 'Prompt URL is not a valid URL.' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `Prompt URL protocol ${url.protocol} is not allowed; use http or https.` }
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Prompt URL must not contain embedded credentials.' }
  }
  const allowPrivate = envFlag('WORKGRAPH_ALLOW_PRIVATE_PROMPT_URLS', false)
  const host = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!host) return { ok: false, error: 'Prompt URL is missing a host.' }

  const ipLiteral = net.isIP(host) ? host : null
  if (ipLiteral) {
    const cls = classifyAddress(ipLiteral)
    if (!allowPrivate && cls !== 'public') {
      return { ok: false, error: `Prompt URL host resolves to ${cls ?? 'an unknown'} address; set WORKGRAPH_ALLOW_PRIVATE_PROMPT_URLS=true only for trusted local test prompts.` }
    }
    return { ok: true, url }
  }
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))) {
    return { ok: false, error: 'Prompt URL local hostnames are disabled by default; set WORKGRAPH_ALLOW_PRIVATE_PROMPT_URLS=true for trusted local test prompts.' }
  }
  if (!allowPrivate) {
    let addresses: Array<{ address: string }>
    try {
      addresses = await lookup(host, { all: true })
    } catch (err) {
      return { ok: false, error: `Prompt URL host could not be resolved: ${(err as Error).message}` }
    }
    const internal = addresses.find(entry => classifyAddress(entry.address) !== 'public')
    if (internal) {
      return { ok: false, error: `Prompt URL host resolves to a non-public address (${internal.address}); set WORKGRAPH_ALLOW_PRIVATE_PROMPT_URLS=true only for trusted local test prompts.` }
    }
  }
  return { ok: true, url }
}

async function fetchPromptTemplateFromUrl(rawUrl: string): Promise<
  | { ok: true; url: string; template: string }
  | { ok: false; error: string; code: string }
> {
  const maxBytes = promptUrlMaxBytes()
  let current = rawUrl
  for (let redirect = 0; redirect < 5; redirect++) {
    const validated = await validatePromptUrl(current)
    if (!validated.ok) return { ok: false, error: validated.error, code: 'DIRECT_LLM_PROMPT_URL_BLOCKED' }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await fetch(validated.url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'text/plain, text/markdown, application/json;q=0.8, */*;q=0.2' },
      })
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) {
        current = new URL(location, validated.url).toString()
        continue
      }
      if (!response.ok) {
        return { ok: false, error: `Prompt URL returned HTTP ${response.status}.`, code: 'DIRECT_LLM_PROMPT_URL_FETCH_FAILED' }
      }
      const lengthHeader = Number(response.headers.get('content-length') ?? '0')
      if (Number.isFinite(lengthHeader) && lengthHeader > maxBytes) {
        return { ok: false, error: `Prompt URL content is larger than ${maxBytes} bytes.`, code: 'DIRECT_LLM_PROMPT_URL_TOO_LARGE' }
      }
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        return { ok: false, error: `Prompt URL content is larger than ${maxBytes} bytes.`, code: 'DIRECT_LLM_PROMPT_URL_TOO_LARGE' }
      }
      if (!text.trim()) {
        return { ok: false, error: 'Prompt URL returned empty content.', code: 'DIRECT_LLM_PROMPT_URL_EMPTY' }
      }
      return { ok: true, url: validated.url.toString(), template: text.trim() }
    } catch (err) {
      return { ok: false, error: `Prompt URL fetch failed: ${(err as Error).message}`, code: 'DIRECT_LLM_PROMPT_URL_FETCH_FAILED' }
    } finally {
      clearTimeout(timeout)
    }
  }
  return { ok: false, error: 'Prompt URL redirected too many times.', code: 'DIRECT_LLM_PROMPT_URL_REDIRECT_LIMIT' }
}

async function resolvePromptTemplate(node: WorkflowNode): Promise<
  | { ok: true; template: string; promptUrl?: string }
  | { ok: false; error: string; code: string }
> {
  const promptUrl = cfgString(node, 'promptUrl', 'promptSourceUrl', 'agentPromptUrl', 'promptTemplateUrl')
  if (promptUrl) {
    const fetched = await fetchPromptTemplateFromUrl(promptUrl)
    if (!fetched.ok) return fetched
    return { ok: true, template: fetched.template, promptUrl: fetched.url }
  }
  const inline = cfgString(node, 'task', 'prompt', 'userPrompt')
  if (!inline) return { ok: false, error: 'DIRECT_LLM_TASK requires a promptUrl or task/prompt.', code: 'DIRECT_LLM_NO_PROMPT' }
  return { ok: true, template: inline }
}

type OutputFieldSpec = {
  type?: string
  description?: string
  enum?: unknown[]
  required?: boolean
  items?: unknown
  default?: unknown
  examples?: unknown
}

function normalizeOutputFields(raw: unknown): Record<string, OutputFieldSpec> | undefined {
  const value = typeof raw === 'string' && raw.trim()
    ? safeJsonParseObject(raw)
    : raw
  if (!isRecord(value)) return undefined
  const fields: Record<string, OutputFieldSpec> = {}
  for (const [key, spec] of Object.entries(value)) {
    const cleanKey = key.trim()
    if (!cleanKey) continue
    if (typeof spec === 'string') {
      fields[cleanKey] = { type: spec.trim() || 'string', required: true }
    } else if (isRecord(spec)) {
      const type = typeof spec.type === 'string' && spec.type.trim() ? spec.type.trim() : 'string'
      fields[cleanKey] = {
        type,
        description: typeof spec.description === 'string' ? spec.description : undefined,
        enum: Array.isArray(spec.enum) ? spec.enum : undefined,
        required: typeof spec.required === 'boolean' ? spec.required : true,
        items: spec.items,
        default: spec.default,
        examples: spec.examples,
      }
    } else {
      fields[cleanKey] = { type: 'string', required: true }
    }
  }
  return Object.keys(fields).length ? fields : undefined
}

function outputSchemaFromFields(fields: Record<string, OutputFieldSpec> | undefined): Record<string, unknown> | undefined {
  if (!fields || Object.keys(fields).length === 0) return undefined
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, field] of Object.entries(fields)) {
    const property: Record<string, unknown> = {
      type: field.type ?? 'string',
    }
    if (field.description) property.description = field.description
    if (field.enum) property.enum = field.enum
    if (field.items) property.items = field.items
    if (field.default !== undefined) property.default = field.default
    if (field.examples !== undefined) property.examples = field.examples
    properties[key] = property
    if (field.required !== false) required.push(key)
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  }
}

function outputContractPrompt(schema: Record<string, unknown> | undefined, fields: Record<string, OutputFieldSpec> | undefined): string | undefined {
  if (!schema && !fields) return undefined
  const fieldLines = fields
    ? Object.entries(fields).map(([key, field]) => {
        const parts = [
          `- ${key}`,
          `type=${field.type ?? 'string'}`,
          field.required === false ? 'optional' : 'required',
          field.description ? `description=${field.description}` : '',
          field.enum ? `allowed=${JSON.stringify(field.enum)}` : '',
        ].filter(Boolean)
        return parts.join('; ')
      }).join('\n')
    : ''
  return [
    '# Structured Output Contract',
    'Return ONLY a valid JSON object. Do not include markdown fences, prose, or extra keys outside the schema.',
    fieldLines ? `Fields to fill:\n${fieldLines}` : undefined,
    schema ? `JSON Schema:\n${JSON.stringify(schema, null, 2)}` : undefined,
    'Downstream workflow decision nodes will read these values from directLlmFields and directLlm.structuredOutput.',
  ].filter(Boolean).join('\n')
}

function compactJson(value: unknown, limit = 6000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated]`
}

function normalizeDocumentArtifact(value: unknown, index: number, source = 'event'): ComposeArtifact | null {
  if (typeof value === 'string' && value.trim()) {
    const text = value.trim()
    const isUrl = /^https?:\/\//i.test(text)
    return {
      role: 'REFERENCE',
      label: `${source} document ${index + 1}`,
      mediaType: isUrl ? 'text/uri-list' : 'text/plain',
      content: isUrl ? `Document link:\n${text}` : text.slice(0, 12_000),
      excerpt: text.slice(0, 3_000),
    }
  }
  if (!isRecord(value)) return null
  const label = [value.label, value.title, value.name, `document ${index + 1}`]
    .find(item => typeof item === 'string' && item.trim())
  const url = [value.url, value.href, value.link, value.sourceRef]
    .find(item => typeof item === 'string' && item.trim())
  const inline = [value.content, value.text, value.body, value.markdown]
    .find(item => typeof item === 'string' && item.trim())
  const excerpt = [value.excerpt, value.summary]
    .find(item => typeof item === 'string' && item.trim())
  const content = typeof inline === 'string' && inline.trim()
    ? inline.trim()
    : typeof url === 'string' && url.trim()
      ? `Document link:\n${url.trim()}`
      : compactJson(value)
  return {
    role: 'REFERENCE',
    label: String(label),
    mediaType: typeof value.mediaType === 'string' ? value.mediaType : typeof value.mimeType === 'string' ? value.mimeType : undefined,
    content: content.slice(0, 12_000),
    excerpt: typeof excerpt === 'string' ? excerpt.slice(0, 3_000) : content.slice(0, 3_000),
  }
}

function normalizeDocumentArtifacts(value: unknown, source = 'event'): ComposeArtifact[] {
  if (value == null) return []
  const rawItems = Array.isArray(value) ? value : [value]
  return rawItems
    .map((item, index) => normalizeDocumentArtifact(item, index, source))
    .filter((item): item is ComposeArtifact => Boolean(item))
    .slice(0, 12)
}

function lookupContextValue(instance: WorkflowInstance, rawPath: string): unknown {
  const context = isRecord(instance.context) ? instance.context : {}
  const vars = isRecord(context._vars) ? context._vars : isRecord(context.vars) ? context.vars : {}
  const globals = isRecord(context._globals) ? context._globals : isRecord(context.globals) ? context.globals : {}
  const scope: Record<string, unknown> = { context, vars, globals, ...context }
  return nestedLookup(scope, rawPath.replace(/^\$\.?/, ''))
}

function eventArtifactsForInstance(instance: WorkflowInstance, node: WorkflowNode): ComposeArtifact[] {
  const configuredPath = cfgString(node, 'inputDocumentsPath', 'documentsPath', 'eventDocumentsPath')
  const configured = configuredPath ? normalizeDocumentArtifacts(lookupContextValue(instance, configuredPath), configuredPath) : []
  const context = isRecord(instance.context) ? instance.context : {}
  const workItem = isRecord(context._workItem) ? context._workItem : {}
  const input = isRecord(workItem.input) ? workItem.input : {}
  const details = isRecord(workItem.details) ? workItem.details : {}
  const eventPayload = isRecord(input.payload)
    ? input.payload
    : isRecord(input.webhookPayload)
      ? input.webhookPayload
      : isRecord(context._webhookPayload)
        ? context._webhookPayload
        : {}
  const docs = [
    ...configured,
    ...normalizeDocumentArtifacts(input.documents, '_workItem.input.documents'),
    ...normalizeDocumentArtifacts(details.documents, '_workItem.details.documents'),
    ...normalizeDocumentArtifacts((eventPayload as Record<string, unknown>).documents, 'event.documents'),
    ...normalizeDocumentArtifacts((eventPayload as Record<string, unknown>).documentLinks, 'event.documentLinks'),
    ...normalizeDocumentArtifacts((eventPayload as Record<string, unknown>).documentUrls, 'event.documentUrls'),
    ...normalizeDocumentArtifacts((eventPayload as Record<string, unknown>).documentUrl, 'event.documentUrl'),
    ...normalizeDocumentArtifacts((eventPayload as Record<string, unknown>).document, 'event.document'),
  ]
  const seen = new Set<string>()
  return docs.filter(doc => {
    const key = `${doc.label}|${doc.content ?? ''}|${doc.minioRef ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 12)
}

function documentPromptSection(artifacts: ComposeArtifact[]): string | undefined {
  if (artifacts.length === 0) return undefined
  return [
    '# Event Documents To Validate',
    'Use these documents as validation inputs. If a document is only a link, state what can be verified from the link/reference and what requires fetching or access.',
    ...artifacts.map((artifact, index) => [
      `## Document ${index + 1}: ${artifact.label}`,
      artifact.mediaType ? `Media type: ${artifact.mediaType}` : undefined,
      artifact.content ?? artifact.excerpt,
    ].filter(Boolean).join('\n')),
  ].join('\n\n')
}

function workEventCorrelation(instance: WorkflowInstance): Record<string, unknown> {
  const context = isRecord(instance.context) ? instance.context : {}
  const workItem = isRecord(context._workItem) ? context._workItem : {}
  const input = isRecord(workItem.input) ? workItem.input : {}
  const payload = isRecord(input.payload) ? input.payload : {}
  const details = isRecord(workItem.details) ? workItem.details : {}
  const firstString = (...values: unknown[]): string | undefined => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return undefined
  }
  return {
    workflowInstanceId: instance.id,
    workItemId: firstString(workItem.id),
    workCode: firstString(workItem.workCode),
    workId: firstString(input.workId, input.externalId, payload.workId, payload.externalId, details.workId, details.externalId),
    description: firstString(input.description, payload.description, details.description),
    capabilityId: firstString(workItem.parentCapabilityId, workItem.targetCapabilityId, input.capabilityId, payload.capabilityId),
    capabilityName: firstString(input.capabilityName, payload.capabilityName, details.capabilityName),
    eventType: firstString(input.eventType, payload.eventType, details.eventType),
  }
}

function defaultCredentialEnv(provider: string): string | undefined {
  const p = provider.toLowerCase()
  if (p === 'anthropic') return 'ANTHROPIC_API_KEY'
  if (p === 'openai' || p === 'openai_compatible' || p === 'openai-compatible') return 'OPENAI_API_KEY'
  return undefined
}

function normalizeProvider(provider: string): string {
  const p = provider.trim().toLowerCase().replace(/-/g, '_')
  if (p === 'openai_compatible' || p === 'openai' || p === 'anthropic' || p === 'mock') return p
  return p || 'openai_compatible'
}

const HARNESS_PHASES = new Set<DirectLlmHarnessPhase>([
  'PLAN',
  'EXPLORE',
  'ACT',
  'VERIFY',
  'REPAIR',
  'SELF_REVIEW',
  'FINALIZE',
])

function normalizeHarnessPhases(values: string[]): DirectLlmHarnessPhase[] {
  const phases = values
    .map(value => value.trim().toUpperCase())
    .filter((value): value is DirectLlmHarnessPhase => HARNESS_PHASES.has(value as DirectLlmHarnessPhase))
  return phases.length ? Array.from(new Set(phases)) : ['PLAN', 'SELF_REVIEW']
}

function resolveOutputContract(node: WorkflowNode): {
  outputFields?: Record<string, OutputFieldSpec>
  outputSchema?: Record<string, unknown>
} {
  const outputFields = normalizeOutputFields(
    harnessValue(node, 'outputFields')
      ?? harnessValue(node, 'keyValueSchema')
      ?? harnessValue(node, 'fieldSchema')
      ?? harnessValue(node, 'structuredFields'),
  )
  const configuredSchema = harnessJsonObject(node, 'outputJsonSchema')
  return {
    outputFields,
    outputSchema: configuredSchema ?? outputSchemaFromFields(outputFields),
  }
}

function resolveHarnessOptions(
  node: WorkflowNode,
  outputSchema: Record<string, unknown> | undefined,
  artifacts: ComposeArtifact[],
): DirectLlmHarnessOptions {
  const agentTemplateId = harnessString(node, 'agentTemplateId', 'profileId', 'templateId')
  const coWork = harnessBool(node, 'coWork', harnessBool(node, 'cowork', false))
  const loopEnabled = harnessBool(node, 'loopEnabled', harnessBool(node, 'useLoop', coWork))
  const validationRaw = (harnessString(node, 'validationMode') ?? 'soft').toLowerCase()
  const validationMode = validationRaw === 'hard' || validationRaw === 'off' ? validationRaw : 'soft'
  return {
    enabled: harnessBool(node, 'enabled', true),
    composeWithPromptComposer: harnessBool(node, 'composeWithPromptComposer', Boolean(agentTemplateId)),
    agentTemplateId,
    agentBindingId: harnessString(node, 'agentBindingId'),
    capabilityId: harnessString(node, 'capabilityId', 'governingCapabilityId'),
    promptProfileKey: harnessString(node, 'promptProfileKey'),
    loopEnabled,
    loopStageKey: harnessString(node, 'loopStageKey', 'stageKey') ?? 'loop.stage',
    loopAgentRole: harnessString(node, 'loopAgentRole', 'agentRole'),
    loopPhases: normalizeHarnessPhases(harnessStringArray(node, 'loopPhases', loopEnabled ? ['PLAN', 'SELF_REVIEW'] : [])),
    maxTurns: Math.min(Math.max(Math.trunc(harnessNumber(node, 'maxTurns', loopEnabled ? 3 : 1)), 1), 12),
    requiredOutputIncludes: harnessStringArray(node, 'requiredOutputIncludes'),
    artifacts,
    outputJsonSchema: outputSchema,
    validationMode,
    // Adaptive-loop controls: skip remaining phases once the output contract is satisfied, and allow a
    // bounded VERIFY→REPAIR feedback loop (mirrors the governed loop's max_repair_attempts, hard-capped 3).
    earlyStop: harnessBool(node, 'earlyStop', true),
    maxRepairAttempts: Math.min(Math.max(Math.trunc(harnessNumber(node, 'maxRepairAttempts', 3)), 0), 3),
  }
}

async function resolveDirectLlmConfig(
  node: WorkflowNode,
  instance: WorkflowInstance,
): Promise<{ config: ResolvedDirectLlmConfig } | { error: string; code: string }> {
  const alias = cfgString(node, 'connectionAlias', 'modelAlias', 'llmAlias')
  const connection = alias
    ? await prisma.llmConnection.findFirst({ where: { alias, ...(instance.tenantId ? { tenantId: instance.tenantId } : {}) } }).catch(() => null)
    : null

  if (alias && connection && !connection.enabled) {
    return { error: `LLM connection alias "${alias}" is disabled.`, code: 'DIRECT_LLM_CONNECTION_DISABLED' }
  }

  const provider = normalizeProvider(
    connection?.provider ?? cfgString(node, 'provider') ?? (connection?.baseUrl ? 'openai_compatible' : 'mock'),
  )
  if (provider === 'copilot' || provider === 'github_copilot') {
    return {
      error: 'Copilot is available only through the governed copilot_execute MCP path. Configure this node as an AGENT_TASK with executor=copilot.',
      code: 'COPILOT_CLI_ONLY',
    }
  }
  const model = connection?.model ?? cfgString(node, 'model') ?? (provider === 'anthropic' ? 'claude-3-5-sonnet-latest' : 'gpt-4o-mini')
  const baseUrl = connection?.baseUrl ?? cfgString(node, 'baseUrl') ?? undefined
  const credentialEnv = connection?.credentialEnv ?? cfgString(node, 'credentialEnv') ?? defaultCredentialEnv(provider)
  const promptTemplate = await resolvePromptTemplate(node)
  if (!promptTemplate.ok) return { error: promptTemplate.error, code: promptTemplate.code }

  const maxTokens = Math.min(Math.max(cfgNumber(node, 'maxTokens', 1200), 1), 32_000)
  const timeoutMs = Math.min(Math.max(cfgNumber(node, 'timeoutMs', cfgNumber(node, 'timeoutSec', 120) * 1000), 1_000), 600_000)
  const modelAlias = alias ?? connection?.alias ?? undefined
  const inputArtifacts = eventArtifactsForInstance(instance, node)
  const outputContract = resolveOutputContract(node)
  const promptVariables = resolvePromptVariables(node, instance)
  const coWork = cfgBool(node, 'coWork', cfgBool(node, 'cowork', false))
  const reviewRequired = coWork || cfgBool(node, 'reviewRequired', false)
  const prompt = [
    interpolate(promptTemplate.template, instance, node),
    promptVariables.section,
    documentPromptSection(inputArtifacts),
    outputContractPrompt(outputContract.outputSchema, outputContract.outputFields),
  ].map(section => section?.trim()).filter(Boolean).join('\n\n')
  return {
    config: {
      provider,
      model,
      baseUrl,
      modelAlias,
      credentialEnv,
      systemPrompt: cfgString(node, 'systemPrompt'),
      prompt,
      temperature: cfgNumber(node, 'temperature', 0.2),
      maxTokens,
      timeoutMs,
      reviewRequired,
      coWork,
      promptUrl: promptTemplate.promptUrl,
      promptVariables: promptVariables.variables.map(variable => jsonSafeRecord(variable as unknown as Record<string, unknown>)),
      outputPath: cfgString(node, 'outputPath', 'artifactName'),
      outputSchema: outputContract.outputSchema,
      outputFields: outputContract.outputFields,
      inputArtifacts,
      harness: resolveHarnessOptions(node, outputContract.outputSchema, inputArtifacts),
    },
  }
}

async function parseJsonResponse(response: Response, source: string): Promise<Record<string, unknown>> {
  const text = await response.text()
  let data: unknown = {}
  if (text.trim()) {
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`${source} returned invalid JSON: ${text.slice(0, 500)}`)
    }
  }
  if (!response.ok) {
    const message = isRecord(data) && isRecord(data.error) && typeof data.error.message === 'string'
      ? data.error.message
      : text.slice(0, 700) || `${source} returned HTTP ${response.status}`
    throw new Error(message)
  }
  if (!isRecord(data)) throw new Error(`${source} returned a non-object response.`)
  return data
}

async function callOpenAiCompatible(args: DirectLlmProviderRequest, apiKey?: string): Promise<DirectLlmChatResult> {
  const baseUrl = (args.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: args.model,
      messages: [
        ...(args.systemPrompt ? [{ role: 'system', content: args.systemPrompt }] : []),
        { role: 'user', content: args.prompt },
      ],
      temperature: args.temperature,
      max_tokens: args.maxTokens,
    }),
    signal: AbortSignal.timeout(args.timeoutMs),
  })
  const data = await parseJsonResponse(response, 'OpenAI-compatible LLM')
  const choices = Array.isArray(data.choices) ? data.choices : []
  const first = isRecord(choices[0]) ? choices[0] : {}
  const message = isRecord(first.message) ? first.message : {}
  const content = typeof message.content === 'string' ? message.content : ''
  const usage = isRecord(data.usage) ? data.usage : {}
  return {
    content,
    inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
    outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
    totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
    providerRequestId: typeof data.id === 'string' ? data.id : undefined,
  }
}

async function callAnthropic(args: DirectLlmProviderRequest, apiKey?: string): Promise<DirectLlmChatResult> {
  const baseUrl = (args.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: args.maxTokens,
      temperature: args.temperature,
      ...(args.systemPrompt ? { system: args.systemPrompt } : {}),
      messages: [{ role: 'user', content: args.prompt }],
    }),
    signal: AbortSignal.timeout(args.timeoutMs),
  })
  const data = await parseJsonResponse(response, 'Anthropic LLM')
  const blocks = Array.isArray(data.content) ? data.content : []
  const content = blocks
    .map(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : '')
    .filter(Boolean)
    .join('\n')
  const usage = isRecord(data.usage) ? data.usage : {}
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
  return {
    content,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens != null || outputTokens != null ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined,
    providerRequestId: typeof data.id === 'string' ? data.id : undefined,
  }
}

async function callProvider(args: DirectLlmProviderRequest): Promise<DirectLlmChatResult> {
  if (args.provider === 'mock') {
    return {
      content: `Mock direct LLM response for ${args.modelAlias ?? args.model}:\n\n${args.prompt.slice(0, 2000)}`,
      inputTokens: Math.ceil(args.prompt.length / 4),
      outputTokens: 64,
      totalTokens: Math.ceil(args.prompt.length / 4) + 64,
      providerRequestId: `mock-${Date.now()}`,
    }
  }

  const apiKey = args.credentialEnv ? process.env[args.credentialEnv] : undefined
  if (!apiKey) {
    throw new Error(`Missing API key env var ${args.credentialEnv ?? '(none configured)'} for direct LLM provider ${args.provider}.`)
  }

  if (args.provider === 'anthropic') return callAnthropic(args, apiKey)
  return callOpenAiCompatible(args, apiKey)
}

async function createDirectLlmArtifact(args: {
  instance: WorkflowInstance
  node: WorkflowNode
  runId: string
  content: string
  payload: Record<string, unknown>
  reviewRequired: boolean
  name?: string
}): Promise<string | undefined> {
  const content = args.content.trim()
  if (!content) return undefined
  const tenantId = args.instance.tenantId ?? undefined
  const type = await prisma.consumableType.upsert({
    where: { name: 'DIRECT_LLM_OUTPUT' },
    update: {},
    create: {
      name: 'DIRECT_LLM_OUTPUT',
      description: 'Direct WorkGraph LLM output. This bypasses Context Fabric and MCP.',
      requiresApproval: args.reviewRequired,
      allowVersioning: true,
      schemaDef: {},
    },
  })
  const payload = {
    artifactType: 'direct_llm_output',
    approvalRequired: args.reviewRequired,
    agentRunId: args.runId,
    nodeId: args.node.id,
    nodeLabel: args.node.label,
    content,
    receipt: args.payload,
  }
  const created = await withTenantDbTransaction(prisma, (tx) => tx.consumable.create({
    data: {
      typeId: type.id,
      instanceId: args.instance.id,
      nodeId: args.node.id,
      name: args.name ?? `${args.node.label || args.node.id} direct LLM output`,
      status: args.reviewRequired ? 'UNDER_REVIEW' : 'APPROVED',
      currentVersion: 1,
      formData: payload as Prisma.InputJsonValue,
      createdById: args.instance.createdById ?? undefined,
      versions: {
        create: {
          version: 1,
          payload: payload as Prisma.InputJsonValue,
          createdById: args.instance.createdById ?? undefined,
        },
      },
    },
  }), tenantId)
  await logEvent('DirectLlmOutputArtifactCreated', 'Consumable', created.id, args.instance.createdById ?? undefined, {
    runId: args.runId,
    nodeId: args.node.id,
    reviewRequired: args.reviewRequired,
  })
  await publishOutbox('Consumable', created.id, 'DirectLlmOutputArtifactCreated', {
    consumableId: created.id,
    runId: args.runId,
    nodeId: args.node.id,
  })
  return created.id
}

function cfgStringFromRecord(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

async function ensureDirectLlmApprovalRequest(args: {
  instance: WorkflowInstance
  node: WorkflowNode
  actorId?: string
  runId: string
  output: DirectLlmOutput
}): Promise<string> {
  const tenantId = args.instance.tenantId ?? undefined
  const existing = await withTenantDbTransaction(prisma, (tx) => tx.approvalRequest.findFirst({
    where: {
      instanceId: args.instance.id,
      nodeId: args.node.id,
      subjectType: 'DirectLlmTask',
      subjectId: args.node.id,
      status: 'PENDING',
    },
    orderBy: { createdAt: 'desc' },
  }), tenantId)
  if (existing) return existing.id

  const cfg = isRecord(args.node.config) ? args.node.config : {}
  const standard = isRecord(cfg.standard) ? cfg.standard : {}
  const approvalConfig = { ...standard, ...cfg }
  const assignedToId = cfgStringFromRecord(approvalConfig, 'assignedToId', 'approverUserId')
  const teamId = cfgStringFromRecord(approvalConfig, 'teamId')
  const roleKey = cfgStringFromRecord(approvalConfig, 'roleKey')
  const skillKey = cfgStringFromRecord(approvalConfig, 'skillKey')
  const capabilityId = cfgStringFromRecord(approvalConfig, 'capabilityId', 'governingCapabilityId')
  const assignmentMode = cfgStringFromRecord(approvalConfig, 'assignmentMode')
    ?? (assignedToId ? 'DIRECT_USER' : teamId ? 'TEAM_QUEUE' : roleKey ? 'ROLE_BASED' : skillKey ? 'SKILL_BASED' : undefined)

  const created = await withTenantDbTransaction(prisma, (tx) => tx.approvalRequest.create({
    data: {
      instanceId: args.instance.id,
      tenantId: args.instance.tenantId ?? null,
      nodeId: args.node.id,
      subjectType: 'DirectLlmTask',
      subjectId: args.node.id,
      requestedById: args.actorId ?? args.instance.createdById ?? 'system',
      assignedToId,
      assignmentMode,
      teamId,
      roleKey,
      skillKey,
      capabilityId,
      formData: {
        agentRunId: args.runId,
        workflowInstanceId: args.instance.id,
        workflowNodeId: args.node.id,
        directLlmOutput: jsonSafeRecord(args.output as unknown as Record<string, unknown>),
      } as Prisma.InputJsonValue,
    },
  }), tenantId)

  await prisma.agentRunOutput.create({
    data: {
      runId: args.runId,
      outputType: 'APPROVAL_REQUIRED',
      rawContent: `Direct LLM output requires approval (${created.id})`,
      structuredPayload: {
        approvalRequestId: created.id,
        workflowInstanceId: args.instance.id,
        workflowNodeId: args.node.id,
        directLlmOutput: jsonSafeRecord(args.output as unknown as Record<string, unknown>),
      } as Prisma.InputJsonValue,
    },
  })
  await logEvent('DirectLlmReviewRequested', 'ApprovalRequest', created.id, args.actorId, {
    runId: args.runId,
    nodeId: args.node.id,
    instanceId: args.instance.id,
    traceId: args.output.directLlm.traceId,
    workEvent: args.output.directLlm.workEvent,
  })
  await publishOutbox('ApprovalRequest', created.id, 'DirectLlmReviewRequested', {
    requestId: created.id,
    runId: args.runId,
    nodeId: args.node.id,
    instanceId: args.instance.id,
    traceId: args.output.directLlm.traceId,
    workEvent: args.output.directLlm.workEvent,
  })
  return created.id
}

function failed(code: string, error: string): DirectLlmResult {
  return {
    passed: false,
    output: {
      directLlm: {
        passed: false,
        error,
        code,
        bypassedRuntimeFabric: true,
      },
    },
  }
}

export async function activateDirectLlmTask(
  node: WorkflowNode,
  instance: WorkflowInstance,
  actorId?: string,
): Promise<DirectLlmResult> {
  const dbTenantId = instance.tenantId ?? undefined
  const resolved = await resolveDirectLlmConfig(node, instance)
  if ('error' in resolved) return failed(resolved.code, resolved.error)
  const llm = resolved.config
  const workEvent = workEventCorrelation(instance)

  const traceId = workflowNodeTraceId({
    prefix: 'direct-llm',
    workflowInstanceId: instance.id,
    workflowNodeId: node.id,
  })
  const agent = await withTenantDbTransaction(prisma, (tx) => tx.agent.create({
    data: {
      name: `Direct LLM: ${node.label || node.id}`,
      description: 'Workflow node that calls an LLM directly from WorkGraph API, bypassing Context Fabric and MCP.',
      provider: llm.provider.toUpperCase(),
      model: llm.model,
      systemPrompt: llm.systemPrompt,
      isActive: true,
    },
  }), dbTenantId)
  const run = await withTenantDbTransaction(prisma, (tx) => tx.agentRun.create({
    data: {
      agentId: agent.id,
      instanceId: instance.id,
      tenantId: instance.tenantId ?? null,
      nodeId: node.id,
      attempt: node.attempt,
      status: 'RUNNING',
      origin: 'workflow-direct-llm',
      client: 'workgraph-api-direct',
      traceId,
      initiatedById: actorId ?? instance.createdById ?? undefined,
      startedAt: new Date(),
      inputs: {
        create: {
          inputType: 'DIRECT_LLM_REQUEST',
          payload: jsonSafeRecord({
            provider: llm.provider,
            model: llm.model,
            modelAlias: llm.modelAlias,
            baseUrl: llm.baseUrl,
            credentialEnv: llm.credentialEnv,
            prompt: llm.prompt,
            systemPrompt: llm.systemPrompt,
            temperature: llm.temperature,
            maxTokens: llm.maxTokens,
            timeoutMs: llm.timeoutMs,
            reviewRequired: llm.reviewRequired,
            coWork: llm.coWork,
            promptUrl: llm.promptUrl,
            promptVariables: llm.promptVariables,
            workEvent,
            outputFields: llm.outputFields,
            outputSchema: llm.outputSchema,
            inputArtifacts: llm.inputArtifacts,
            harness: llm.harness,
            bypassedRuntimeFabric: true,
          }) as Prisma.InputJsonValue,
        },
      },
    },
  }), dbTenantId)

  await logEvent('DirectLlmRunStarted', 'AgentRun', run.id, actorId, {
    nodeId: node.id,
    instanceId: instance.id,
    provider: llm.provider,
    model: llm.model,
    modelAlias: llm.modelAlias,
    bypassedRuntimeFabric: true,
    coWork: llm.coWork,
    promptUrl: llm.promptUrl,
    ...workEvent,
  })
  await publishOutbox('AgentRun', run.id, 'DirectLlmRunStarted', { runId: run.id, nodeId: node.id, traceId, ...workEvent })

  let chat: DirectLlmChatResult
  let harnessReceipt: Record<string, unknown> | undefined
  let harnessReviewRequired = false
  try {
    const harness = await runDirectLlmHarness({
      llm,
      options: llm.harness,
      node,
      instance,
      traceId,
      callProvider,
    })
    chat = harness.chat
    harnessReceipt = harness.receipt as unknown as Record<string, unknown>
    harnessReviewRequired = harness.reviewRequired
  } catch (err) {
    const message = (err as Error).message
    const code = err instanceof DirectLlmHarnessError ? err.code : 'DIRECT_LLM_PROVIDER_ERROR'
    await prisma.agentRunOutput.create({
      data: {
        runId: run.id,
        outputType: 'ERROR',
        rawContent: message,
        structuredPayload: {
          errorCode: code,
          traceId,
          ...(err instanceof DirectLlmHarnessError ? { harness: err.details } : {}),
        } as Prisma.InputJsonValue,
      },
    })
    await withTenantDbTransaction(prisma, (tx) => tx.agentRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', completedAt: new Date() },
    }), dbTenantId)
    await logEvent('DirectLlmRunFailed', 'AgentRun', run.id, actorId, {
      nodeId: node.id,
      instanceId: instance.id,
      code,
      error: message,
      ...workEvent,
    })
    await publishOutbox('AgentRun', run.id, 'DirectLlmRunFailed', { runId: run.id, nodeId: node.id, traceId, code, error: message, ...workEvent })
    return failed(code, message)
  }
  const reviewRequired = llm.reviewRequired || harnessReviewRequired
  const structuredOutput = safeJsonParseObject(chat.content)

  const usage = {
    inputTokens: chat.inputTokens,
    outputTokens: chat.outputTokens,
    totalTokens: chat.totalTokens,
  }
  const correlation: Record<string, unknown> = {
    traceId,
    modelCallId: chat.providerRequestId,
    modelAlias: llm.modelAlias,
    provider: llm.provider,
    model: llm.model,
    baseUrl: llm.baseUrl,
    credentialEnv: llm.credentialEnv,
    bypassedRuntimeFabric: true,
    bypassedContextFabric: true,
    bypassedMcp: true,
    reviewRequired,
    coWork: llm.coWork,
    promptUrl: llm.promptUrl,
    promptVariables: llm.promptVariables,
    workEvent,
    usage,
    harness: harnessReceipt,
    structuredOutput: structuredOutput ?? null,
    outputSchema: llm.outputSchema,
    outputFields: llm.outputFields,
    inputArtifacts: llm.inputArtifacts,
  }

  await prisma.agentRunOutput.create({
    data: {
      runId: run.id,
      outputType: 'EXECUTION_TRACE',
      rawContent: traceId,
      structuredPayload: correlation as Prisma.InputJsonValue,
    },
  })
  await prisma.agentRunOutput.create({
    data: {
      runId: run.id,
      outputType: 'LLM_RESPONSE',
      rawContent: chat.content,
      structuredPayload: correlation as Prisma.InputJsonValue,
      tokenCount: chat.totalTokens ?? chat.inputTokens ?? null,
    },
  })

  const artifactId = await createDirectLlmArtifact({
    instance,
    node,
    runId: run.id,
    content: chat.content,
    payload: correlation,
    reviewRequired,
    name: llm.outputPath,
  })
  if (artifactId) correlation.artifactId = artifactId
  if (artifactId) {
    await prisma.agentRunOutput.updateMany({
      where: { runId: run.id, outputType: 'LLM_RESPONSE' },
      data: { structuredPayload: correlation as Prisma.InputJsonValue },
    })
  }

  await withTenantDbTransaction(prisma, (tx) => tx.agentRun.update({
    where: { id: run.id },
    data: {
      status: reviewRequired ? 'AWAITING_REVIEW' : 'APPROVED',
      completedAt: new Date(),
      modelCallId: chat.providerRequestId,
    },
  }), dbTenantId)

  await recordWorkflowLlmUsage(instance.id, {
    nodeId: node.id,
    agentRunId: run.id,
    inputTokens: chat.inputTokens,
    outputTokens: chat.outputTokens,
    totalTokens: chat.totalTokens,
    provider: llm.provider,
    model: llm.model,
    metadata: {
      modelAlias: llm.modelAlias,
      direct: true,
      bypassedRuntimeFabric: true,
      modelCallId: chat.providerRequestId,
    },
  }, dbTenantId).catch(err => logEvent('WorkflowBudgetUsageRecordFailed', 'WorkflowInstance', instance.id, actorId, {
    nodeId: node.id,
    agentRunId: run.id,
    error: (err as Error).message,
  }))

  await logEvent('DirectLlmRunCompleted', 'AgentRun', run.id, actorId, {
    nodeId: node.id,
    instanceId: instance.id,
    modelCallId: chat.providerRequestId,
    reviewRequired,
    usage,
    harness: harnessReceipt,
    ...workEvent,
  })
  await publishOutbox('AgentRun', run.id, 'DirectLlmRunCompleted', {
    runId: run.id,
    nodeId: node.id,
    reviewRequired,
    traceId,
    ...workEvent,
  })

  const directOutput: DirectLlmOutput = {
    directLlm: {
      passed: true,
      provider: llm.provider,
      model: llm.model,
      modelAlias: llm.modelAlias,
      response: chat.content,
      traceId,
      agentRunId: run.id,
      artifactId,
      reviewRequired,
      coWork: llm.coWork,
      promptUrl: llm.promptUrl,
      promptVariables: llm.promptVariables,
      bypassedRuntimeFabric: true,
      harness: harnessReceipt,
      structuredOutput: structuredOutput ?? null,
      outputSchema: llm.outputSchema,
      outputFields: llm.outputFields,
      workEvent,
      usage,
    },
    directLlmFields: structuredOutput ?? null,
  }

  if (reviewRequired) {
    directOutput.directLlm.approvalRequestId = await ensureDirectLlmApprovalRequest({
      instance,
      node,
      actorId,
      runId: run.id,
      output: directOutput,
    })
  }

  return {
    passed: true,
    reviewRequired,
    output: directOutput,
  }
}
