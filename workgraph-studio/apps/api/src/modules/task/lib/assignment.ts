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
//   {{vars.X}}     → context._vars.X   (template variable, possibly overridden per-instance)
//   {{globals.X}}  → context._globals.X (team-scoped global)
//   {{params.X}}   → context._params.X  (legacy alias of vars)
//   {{output.X}}   → context.X          (any node output merged into context)
//   {{context.X}}  → context.X          (raw path)
//   {{X}}          → context.X          (no prefix)
//
// A literal (no `{{ }}`) passes through unchanged.
// An unresolvable reference returns `null`, so the routing falls back gracefully
// (no Task assignment created, no queue row) — caller can audit / fail-soft.

const TEMPLATE_RE = /^\{\{\s*(.+?)\s*\}\}$/

function walkPath(root: Record<string, unknown> | undefined, path: string): unknown {
  if (!root) return undefined
  return path.split('.').reduce<unknown>((cur, key) => {
    if (cur && typeof cur === 'object') return (cur as Record<string, unknown>)[key]
    return undefined
  }, root)
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
  if (!m) return raw    // literal — pass through

  const ref = m[1]
  const ctx = context ?? {}
  let value: unknown
  if (ref.startsWith('vars.'))         value = walkPath(ctx._vars    as Record<string, unknown>, ref.slice('vars.'.length))
  else if (ref.startsWith('globals.')) value = walkPath(ctx._globals as Record<string, unknown>, ref.slice('globals.'.length))
  else if (ref.startsWith('params.'))  value = walkPath(ctx._params  as Record<string, unknown>, ref.slice('params.'.length))
  else if (ref.startsWith('output.'))  value = walkPath(ctx, ref.slice('output.'.length))
  else if (ref.startsWith('context.')) value = walkPath(ctx, ref.slice('context.'.length))
  else                                 value = walkPath(ctx, ref)

  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
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
  const raw = (cfg.assignmentMode ?? 'DIRECT_USER').toString()
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
