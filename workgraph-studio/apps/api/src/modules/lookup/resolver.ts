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
  getToolByName,
  listPromptProfiles,
  AgentAndToolsError,
} from '../../lib/agent-and-tools/client'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const SINGLE_KINDS = [
  'user', 'team', 'business-unit', 'capability', 'role',
  'mcp-server', 'agent-template', 'tool', 'prompt-profile',
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
        // IAM keys /capabilities/{capability_id} by SLUG (e.g. "tag-test"),
        // not the row UUID. If `id` looks like a UUID, list and find by row id.
        if (UUID_RE.test(id)) {
          const list = await iamProxyGet('/capabilities', { size: 500 }, authToken(req)) as { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>> | null
          const items = Array.isArray(list) ? list : (list?.items ?? [])
          const hit = items.find((r) => String(r.id ?? '') === id)
          return hit ? { kind, id, exists: true, label: hit.name as string | undefined, raw: hit } : { kind, id, exists: false }
        }
        const r = await iamProxyGet(`/capabilities/${encodeURIComponent(id)}`, {}, authToken(req)) as Record<string, unknown> | null
        return r ? { kind, id, exists: true, label: r.name as string | undefined, raw: r } : { kind, id, exists: false }
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

interface RefRequirement {
  kind: RefKind
  field: string
  value: string
}

function literalRef(field: string, value: unknown, kind: RefKind): RefRequirement | null {
  if (typeof value !== 'string' || !value.trim() || TEMPLATE_RE.test(value)) return null
  return { kind, field, value: value.trim() }
}

export function refsForNodeConfig(nodeType: string, config: Record<string, unknown>): RefRequirement[] {
  const refs: RefRequirement[] = []
  const push = (r: RefRequirement | null) => { if (r) refs.push(r) }

  // Universal: most node configs may carry a capabilityId.
  push(literalRef('capabilityId', config.capabilityId, 'capability'))

  switch (nodeType) {
    case 'AGENT_TASK':
      push(literalRef('agentTemplateId', config.agentTemplateId, 'agent-template'))
      push(literalRef('promptProfileId', config.promptProfileId, 'prompt-profile'))
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
    case 'TOOL_REQUEST':
      push(literalRef('tool',     config.tool,     'tool'))
      push(literalRef('toolName', config.toolName, 'tool'))
      break
    case 'HUMAN_TASK':
    case 'APPROVAL': {
      const mode = config.assignmentMode as string | undefined
      if (mode === 'DIRECT_USER') push(literalRef('assignedToId', config.assignedToId, 'user'))
      if (mode === 'TEAM_QUEUE')  push(literalRef('teamId',       config.teamId,       'team'))
      if (mode === 'ROLE_BASED')  push(literalRef('roleKey',      config.roleKey,      'role'))
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

export async function validateNodeConfig(
  nodeType: string,
  config:   Record<string, unknown> | null | undefined,
  req:      Request,
): Promise<ValidationResult> {
  const cfg = (config ?? {}) as Record<string, unknown>
  const reqs = refsForNodeConfig(nodeType, cfg)
  if (reqs.length === 0) return { ok: true, failures: [], resolved: [] }

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
  return { ok: failures.length === 0, failures, resolved }
}
