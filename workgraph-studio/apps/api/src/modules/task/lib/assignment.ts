/**
 * Assignment routing helpers — centralizes how HUMAN_TASK / APPROVAL /
 * CONSUMABLE_CREATION nodes route work to humans.
 *
 * Routing modes (mirrors the AssignmentMode enum):
 *
 *   DIRECT_USER — `config.assignedToId` filled.  A single TaskAssignment
 *                 row (or `assignedToId` on Approval/Consumable) is stamped
 *                 with that user.  No queue.
 *
 *   TEAM_QUEUE  — `config.teamId` filled.  Tasks: one TeamQueueItem row tagged
 *                 with that teamId.  Approval/Consumable: the row's `teamId`
 *                 column is set; the inbox resolves eligibility from team
 *                 membership.
 *
 *   ROLE_BASED  — `config.roleKey` + the workflow template's `capabilityId`.
 *                 Eligibility = users with that role on that capability.
 *                 Same shape as TEAM_QUEUE — single tagged row, eligibility
 *                 resolved at read time by the runtime inbox.
 *
 *   SKILL_BASED — `config.skillKey`.  Eligibility = users with that skill in
 *                 IAM (or local UserSkill if IAM doesn't have a Skill model).
 *
 *   AGENT       — handled by AgentTaskExecutor; this helper is a no-op for it.
 *
 * Eligibility is *not* eagerly resolved: the runtime stamps the routing fields
 * on the entity (or queue row) and the runtime-inbox endpoint computes who
 * sees a given row at read time.  This keeps newly-onboarded users (added to a
 * team / role / skill in IAM after the workflow already activated) eligible
 * without a backfill job.
 */

import type { Prisma, WorkflowInstance } from '@prisma/client'
import { prisma } from '../../../lib/prisma'
import { resolveTeamIdForWorkflow } from '../../../lib/iam/teamMirror'

/** Look up the owning capabilityId for the workflow that produced this instance. */
export async function getTemplateCapabilityId(instance: WorkflowInstance): Promise<string | null> {
  if (!instance.templateId) return null
  const t = await prisma.workflow.findUnique({
    where: { id: instance.templateId },
    select: { capabilityId: true },
  })
  return t?.capabilityId ?? null
}

export type AssignmentMode = 'DIRECT_USER' | 'TEAM_QUEUE' | 'ROLE_BASED' | 'SKILL_BASED' | 'AGENT'

export type AssignmentConfig = {
  assignmentMode?: string
  assignedToId?:   string
  teamId?:         string
  roleKey?:        string
  skillKey?:       string
}

export type ResolvedRouting = {
  mode:         AssignmentMode
  assignedToId: string | null
  teamId:       string | null
  roleKey:      string | null
  skillKey:     string | null
  capabilityId: string | null
}

const VALID_MODES: AssignmentMode[] = ['DIRECT_USER', 'TEAM_QUEUE', 'ROLE_BASED', 'SKILL_BASED', 'AGENT']

// ── Runtime template resolution ─────────────────────────────────────────────
//
// Each routing field can be either a literal (set at design time) or a
// template reference resolved at runtime against the workflow instance's
// context. Supported reference forms:
//
//   {{vars.X}}            → context._vars.X   (template variable, possibly overridden per-instance)
//   {{instance.vars.X}}   → context._vars.X   (explicit run-time spelling)
//   {{globals.X}}         → context._globals.X (team-scoped global)
//   {{instance.globals.X}}→ context._globals.X
//   {{params.X}}          → context._params.X  (legacy alias of vars)
//   {{instance.params.X}} → context._params.X
//   {{output.X}}          → context.X          (any node output merged into context)
//   {{event.X}}           → context.event.X
//   {{workItem.X}}        → context.workItem.X
//   {{context.X}}         → context.X          (raw path)
//   {{X}}                 → context.X          (no prefix)
//
// A literal (no `{{ }}`) passes through unchanged.
// An unresolvable reference returns `null`; the task/approval executors fail
// closed before persistence so an operator never gets a silently invisible
// unassigned task.

const TEMPLATE_RE = /^\{\{\s*(.+?)\s*\}\}$/
const TEMPLATE_GLOBAL_RE = /\{\{\s*([^{}]+?)\s*\}\}/g

function walkPath(root: Record<string, unknown> | undefined, path: string): unknown {
  if (!root) return undefined
  return path.split('.').reduce<unknown>((cur, key) => {
    if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[key]
    return undefined
  }, root)
}

function resolveReference(context: Record<string, unknown>, rawRef: string): unknown {
  let ref = rawRef.trim()
  // `instance.*` and `runtime.*` are intentionally aliases. They make it
  // obvious in the designer that the value is supplied by the run, while the
  // stored context keeps the existing `_vars`/`_globals` contract.
  if (ref.startsWith('instance.')) ref = ref.slice('instance.'.length)
  if (ref.startsWith('runtime.')) ref = ref.slice('runtime.'.length)

  if (ref.startsWith('vars.')) return walkPath(context._vars as Record<string, unknown>, ref.slice('vars.'.length))
  if (ref.startsWith('_vars.')) return walkPath(context._vars as Record<string, unknown>, ref.slice('_vars.'.length))
  if (ref.startsWith('globals.')) return walkPath(context._globals as Record<string, unknown>, ref.slice('globals.'.length))
  if (ref.startsWith('_globals.')) return walkPath(context._globals as Record<string, unknown>, ref.slice('_globals.'.length))
  if (ref.startsWith('params.')) return walkPath(context._params as Record<string, unknown>, ref.slice('params.'.length))
  if (ref.startsWith('_params.')) return walkPath(context._params as Record<string, unknown>, ref.slice('_params.'.length))
  if (ref.startsWith('context.')) return walkPath(context, ref.slice('context.'.length))
  if (ref.startsWith('output.')) return walkPath(context, ref.slice('output.'.length))
  if (ref.startsWith('event.')) return walkPath(context, ref)
  if (ref.startsWith('payload.')) return walkPath(context, ref)
  if (ref.startsWith('workItem.')) return walkPath(context, ref)
  return walkPath(context, ref)
}

/**
 * Resolve a possibly-templated assignment value against the instance context.
 * Returns the resolved string id/key, or `null` when unresolvable.
 */
export function resolveAssignmentValue(
  raw:     string | null | undefined,
  context: Record<string, unknown> | undefined,
): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  const m = raw.match(TEMPLATE_RE)
  if (!m) {
    // Support a composed label such as `reviewer-{{vars.region}}` as well as
    // the normal full-value form. IDs and role keys should still use the full
    // form; this simply avoids making runtime-bound strings unnecessarily
    // restrictive.
    if (!raw.includes('{{')) return raw
    const ctx = context ?? {}
    let unresolved = false
    const composed = raw.replace(TEMPLATE_GLOBAL_RE, (_match, ref: string) => {
      const value = resolveReference(ctx, ref)
      if (value === null || value === undefined || typeof value === 'object') {
        unresolved = true
        return ''
      }
      return String(value)
    })
    return unresolved ? null : composed
  }

  const value = resolveReference(context ?? {}, m[1])
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

export function isAssignmentTemplate(value: unknown): value is string {
  return typeof value === 'string' && value.includes('{{')
}

/**
 * Normalize free-form node config into a strongly-typed routing record.
 * Falls back to DIRECT_USER when no mode is set, matching pre-existing
 * behaviour from the original HumanTaskExecutor.
 *
 * When `instanceContext` is supplied, any field whose value is a `{{...}}`
 * template reference is resolved to a literal id/key.  Literal fields are
 * passed through unchanged.  Unresolvable references collapse to `null`.
 */
export function resolveAssignmentRouting(
  cfg: AssignmentConfig,
  templateCapabilityId: string | null,
  instanceContext?: Record<string, unknown>,
): ResolvedRouting {
  const inferredMode = cfg.assignmentMode
    ?? (cfg.assignedToId ? 'DIRECT_USER'
      : cfg.teamId ? 'TEAM_QUEUE'
        : cfg.roleKey ? 'ROLE_BASED'
          : cfg.skillKey ? 'SKILL_BASED'
            : 'DIRECT_USER')
  const raw = inferredMode.toString()
  const mode = (VALID_MODES.includes(raw as AssignmentMode) ? raw : 'DIRECT_USER') as AssignmentMode

  const resolve = (v: string | undefined): string | null =>
    resolveAssignmentValue(v ?? null, instanceContext)

  return {
    mode,
    assignedToId: mode === 'DIRECT_USER' ? resolve(cfg.assignedToId) : null,
    teamId:       mode === 'TEAM_QUEUE'  ? resolve(cfg.teamId)       : null,
    roleKey:      mode === 'ROLE_BASED'  ? resolve(cfg.roleKey)      : null,
    skillKey:     mode === 'SKILL_BASED' ? resolve(cfg.skillKey)     : null,
    // ROLE_BASED *requires* a capability scope; other modes ignore it.
    capabilityId: mode === 'ROLE_BASED'  ? templateCapabilityId       : null,
  }
}

/**
 * Fail before persistence when a configured runtime selector did not resolve.
 * An unresolved placeholder must never become an unassigned task or an
 * approval that nobody can see. Empty selectors remain allowed for legacy
 * designs that intentionally create an operator-visible unassigned task.
 */
export function assertAssignmentResolved(
  cfg: AssignmentConfig,
  routing: ResolvedRouting,
  label: string,
): void {
  const raw = routing.mode === 'DIRECT_USER' ? cfg.assignedToId
    : routing.mode === 'TEAM_QUEUE' ? cfg.teamId
      : routing.mode === 'ROLE_BASED' ? cfg.roleKey
        : routing.mode === 'SKILL_BASED' ? cfg.skillKey
          : undefined
  const resolved = routing.mode === 'DIRECT_USER' ? routing.assignedToId
    : routing.mode === 'TEAM_QUEUE' ? routing.teamId
      : routing.mode === 'ROLE_BASED' ? routing.roleKey
        : routing.mode === 'SKILL_BASED' ? routing.skillKey
          : undefined
  if (raw && !resolved) {
    throw new Error(`${label} assignment value "${raw}" could not be resolved from the workflow instance context. Provide the runtime value before this node activates.`)
  }
  if (routing.mode === 'ROLE_BASED' && raw && !routing.capabilityId) {
    throw new Error(`${label} role routing requires the workflow to have a capability before the task activates.`)
  }
}

export async function mirrorTeamQueueRouting(routing: ResolvedRouting): Promise<ResolvedRouting> {
  if (routing.mode !== 'TEAM_QUEUE' || !routing.teamId) return routing
  return {
    ...routing,
    teamId: await resolveTeamIdForWorkflow(routing.teamId),
  }
}

// ─── Task — nested-create payload for prisma.task.create ─────────────────────

export function buildTaskAssignmentInputs(routing: ResolvedRouting): {
  assignmentMode: string
  assignments?: Prisma.TaskAssignmentCreateNestedManyWithoutTaskInput
  queueItems?:  Prisma.TeamQueueItemCreateNestedManyWithoutTaskInput
} {
  const out: ReturnType<typeof buildTaskAssignmentInputs> = {
    assignmentMode: routing.mode,
  }

  if (routing.mode === 'DIRECT_USER' && routing.assignedToId) {
    out.assignments = { create: { assignedToId: routing.assignedToId } }
  } else if (routing.mode === 'TEAM_QUEUE' && routing.teamId) {
    out.queueItems = { create: {
      teamId:         routing.teamId,
      assignmentMode: 'TEAM_QUEUE',
    } }
  } else if (routing.mode === 'ROLE_BASED' && routing.roleKey && routing.capabilityId) {
    out.queueItems = { create: {
      roleKey:        routing.roleKey,
      capabilityId:   routing.capabilityId,
      assignmentMode: 'ROLE_BASED',
    } }
  } else if (routing.mode === 'SKILL_BASED' && routing.skillKey) {
    out.queueItems = { create: {
      skillKey:       routing.skillKey,
      assignmentMode: 'SKILL_BASED',
    } }
  }

  return out
}

// ─── Approval / Consumable — flat fields stamped on the row itself ───────────

export function buildEntityRoutingFields(routing: ResolvedRouting): {
  assignmentMode: string
  assignedToId:   string | null
  teamId:         string | null
  roleKey:        string | null
  skillKey:       string | null
  capabilityId:   string | null
} {
  return {
    assignmentMode: routing.mode,
    assignedToId:   routing.assignedToId,
    teamId:         routing.teamId,
    roleKey:        routing.roleKey,
    skillKey:       routing.skillKey,
    capabilityId:   routing.capabilityId,
  }
}
