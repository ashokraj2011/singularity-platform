/**
 * M11.b — shared resolver + write-time validator for cross-service refs.
 *
 * Extracted from lookup.router so the workflow design save path can run the
 * same checks the SPA `/api/lookup/resolve` endpoint runs.
 *
 * `resolveOne` does ONE upstream call per ref. Callers should batch with
 * Promise.all. No caching here — federate-live model is the contract.
 */

import type { Request } from 'express'
import { proxyGet as iamProxyGet, IamUnauthorizedError, IamUnavailableError } from '../../lib/iam/client'
import {
  getAgentTemplate,
  getRuntimeCapability,
  getToolByName,
  listPromptProfiles,
  AgentAndToolsError,
} from '../../lib/agent-and-tools/client'
import { validateDirectLlmConfig } from '../workflow/runtime/executors/direct-llm-config'
import { resolveLoopStrategyVersion } from '../workflow/loop-strategy.service'
import { prisma } from '../../lib/prisma'
import { currentTenantIdForDb } from '../../lib/tenant-db-context'

export const SINGLE_KINDS = [
  'user', 'team', 'business-unit', 'capability', 'role',
  'mcp-server', 'agent-template', 'tool', 'prompt-profile', 'claim',
] as const

export type RefKind = typeof SINGLE_KINDS[number]

export interface ResolverHit {
  kind:   RefKind | string
  id:     string
  exists: boolean
  label?: string
  raw?:   unknown
  error?: string
}

export function authToken(req: Request): string | undefined {
  const h = req.headers.authorization
  if (typeof h !== 'string') return undefined
  return h.startsWith('Bearer ') ? h.slice(7) : h
}

export function authHeader(req: Request): string | undefined {
  const t = authToken(req)
  return t ? `Bearer ${t}` : undefined
}

export async function resolveOne(kind: string, id: string, req: Request): Promise<ResolverHit> {
  if (!id) return { kind, id, exists: false, error: 'empty-id' }
  try {
    switch (kind) {
      case 'user': {
        const r = await iamProxyGet(`/users/${encodeURIComponent(id)}`, {}, authToken(req)) as Record<string, unknown> | null
        return r ? { kind, id, exists: true, label: (r.display_name as string | undefined) ?? (r.email as string | undefined), raw: r } : { kind, id, exists: false }
      }
      case 'team': {
        const r = await iamProxyGet(`/teams/${encodeURIComponent(id)}`, {}, authToken(req)) as Record<string, unknown> | null
        return r ? { kind, id, exists: true, label: r.name as string | undefined, raw: r } : { kind, id, exists: false }
      }
      case 'business-unit': {
        const r = await iamProxyGet(`/business-units/${encodeURIComponent(id)}`, {}, authToken(req)) as Record<string, unknown> | null
        return r ? { kind, id, exists: true, label: r.name as string | undefined, raw: r } : { kind, id, exists: false }
      }
      case 'capability': {
        // Workflow configuration references the executable Agent Runtime
        // capability, not the IAM authorization record. Runtime capability IDs
        // are stable UUIDs and are also used for repositories/world models.
        const capability = await getRuntimeCapability(id, authHeader(req))
        return capability
          ? { kind, id, exists: true, label: capability.name, raw: { ...capability, source: 'agent-runtime' } }
          : { kind, id, exists: false }
      }
      case 'role': {
        const r = await iamProxyGet(`/roles/${encodeURIComponent(id)}`, {}, authToken(req)) as Record<string, unknown> | null
        return r ? { kind, id, exists: true, label: (r.name as string | undefined) ?? (r.role_key as string | undefined), raw: r } : { kind, id, exists: false }
      }
      case 'mcp-server': {
        const r = await iamProxyGet(`/mcp-servers/${encodeURIComponent(id)}`, {}, authToken(req)) as Record<string, unknown> | null
        return r ? { kind, id, exists: true, label: r.base_url as string | undefined, raw: r } : { kind, id, exists: false }
      }
      case 'agent-template': {
        const tpl = await getAgentTemplate(id, authHeader(req))
        return tpl ? { kind, id, exists: true, label: tpl.name, raw: tpl } : { kind, id, exists: false }
      }
      case 'tool': {
        const t = await getToolByName(id, authHeader(req))
        return t ? { kind, id, exists: true, label: (t.display_name ?? t.tool_name) as string | undefined, raw: t } : { kind, id, exists: false }
      }
      case 'prompt-profile': {
        const all = await listPromptProfiles(authHeader(req))
        const hit = all.find((p) => p.id === id) ?? null
        return hit ? { kind, id, exists: true, label: hit.name, raw: hit } : { kind, id, exists: false }
      }
      case 'claim': {
        // claim-registry is the system of record for SPEC_BOUND belief refs
        // (a template's metadata.claimRefs). Fetch-to-validate; forward the caller's
        // bearer (the registry is auth-gated) and fail closed on any error/timeout.
        const base = (process.env.CLAIM_REGISTRY_URL ?? 'http://claim-registry:8600').replace(/\/+$/, '')
        const auth = authHeader(req)
        const res = await fetch(`${base}/api/v1/claims/${encodeURIComponent(id)}`, {
          headers: auth ? { authorization: auth } : {},
          signal: AbortSignal.timeout(4000),
        }).catch(() => null)
        if (!res || !res.ok) return { kind, id, exists: false }
        const claim = await res.json().catch(() => null) as { statement?: string; maturity?: string; posteriorProb?: number } | null
        if (!claim) return { kind, id, exists: false }
        return { kind, id, exists: true, label: claim.statement, raw: claim }
      }
      default:
        return { kind, id, exists: false, error: `unsupported kind: ${kind}` }
    }
  } catch (err) {
    if (err instanceof IamUnauthorizedError) return { kind, id, exists: false, error: 'upstream-unauthorized' }
    if (err instanceof IamUnavailableError) return { kind, id, exists: false, error: 'upstream-unavailable' }
    if (err instanceof AgentAndToolsError) {
      if (err.status === 404) return { kind, id, exists: false }
      return { kind, id, exists: false, error: `upstream-${err.status}` }
    }
    return { kind, id, exists: false, error: (err as Error).message }
  }
}

// ── Write-time node-config validator ───────────────────────────────────────
//
// Given a node's `nodeType` + `config`, extract the cross-service refs that
// MUST exist and resolve them in parallel. Templated values like
// `{{vars.assigneeId}}` or `{{instance.vars.x}}` are skipped — they bind at
// runtime and can't be validated at design-time.

const TEMPLATE_RE = /^\s*\{\{.+?\}\}\s*$/
const PATH_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/
const EVENT_EMIT_TRANSPORTS = new Set(['EVENTBUS', 'KAFKA', 'SQS', 'SNS', 'AMQP'])
const DATA_SINK_KINDS = new Set(['CONNECTOR', 'DB_EVENT', 'ARTIFACT'])

interface RefRequirement {
  kind: RefKind
  field: string
  value: string
}

function literalRef(field: string, value: unknown, kind: RefKind): RefRequirement | null {
  if (typeof value !== 'string' || !value.trim() || TEMPLATE_RE.test(value)) return null
  return { kind, field, value: value.trim() }
}

function isTemplateValue(value: unknown): boolean {
  return typeof value === 'string' && TEMPLATE_RE.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function standardConfig(config: Record<string, unknown>): Record<string, unknown> {
  return isRecord(config.standard) ? config.standard : {}
}

function configValue(config: Record<string, unknown>, key: string): unknown {
  const direct = config[key]
  return direct === undefined || direct === null || direct === '' ? standardConfig(config)[key] : direct
}

function configString(config: Record<string, unknown>, key: string): string | undefined {
  const value = configValue(config, key)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function refsForNodeConfig(nodeType: string, config: Record<string, unknown>): RefRequirement[] {
  const refs: RefRequirement[] = []
  const push = (r: RefRequirement | null) => { if (r) refs.push(r) }
  const direct = config.directLlm && typeof config.directLlm === 'object' && !Array.isArray(config.directLlm)
    ? config.directLlm as Record<string, unknown>
    : {}

  // Universal: most node configs may carry a capabilityId.
  push(literalRef('capabilityId', config.capabilityId, 'capability'))
  push(literalRef('directLlm.capabilityId', direct.capabilityId, 'capability'))

  switch (nodeType) {
    case 'AGENT_TASK':
      push(literalRef('agentTemplateId', config.agentTemplateId, 'agent-template'))
      push(literalRef('promptProfileId', config.promptProfileId, 'prompt-profile'))
      break
    case 'DIRECT_LLM_TASK':
      push(literalRef('agentTemplateId', config.agentTemplateId ?? direct.agentTemplateId, 'agent-template'))
      push(literalRef('promptProfileId', config.promptProfileId ?? direct.promptProfileId, 'prompt-profile'))
      break
    case 'WORKBENCH_TASK': {
      const workbench = config.workbench && typeof config.workbench === 'object' && !Array.isArray(config.workbench)
        ? config.workbench as Record<string, unknown>
        : {}
      const bindings = workbench.agentBindings && typeof workbench.agentBindings === 'object' && !Array.isArray(workbench.agentBindings)
        ? workbench.agentBindings as Record<string, unknown>
        : {}
      push(literalRef('workbench.capabilityId', workbench.capabilityId, 'capability'))
      push(literalRef('workbench.agentBindings.architectAgentTemplateId', bindings.architectAgentTemplateId, 'agent-template'))
      push(literalRef('workbench.agentBindings.developerAgentTemplateId', bindings.developerAgentTemplateId, 'agent-template'))
      push(literalRef('workbench.agentBindings.qaAgentTemplateId', bindings.qaAgentTemplateId, 'agent-template'))
      break
    }
    case 'WORK_ITEM': {
      const rows = Array.isArray(config.targets) ? config.targets
        : Array.isArray(config.workItemTargets) ? config.workItemTargets
        : []
      for (const [idx, row] of rows.entries()) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue
        const r = row as Record<string, unknown>
        push(literalRef(`targets.${idx}.targetCapabilityId`, r.targetCapabilityId ?? r.capabilityId, 'capability'))
      }
      const std = config.standard && typeof config.standard === 'object' && !Array.isArray(config.standard)
        ? config.standard as Record<string, unknown>
        : {}
      push(literalRef('targetCapabilityId', std.targetCapabilityId ?? config.targetCapabilityId, 'capability'))
      break
    }
    case 'TOOL_REQUEST':
      push(literalRef('tool',     config.tool,     'tool'))
      push(literalRef('toolName', config.toolName, 'tool'))
      break
    case 'HUMAN_TASK':
    case 'APPROVAL': {
      const standard = config.standard && typeof config.standard === 'object' && !Array.isArray(config.standard)
        ? config.standard as Record<string, unknown>
        : {}
      const requiredRole = config.roleKey ?? standard.role
      const mode = (config.assignmentMode as string | undefined)
        ?? (requiredRole ? 'ROLE_BASED' : undefined)
      if (mode === 'DIRECT_USER') push(literalRef('assignedToId', config.assignedToId, 'user'))
      if (mode === 'TEAM_QUEUE')  push(literalRef('teamId',       config.teamId,       'team'))
      if (mode === 'ROLE_BASED')  push(literalRef('roleKey',      requiredRole,       'role'))
      // SKILL_BASED skipped — IAM has no /skills/:key by-id endpoint yet.
      break
    }
    default:
      break
  }
  return refs
}

export interface ValidationFailure {
  field:  string
  kind:   RefKind | string
  id:     string
  reason: string
}

export interface ValidationResult {
  ok:        boolean
  failures:  ValidationFailure[]
  resolved:  ResolverHit[]
}

function failure(field: string, kind: string, reason: string, id = field): ValidationFailure {
  return { field, kind, id, reason }
}

async function validateCallWorkflowConfig(config: Record<string, unknown>): Promise<ValidationFailure[]> {
  const templateId = configString(config, 'templateId')
  if (!templateId) {
    return [failure('templateId', 'node-config', 'CALL_WORKFLOW requires a target workflow template id.')]
  }
  if (isTemplateValue(templateId)) return []
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(templateId)) {
    return [failure('templateId', 'workflow-template', 'templateId must be a workflow template UUID or a runtime placeholder.', templateId)]
  }
  const tenantId = currentTenantIdForDb()
  const template = await prisma.workflow.findFirst({
    where: {
      id: templateId,
      archivedAt: null,
      ...(tenantId ? { OR: [{ tenantId }, { tenantId: null }] } : {}),
    },
    select: { id: true },
  })
  return template ? [] : [failure('templateId', 'workflow-template', 'target workflow template was not found or is archived/out of tenant scope.', templateId)]
}

function validateSignalConfig(nodeType: string, config: Record<string, unknown>): ValidationFailure[] {
  if (configString(config, 'signalName')) return []
  return [failure('signalName', 'node-config', `${nodeType} requires a signalName. Use a runtime placeholder if it is supplied at launch.`)]
}

function validateTimerConfig(config: Record<string, unknown>): ValidationFailure[] {
  const until = configValue(config, 'until')
  const durationMs = configValue(config, 'durationMs')
  const duration = configValue(config, 'duration')
  if (isTemplateValue(until) || isTemplateValue(durationMs) || isTemplateValue(duration)) return []
  if (typeof until === 'string' && until.trim()) {
    return Number.isNaN(new Date(until).valueOf())
      ? [failure('until', 'node-config', 'TIMER until must be an ISO date/time or a runtime placeholder.')]
      : []
  }
  if (typeof durationMs === 'number' || (typeof durationMs === 'string' && durationMs.trim())) {
    const numeric = Number(durationMs)
    return Number.isFinite(numeric) && numeric >= 0
      ? []
      : [failure('durationMs', 'node-config', 'TIMER durationMs must be a finite non-negative number.')]
  }
  if (typeof duration === 'string' && duration.trim()) {
    return /^(\d+)\s*(s|m|h)$/.test(duration.trim())
      ? []
      : [failure('duration', 'node-config', 'TIMER duration must look like 30s, 5m, or 2h.')]
  }
  return [failure('duration', 'node-config', 'TIMER requires durationMs, duration, or until; empty timers fire immediately at runtime.')]
}

function validateSetContextConfig(config: Record<string, unknown>): ValidationFailure[] {
  const assignments = Array.isArray(config.assignments) ? config.assignments : []
  if (assignments.length === 0) return [failure('assignments', 'node-config', 'SET_CONTEXT requires at least one assignment.')]
  const failures: ValidationFailure[] = []
  assignments.forEach((row, index) => {
    if (!isRecord(row)) {
      failures.push(failure(`assignments.${index}`, 'node-config', 'assignment must be an object.'))
      return
    }
    const path = typeof row.path === 'string' && row.path.trim()
      ? row.path.trim()
      : typeof row.key === 'string' && row.key.trim()
        ? row.key.trim()
        : ''
    if (!path) failures.push(failure(`assignments.${index}.path`, 'node-config', 'assignment requires path or key.'))
    else if (!isTemplateValue(path) && !PATH_RE.test(path)) failures.push(failure(`assignments.${index}.path`, 'node-config', 'assignment path must use dotted identifier syntax.', path))
    if (row.value === undefined) failures.push(failure(`assignments.${index}.value`, 'node-config', 'assignment requires a value.'))
  })
  return failures
}

function validateDataSinkConfig(config: Record<string, unknown>): ValidationFailure[] {
  const sink = isRecord(config.sinkConfig) ? config.sinkConfig : { kind: 'DB_EVENT' }
  const kind = String(sink.kind ?? 'DB_EVENT').trim().toUpperCase()
  if (!DATA_SINK_KINDS.has(kind)) {
    return [failure('sinkConfig.kind', 'node-config', `DATA_SINK kind '${kind}' is not implemented; use CONNECTOR, DB_EVENT, or ARTIFACT.`, kind)]
  }
  const failures: ValidationFailure[] = []
  if (kind === 'CONNECTOR') {
    if (!(typeof sink.connectorId === 'string' && sink.connectorId.trim()) && !isTemplateValue(sink.connectorId)) failures.push(failure('sinkConfig.connectorId', 'node-config', 'CONNECTOR data sinks require connectorId.'))
    if (!(typeof sink.operation === 'string' && sink.operation.trim()) && !isTemplateValue(sink.operation)) failures.push(failure('sinkConfig.operation', 'node-config', 'CONNECTOR data sinks require operation.'))
  }
  if (kind === 'ARTIFACT') {
    const artifactType = typeof sink.artifactType === 'string' ? sink.artifactType.trim() : ''
    if (!artifactType && !isTemplateValue(sink.artifactType)) failures.push(failure('sinkConfig.artifactType', 'node-config', 'ARTIFACT data sinks require artifactType.'))
  }
  return failures
}

function validateEventEmitConfig(config: Record<string, unknown>): ValidationFailure[] {
  const transport = String(configString(config, 'transport') ?? 'EVENTBUS').trim().toUpperCase()
  const failures: ValidationFailure[] = []
  if (!EVENT_EMIT_TRANSPORTS.has(transport)) {
    failures.push(failure('transport', 'node-config', `EVENT_EMIT transport must be one of ${[...EVENT_EMIT_TRANSPORTS].join(', ')}.`, transport))
  }
  if (transport === 'KAFKA' && !configString(config, 'topic')) failures.push(failure('topic', 'node-config', 'KAFKA EVENT_EMIT requires topic.'))
  if (transport === 'SQS' && !configString(config, 'queueUrl')) failures.push(failure('queueUrl', 'node-config', 'SQS EVENT_EMIT requires queueUrl.'))
  if (transport === 'SNS' && !configString(config, 'topicArn')) failures.push(failure('topicArn', 'node-config', 'SNS EVENT_EMIT requires topicArn.'))
  if (transport === 'AMQP' && !configString(config, 'routingKey')) failures.push(failure('routingKey', 'node-config', 'AMQP EVENT_EMIT requires routingKey.'))
  return failures
}

async function validateOperationalNodeConfig(nodeType: string, config: Record<string, unknown>): Promise<ValidationFailure[]> {
  switch (nodeType) {
    case 'CALL_WORKFLOW':
      return validateCallWorkflowConfig(config)
    case 'SIGNAL_WAIT':
    case 'SIGNAL_EMIT':
      return validateSignalConfig(nodeType, config)
    case 'TIMER':
      return validateTimerConfig(config)
    case 'SET_CONTEXT':
      return validateSetContextConfig(config)
    case 'DATA_SINK':
      return validateDataSinkConfig(config)
    case 'EVENT_EMIT':
      return validateEventEmitConfig(config)
    case 'EVENT_GATEWAY':
      return [failure('nodeType', 'node-config', 'EVENT_GATEWAY is not implemented at runtime; model the race with SIGNAL_WAIT/TIMER branches and a DECISION_GATE.')]
    default:
      return []
  }
}

export async function validateNodeConfig(
  nodeType: string,
  config:   Record<string, unknown> | null | undefined,
  req:      Request,
): Promise<ValidationResult> {
  const cfg = (config ?? {}) as Record<string, unknown>
  const reqs = refsForNodeConfig(nodeType, cfg)
  const resolved = await Promise.all(reqs.map((r) => resolveOne(r.kind, r.value, req)))
  const failures: ValidationFailure[] = []
  for (let i = 0; i < reqs.length; i++) {
    const r = reqs[i]
    const hit = resolved[i]
    if (!hit.exists) {
      failures.push({
        field: r.field,
        kind:  r.kind,
        id:    r.value,
        reason: hit.error ?? 'not-found',
      })
    }
  }
  failures.push(...await validateOperationalNodeConfig(nodeType, cfg))

  if (nodeType === 'DIRECT_LLM_TASK') {
    const directValidation = validateDirectLlmConfig(cfg)
    failures.push(...directValidation.failures.map(item => ({
      field: item.field,
      kind: 'direct-llm-config',
      id: item.field,
      reason: item.message,
    })))
    const loop = directValidation.config.loopStrategy
    if (loop) {
      try {
        await resolveLoopStrategyVersion(loop.strategyId, loop.version)
      } catch (error) {
        failures.push({
          field: 'directLlm.loopStrategy',
          kind: 'loop-strategy',
          id: `${loop.strategyId}@${loop.version}`,
          reason: error instanceof Error ? error.message : 'loop strategy version is unavailable',
        })
      }
    }
  }
  return { ok: failures.length === 0, failures, resolved }
}
