import { Prisma } from '@prisma/client'
import type { WorkflowInstance, WorkflowNode } from '@prisma/client'
import { randomBytes } from 'node:crypto'
import { prisma } from '../../lib/prisma'
import { logEvent, publishOutbox } from '../../lib/audit'
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors'
import { config } from '../../config'
import { authzCheck, listCapabilityRelationships, isCapabilityGoverning } from '../../lib/iam/client'
import { assertTemplatePermission } from '../../lib/permissions/workflowTemplate'
import { cloneDesignToRun } from '../workflow/lib/cloneDesignToRun'
import { getWorkflowBudgetOverview } from '../workflow/runtime/budget'
import { normalizeMetadataKey, recordOf, resolveMetadataSnapshot } from '../metadata/metadata.service'
import { tenantIdForCreate, tenantIsolationStrict } from '../../lib/tenant-isolation'

type KVPair = { key?: string; path?: string; value?: string }

export type WorkItemTargetInput = {
  targetCapabilityId: string
  childWorkflowTemplateId?: string
  roleKey?: string
}

export type CreateWorkItemInput = {
  title: string
  description?: string
  workItemTypeKey?: string
  routingMode?: 'MANUAL' | 'AUTO_ATTACH' | 'AUTO_START' | 'SCHEDULED_START'
  workflowTypeKey?: string
  scheduledAt?: string | Date | null
  notBefore?: string | Date | null
  sourceEventTypeKey?: string | null
  parentCapabilityId?: string | null
  sourceWorkflowInstanceId?: string | null
  sourceWorkflowNodeId?: string | null
  input?: Record<string, unknown>
  details?: Record<string, unknown>
  budget?: Record<string, unknown>
  urgency?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL'
  requiredBy?: string | Date | null
  originType?: 'PARENT_DELEGATED' | 'CAPABILITY_LOCAL'
  priority?: number
  dueAt?: string | Date | null
  targets: WorkItemTargetInput[]
}

const DONE_TARGET_STATUSES = new Set(['SUBMITTED', 'APPROVED'])
const DETACH_RESET_TARGET_STATUSES = ['QUEUED', 'CLAIMED', 'SUBMITTED', 'REWORK_REQUESTED', 'CANCELLED'] as const
const VALID_URGENCIES = new Set(['LOW', 'NORMAL', 'HIGH', 'CRITICAL'])

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function walk(root: Record<string, unknown>, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key]
    return undefined
  }, root)
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean)
  if (parts.length === 0) return
  let cursor = target
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    const next = cursor[key]
    if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[key] = {}
    cursor = cursor[key] as Record<string, unknown>
  }
  cursor[parts[parts.length - 1]] = value
}

function resolveRef(context: Record<string, unknown>, raw: string): unknown {
  const mustache = raw.match(/^\s*\{\{\s*(.+?)\s*\}\}\s*$/)
  const path = mustache ? mustache[1] : raw
  if (path.startsWith('vars.')) return walk(asRecord(context._vars), path.slice('vars.'.length))
  if (path.startsWith('globals.')) return walk(asRecord(context._globals), path.slice('globals.'.length))
  if (path.startsWith('params.')) return walk(asRecord(context._params), path.slice('params.'.length))
  if (path.startsWith('context.')) return walk(context, path.slice('context.'.length))
  if (path.startsWith('output.')) return walk(context, path.slice('output.'.length))
  return walk(context, path)
}

function resolveInputMap(context: Record<string, unknown>, cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const base = asRecord(cfg.input)
  for (const [key, value] of Object.entries(base)) setPath(out, key, value)

  const mappings = Array.isArray(cfg.assignments) ? cfg.assignments as KVPair[] : []
  for (const pair of mappings) {
    const key = (pair.key ?? '').trim()
    const value = (pair.value ?? pair.path ?? '').trim()
    if (!key || !value) continue
    setPath(out, key, resolveRef(context, value))
  }
  return out
}

async function generateWorkCode(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = `WRK-${randomBytes(3).toString('hex').slice(0, 5).toUpperCase()}`
    const existing = await prisma.workItem.findUnique({ where: { workCode: code }, select: { id: true } })
    if (!existing) return code
  }
  return `WRK-${Date.now().toString(36).slice(-5).toUpperCase()}`
}

function normalizeUrgency(value: unknown): 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL' {
  const raw = String(value ?? 'NORMAL').trim().toUpperCase()
  return VALID_URGENCIES.has(raw) ? raw as 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL' : 'NORMAL'
}

async function sourceCapabilityId(instance: WorkflowInstance): Promise<string | null> {
  if (!instance.templateId) return null
  const workflow = await prisma.workflow.findUnique({
    where: { id: instance.templateId },
    select: { capabilityId: true },
  })
  return workflow?.capabilityId ?? null
}

function normalizeTargets(cfg: Record<string, unknown>): WorkItemTargetInput[] {
  const std = asRecord(cfg.standard)
  const rows = Array.isArray(cfg.targets) ? cfg.targets
    : Array.isArray(cfg.workItemTargets) ? cfg.workItemTargets
    : []

  const targets = rows
    .map(row => asRecord(row))
    .map(row => ({
      targetCapabilityId: String(row.targetCapabilityId ?? row.capabilityId ?? '').trim(),
      childWorkflowTemplateId: String(row.childWorkflowTemplateId ?? row.templateId ?? '').trim() || undefined,
      roleKey: String(row.roleKey ?? '').trim() || undefined,
    }))
    .filter(row => row.targetCapabilityId)

  const singleTarget = String(std.targetCapabilityId ?? cfg.targetCapabilityId ?? '').trim()
  if (targets.length === 0 && singleTarget) {
    targets.push({
      targetCapabilityId: singleTarget,
      childWorkflowTemplateId: String(std.childWorkflowTemplateId ?? std.templateId ?? cfg.childWorkflowTemplateId ?? cfg.templateId ?? '').trim() || undefined,
      roleKey: String(std.roleKey ?? cfg.roleKey ?? '').trim() || undefined,
    })
  }
  return targets
}

export async function createWorkItem(input: CreateWorkItemInput, actorId?: string | null) {
  const targets = Array.isArray(input.targets) ? input.targets : []
  if (targets.length === 0) throw new ValidationError('WorkItem requires at least one child capability target')
  const dueAt = input.dueAt ? new Date(input.dueAt) : undefined
  const requiredBy = input.requiredBy ? new Date(input.requiredBy) : dueAt
  const originType = input.originType ?? (input.sourceWorkflowInstanceId || input.parentCapabilityId ? 'PARENT_DELEGATED' : 'CAPABILITY_LOCAL')
  const workCode = await generateWorkCode()
  const workItemTypeKey = normalizeMetadataKey(input.workItemTypeKey)
  const typeMeta = await resolveMetadataSnapshot({
    kind: 'WORK_ITEM_TYPE',
    key: workItemTypeKey,
    capabilityId: input.parentCapabilityId ?? targets[0]?.targetCapabilityId ?? null,
  })
  const typeDefaults = recordOf(typeMeta.snapshot?.defaults)
  const routingMode = input.routingMode ?? (
    ['MANUAL', 'AUTO_ATTACH', 'AUTO_START', 'SCHEDULED_START'].includes(String(typeDefaults.routingMode))
      ? typeDefaults.routingMode as CreateWorkItemInput['routingMode']
      : 'MANUAL'
  )
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : undefined
  const notBefore = input.notBefore ? new Date(input.notBefore) : undefined
  const isFutureScheduled = routingMode === 'SCHEDULED_START'
    && ((scheduledAt && scheduledAt.valueOf() > Date.now()) || (notBefore && notBefore.valueOf() > Date.now()))
  const workflowTypeKey = normalizeMetadataKey(input.workflowTypeKey ?? workItemTypeKey)

  const workItem = await prisma.workItem.create({
    data: {
      workCode,
      originType,
      workItemTypeKey,
      typeVersion: typeMeta.version,
      typeSnapshot: typeMeta.snapshot as Prisma.InputJsonValue,
      routingMode,
      scheduledAt,
      notBefore,
      sourceEventTypeKey: input.sourceEventTypeKey ? normalizeMetadataKey(input.sourceEventTypeKey) : undefined,
      routingState: 'UNROUTED',
      title: input.title,
      description: input.description,
      parentCapabilityId: input.parentCapabilityId ?? undefined,
      sourceWorkflowInstanceId: input.sourceWorkflowInstanceId ?? undefined,
      sourceWorkflowNodeId: input.sourceWorkflowNodeId ?? undefined,
      input: (input.input ?? {}) as Prisma.InputJsonValue,
      status: isFutureScheduled ? 'SCHEDULED' : 'QUEUED',
      details: (input.details ?? {
        title: input.title,
        description: input.description ?? null,
        workItemTypeKey,
        workflowTypeKey,
        routingMode,
        scheduledAt: scheduledAt?.toISOString() ?? null,
        notBefore: notBefore?.toISOString() ?? null,
        input: input.input ?? {},
      }) as Prisma.InputJsonValue,
      budget: (input.budget ?? recordOf(typeDefaults.budget)) as Prisma.InputJsonValue,
      urgency: normalizeUrgency(input.urgency ?? typeDefaults.urgency),
      requiredBy,
      detailsLocked: true,
      priority: input.priority ?? Number(typeDefaults.priority ?? 50),
      dueAt,
      createdById: actorId ?? undefined,
      targets: {
        create: targets.map(target => ({
          targetCapabilityId: target.targetCapabilityId,
          childWorkflowTemplateId: target.childWorkflowTemplateId,
          roleKey: target.roleKey,
        })),
      },
    },
    include: { targets: true, events: true },
  })

  await prisma.workItemEvent.create({
    data: {
      workItemId: workItem.id,
      eventType: 'CREATED',
      actorId: actorId ?? undefined,
      payload: {
        workCode: workItem.workCode,
        originType: workItem.originType,
        workItemTypeKey,
        routingMode,
        sourceEventTypeKey: workItem.sourceEventTypeKey,
        targetCount: workItem.targets.length,
      } as Prisma.InputJsonValue,
    },
  })
  if (isFutureScheduled) {
    await prisma.workItemEvent.create({
      data: {
        workItemId: workItem.id,
        eventType: 'SCHEDULED',
        actorId: actorId ?? undefined,
        payload: { scheduledAt: scheduledAt?.toISOString(), notBefore: notBefore?.toISOString() } as Prisma.InputJsonValue,
      },
    })
  }
  await logEvent('WorkItemCreated', 'WorkItem', workItem.id, actorId ?? undefined, {
    workCode: workItem.workCode,
    originType: workItem.originType,
    workItemTypeKey,
    routingMode,
    parentCapabilityId: input.parentCapabilityId,
    sourceWorkflowInstanceId: input.sourceWorkflowInstanceId,
    sourceWorkflowNodeId: input.sourceWorkflowNodeId,
    targetCount: workItem.targets.length,
  })
  await publishOutbox('WorkItem', workItem.id, 'WorkItemCreated', { workItemId: workItem.id })
  return workItem
}

export async function activateWorkItem(node: WorkflowNode, instance: WorkflowInstance, actorId?: string): Promise<void> {
  const cfg = asRecord(node.config)
  if (typeof cfg._workItemId === 'string' && cfg._workItemId) return

  const std = asRecord(cfg.standard)
  let targets = normalizeTargets(cfg)
  // M101 (Epic→child) — B5: reactive targets. When the template declares
  // `standard.targetsPath` (e.g. 'workItem.impactedChildren') and no static
  // targets are configured, resolve the target list from the instance CONTEXT
  // at activation time. This lets the impl WORK_ITEM node dispatch to exactly
  // the children a prior impact-analysis WORK_ITEM found impacted (B4). The
  // template's DECISION_GATE ("any impacted?") guards against reaching this
  // node with zero targets (createWorkItem still rejects an empty list).
  const targetsPath = String(std.targetsPath ?? cfg.targetsPath ?? '').trim()
  if (targets.length === 0 && targetsPath) {
    const resolved = walk(asRecord(instance.context), targetsPath)
    targets = normalizeTargets({ targets: Array.isArray(resolved) ? resolved : [] })
  }
  const parentCapabilityId = await sourceCapabilityId(instance)
  // M101 (Epic→child) — B3: dynamic child discovery. When the template
  // declares `standard.discoverChildren: { relationshipType }` and no targets
  // were statically or reactively resolved, query IAM's capability-relationship
  // graph for the source (Epic) capability and dispatch to each related child.
  // relationshipType filters the graph (convention, e.g. 'decomposes_to'); the
  // per-child IMPACT_ANALYSIS routing policy then selects each child's workflow.
  const discover = asRecord(std.discoverChildren ?? cfg.discoverChildren)
  if (targets.length === 0 && Object.keys(discover).length > 0 && parentCapabilityId) {
    const relType = String(discover.relationshipType ?? discover.type ?? '').trim()
    const rels = await listCapabilityRelationships(parentCapabilityId).catch(() => [])
    const seen = new Set<string>()
    targets = rels
      .filter(r => !relType || r.relationship_type === relType)
      .map(r => r.target_capability_id)
      .filter(id => typeof id === 'string' && id.trim() && !seen.has(id) && (seen.add(id), true))
      .map(id => ({ targetCapabilityId: id }))
  }
  // Capability Governance Model — routing guard. Governing capabilities (boards,
  // compliance bodies, standards groups) GOVERN work; they never RECEIVE delivery
  // work. Exclude any governing capability from the dispatch targets, across all
  // three resolution paths (static / reactive / discovered). Fail-open: a
  // governance lookup must never block legitimate delivery routing.
  if (targets.length > 0) {
    const kept: typeof targets = []
    for (const t of targets) {
      if (await isCapabilityGoverning(t.targetCapabilityId)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[governance] excluded governing capability ${t.targetCapabilityId} from ` +
          `work-item targets (instance=${instance.id}, node=${node.id})`,
        )
        continue
      }
      kept.push(t)
    }
    targets = kept
  }
  const title = String(std.title ?? cfg.title ?? node.label ?? 'Delegated work item').trim()
  const description = String(std.description ?? cfg.description ?? '').trim() || undefined
  const priority = Number(std.priority ?? cfg.priority ?? 50)
  const dueAtRaw = std.dueAt ?? cfg.dueAt
  const requiredByRaw = std.requiredBy ?? cfg.requiredBy ?? dueAtRaw
  const urgency = normalizeUrgency(std.urgency ?? cfg.urgency)
  const budget = asRecord(std.budget ?? cfg.budget)
  const input = resolveInputMap(asRecord(instance.context), cfg)

  const workItem = await createWorkItem({
    title,
    // M101 (Epic→child) — carry the node-declared work-item type so the
    // per-child routing policy (capability + workItemTypeKey) selects the
    // right child workflow (e.g. IMPACT_ANALYSIS vs STORY_IMPL). Absent →
    // createWorkItem falls back to its metadata default (GENERAL).
    workItemTypeKey: String(std.workItemTypeKey ?? cfg.workItemTypeKey ?? '').trim() || undefined,
    description,
    parentCapabilityId,
    sourceWorkflowInstanceId: instance.id,
    sourceWorkflowNodeId: node.id,
    input,
    details: {
      title,
      description: description ?? null,
      source: 'workflow',
      workflowInstanceId: instance.id,
      workflowNodeId: node.id,
      input,
    },
    budget,
    urgency,
    requiredBy: typeof requiredByRaw === 'string' ? requiredByRaw : null,
    originType: 'PARENT_DELEGATED',
    priority: Number.isFinite(priority) ? priority : 50,
    dueAt: typeof dueAtRaw === 'string' ? dueAtRaw : null,
    targets,
  }, actorId ?? instance.createdById ?? null)

  await prisma.workflowNode.update({
    where: { id: node.id },
    data: { config: { ...cfg, _workItemId: workItem.id } as Prisma.InputJsonValue },
  })

  // M101 (Epic→child) — route the freshly-created WorkItem so AUTO_START /
  // AUTO_ATTACH children actually spawn. The HTTP create path (work-items
  // router) routes explicitly after createWorkItem; the WORK_ITEM-node path
  // (this function) must do it too, otherwise the discovered child capability
  // targets stay QUEUED and never start their workflows. routeWorkItem is
  // SINGLE-target (defaults to targets[0]), so for a fan-out WorkItem we must
  // route EACH target by id. Lazy import keeps the module graph acyclic.
  // MANUAL WorkItems are left QUEUED for an operator.
  if (workItem.routingMode === 'AUTO_START' || workItem.routingMode === 'AUTO_ATTACH') {
    const { routeWorkItem } = await import('./work-item-routing.service')
    for (const t of workItem.targets) {
      await routeWorkItem(workItem.id, actorId ?? instance.createdById ?? null, { targetId: t.id, routingMode: workItem.routingMode })
    }
  }
}

async function loadActor(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, iamUserId: true, roles: { include: { role: { select: { name: true } } } } },
  })
}

export async function assertCanClaimWorkItemTarget(userId: string, targetCapabilityId: string, resourceId: string): Promise<void> {
  if (config.AUTH_PROVIDER !== 'iam') return
  const actor = await loadActor(userId)
  const isAdmin = actor?.roles.some(r => ['ADMIN', 'SYSTEM_ADMIN', 'WORKFLOW_ADMIN'].includes(r.role.name)) ?? false
  if (isAdmin) return
  if (!actor?.iamUserId) throw new ForbiddenError('IAM identity is required to claim this WorkItem')
  const result = await authzCheck(actor.iamUserId, targetCapabilityId, 'claim_task', {
    resourceType: 'WorkItemTarget',
    resourceId,
  })
  if (!result.allowed) throw new ForbiddenError('User is not eligible to claim WorkItems for this capability')
}

type WorkItemViewRow = {
  id: string
  parentCapabilityId: string | null
  createdById: string | null
  approvedById?: string | null
  targets: Array<{
    id: string
    targetCapabilityId: string
    claimedById: string | null
  }>
}

export async function canViewWorkItem(userId: string, workItem: WorkItemViewRow): Promise<boolean> {
  if (config.AUTH_PROVIDER !== 'iam') return true
  if (workItem.createdById === userId || workItem.approvedById === userId) return true
  if (workItem.targets.some(t => t.claimedById === userId)) return true

  const actor = await loadActor(userId)
  const isAdmin = actor?.roles.some(r => ['ADMIN', 'SYSTEM_ADMIN', 'WORKFLOW_ADMIN'].includes(r.role.name)) ?? false
  if (isAdmin) return true
  if (!actor?.iamUserId) return false

  for (const target of workItem.targets) {
    const result = await authzCheck(actor.iamUserId, target.targetCapabilityId, 'claim_task', {
      resourceType: 'WorkItemTarget',
      resourceId: target.id,
    }).catch(() => ({ allowed: false }))
    if (result.allowed) return true
  }
  return false
}

export async function assertCanViewWorkItem(userId: string, workItem: WorkItemViewRow): Promise<void> {
  if (!(await canViewWorkItem(userId, workItem))) {
    throw new ForbiddenError('User is not eligible to view this WorkItem')
  }
}

// Statuses whose work item may still be edited. Terminal states are frozen.
const EDITABLE_WORK_ITEM_STATUSES = new Set(['SCHEDULED', 'QUEUED', 'IN_PROGRESS'])
const TERMINAL_WORK_ITEM_STATUSES = new Set(['AWAITING_PARENT_APPROVAL', 'COMPLETED', 'CANCELLED', 'ARCHIVED'])
// Allowed status transitions from an editable state (manual edits only — the
// lifecycle engine owns IN_PROGRESS→COMPLETED etc.). Re-queue and cancel are
// the operator-meaningful ones; SCHEDULED↔QUEUED toggles scheduling.
const ALLOWED_STATUS_EDITS: Record<string, Set<string>> = {
  SCHEDULED:   new Set(['QUEUED', 'CANCELLED']),
  QUEUED:      new Set(['SCHEDULED', 'CANCELLED']),
  IN_PROGRESS: new Set(['CANCELLED']),
}

export interface UpdateWorkItemInput {
  title?: string
  description?: string | null
  priority?: number
  dueAt?: string | null
  details?: Record<string, unknown>
  status?: string
}

/**
 * Edit a non-terminal work item (review-requested feature). Guardrails:
 *   - only SCHEDULED / QUEUED / IN_PROGRESS may be edited; terminal states 409.
 *   - caller must be eligible to view (ownership/role) the item.
 *   - details may change ONLY when detailsLocked is false (the engine locks
 *     details once it has bound them to a run/prompt).
 *   - status may change only along ALLOWED_STATUS_EDITS (no skipping the
 *     lifecycle engine into COMPLETED, etc.).
 * Emits a WorkItemEdited event + outbox for the audit trail.
 */
export async function updateWorkItem(workItemId: string, userId: string, input: UpdateWorkItemInput) {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    include: { targets: true },
  })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  await assertCanViewWorkItem(userId, workItem)

  if (!EDITABLE_WORK_ITEM_STATUSES.has(workItem.status)) {
    throw new ValidationError(
      `WorkItem in status ${workItem.status} is not editable`
      + (TERMINAL_WORK_ITEM_STATUSES.has(workItem.status) ? ' (terminal)' : ''),
    )
  }

  const data: Prisma.WorkItemUpdateInput = {}
  const changed: string[] = []

  if (input.title !== undefined) {
    const t = input.title.trim()
    if (!t) throw new ValidationError('title cannot be empty')
    if (t !== workItem.title) { data.title = t; changed.push('title') }
  }
  if (input.description !== undefined && (input.description ?? null) !== (workItem.description ?? null)) {
    data.description = input.description ?? null
    changed.push('description')
  }
  if (input.priority !== undefined && input.priority !== workItem.priority) {
    if (!Number.isInteger(input.priority)) throw new ValidationError('priority must be an integer')
    data.priority = input.priority
    changed.push('priority')
  }
  if (input.dueAt !== undefined) {
    const next = input.dueAt ? new Date(input.dueAt) : null
    if (next && Number.isNaN(next.getTime())) throw new ValidationError('dueAt must be a valid date')
    data.dueAt = next
    changed.push('dueAt')
  }
  if (input.details !== undefined) {
    if (workItem.detailsLocked) {
      throw new ValidationError('WorkItem details are locked and cannot be edited')
    }
    data.details = input.details as Prisma.InputJsonValue
    changed.push('details')
  }
  if (input.status !== undefined && input.status !== workItem.status) {
    const allowed = ALLOWED_STATUS_EDITS[workItem.status]
    if (!allowed || !allowed.has(input.status)) {
      throw new ValidationError(`Cannot change status ${workItem.status} → ${input.status}`)
    }
    data.status = input.status as never
    changed.push('status')
  }

  if (changed.length === 0) {
    // Nothing to do — return the current shape so the caller stays simple.
    return prisma.workItem.findUniqueOrThrow({
      where: { id: workItemId },
      include: {
        targets: { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
        clarifications: { orderBy: { createdAt: 'asc' } },
      },
    })
  }

  const updated = await prisma.workItem.update({
    where: { id: workItemId },
    data,
    include: {
      targets: { orderBy: { createdAt: 'asc' } },
      events: { orderBy: { createdAt: 'asc' } },
      clarifications: { orderBy: { createdAt: 'asc' } },
    },
  })
  // NB: WorkItemEvent.eventType is a DB enum with no EDITED member, so we
  // record the edit via the free-string audit log + outbox rather than adding
  // an enum value (which would need a migration). Audit trail is preserved.
  await logEvent('WorkItemEdited', 'WorkItem', workItemId, userId, { fields: changed })
  await publishOutbox('WorkItem', workItemId, 'WorkItemEdited', { workItemId, fields: changed })
  return updated
}

export async function claimWorkItemTarget(workItemId: string, targetId: string, userId: string) {
  const target = await prisma.workItemTarget.findFirst({
    where: { id: targetId, workItemId },
    include: { workItem: true },
  })
  if (!target) throw new NotFoundError('WorkItemTarget', targetId)
  if (target.claimedById && target.claimedById !== userId) throw new ValidationError('WorkItem target is already claimed')
  if (!['QUEUED', 'REWORK_REQUESTED'].includes(target.status) && target.claimedById !== userId) {
    throw new ValidationError(`WorkItem target cannot be claimed from status ${target.status}`)
  }
  await assertCanClaimWorkItemTarget(userId, target.targetCapabilityId, target.id)

  const updated = await prisma.workItemTarget.update({
    where: { id: target.id },
    data: { status: 'CLAIMED', claimedById: userId, claimedAt: new Date() },
  })
  await prisma.workItem.update({ where: { id: workItemId }, data: { status: 'IN_PROGRESS' } })
  await prisma.workItemEvent.create({
    data: { workItemId, targetId, eventType: 'CLAIMED', actorId: userId },
  })
  await logEvent('WorkItemTargetClaimed', 'WorkItemTarget', targetId, userId, { workItemId })
  await publishOutbox('WorkItemTarget', targetId, 'WorkItemTargetClaimed', { workItemId, targetId })
  return updated
}

export async function archiveWorkItem(workItemId: string, userId: string) {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    include: { targets: true },
  })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  await assertCanViewWorkItem(userId, workItem)
  if (workItem.originType !== 'CAPABILITY_LOCAL') {
    throw new ValidationError('Only capability-created WorkItems can be archived. Parent-delegated WorkItems must be returned, completed, or cancelled by the parent capability.')
  }
  if (workItem.status === 'ARCHIVED') {
    return prisma.workItem.findUniqueOrThrow({
      where: { id: workItemId },
      include: {
        targets: { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
        clarifications: { orderBy: { createdAt: 'asc' } },
      },
    })
  }

  const activeTarget = workItem.targets.find(target =>
    target.childWorkflowInstanceId && ['IN_PROGRESS', 'SUBMITTED'].includes(target.status),
  )
  if (activeTarget) {
    throw new ValidationError('This WorkItem has an active or submitted workflow target. Finish, cancel, or close that run before archiving.')
  }

  const archived = await prisma.$transaction(async tx => {
    await tx.workItemTarget.updateMany({
      where: {
        workItemId,
        status: { in: ['QUEUED', 'CLAIMED', 'REWORK_REQUESTED'] },
      },
      data: { status: 'CANCELLED' },
    })
    await tx.workItemEvent.create({
      data: {
        workItemId,
        eventType: 'ARCHIVED',
        actorId: userId,
        payload: {
          previousStatus: workItem.status,
          originType: workItem.originType,
          archivedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    })
    return tx.workItem.update({
      where: { id: workItemId },
      data: { status: 'ARCHIVED' },
      include: {
        targets: { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
        clarifications: { orderBy: { createdAt: 'asc' } },
      },
    })
  })

  await logEvent('WorkItemArchived', 'WorkItem', workItemId, userId, {
    workCode: workItem.workCode,
    previousStatus: workItem.status,
    originType: workItem.originType,
  })
  await publishOutbox('WorkItem', workItemId, 'WorkItemArchived', { workItemId })
  return archived
}

export async function detachWorkItemFromWorkflow(workItemId: string, userId: string, reason?: string) {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    include: { targets: true },
  })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  await assertCanViewWorkItem(userId, workItem)
  if (!workItem.sourceWorkflowInstanceId && !workItem.sourceWorkflowNodeId && workItem.originType === 'CAPABILITY_LOCAL') {
    return prisma.workItem.findUniqueOrThrow({
      where: { id: workItemId },
      include: {
        targets: { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
        clarifications: { orderBy: { createdAt: 'asc' } },
      },
    })
  }
  if (['COMPLETED', 'ARCHIVED'].includes(workItem.status)) {
    throw new ValidationError(`WorkItem cannot be detached from status ${workItem.status}`)
  }

  const activeTarget = workItem.targets.find(target =>
    target.childWorkflowInstanceId && target.status === 'IN_PROGRESS',
  )
  if (activeTarget) {
    throw new ValidationError('This WorkItem has an active child workflow target. Finish or cancel that run before detaching.')
  }

  const sourceWorkflowInstanceId = workItem.sourceWorkflowInstanceId
  const sourceWorkflowNodeId = workItem.sourceWorkflowNodeId
  const previousDetails = asRecord(workItem.details)
  const detachedAt = new Date().toISOString()
  const nextDetails = {
    ...previousDetails,
    ...(previousDetails.source !== undefined ? { previousSource: previousDetails.source } : {}),
    source: 'detached-workflow',
    detachedFromWorkflow: {
      workflowInstanceId: sourceWorkflowInstanceId,
      workflowNodeId: sourceWorkflowNodeId,
      originType: workItem.originType,
      status: workItem.status,
      detachedAt,
      detachedById: userId,
      ...(reason?.trim() ? { reason: reason.trim() } : {}),
    },
  }

  const detached = await prisma.$transaction(async tx => {
    if (sourceWorkflowNodeId) {
      const sourceNode = await tx.workflowNode.findUnique({
        where: { id: sourceWorkflowNodeId },
        select: { config: true },
      })
      const cfg = asRecord(sourceNode?.config)
      if (cfg._workItemId === workItemId) {
        const nextConfig = { ...cfg }
        delete nextConfig._workItemId
        await tx.workflowNode.update({
          where: { id: sourceWorkflowNodeId },
          data: { config: nextConfig as Prisma.InputJsonValue },
        })
      }
    }
    if (workItem.parentApprovalRequestId) {
      await tx.approvalRequest.updateMany({
        where: { id: workItem.parentApprovalRequestId, status: 'PENDING' },
        data: { status: 'DEFERRED' },
      })
    }

    await tx.workItemTarget.updateMany({
      where: {
        workItemId,
        status: { in: [...DETACH_RESET_TARGET_STATUSES] },
      },
      data: {
        status: 'QUEUED',
        claimedById: null,
        claimedAt: null,
        childWorkflowInstanceId: null,
        startedAt: null,
        submittedAt: null,
        completedAt: null,
        output: Prisma.DbNull,
      },
    })
    // Task #81 — mark BlueprintSessions tied to the source workflow as
    // ABANDONED so the workbench's "pick up where you left off" discovery
    // skips them. Only touches sessions still in pre-terminal states (DRAFT,
    // SNAPSHOTTED, RUNNING) — sessions that completed, were approved, or
    // failed already carry their final state for audit and shouldn't be
    // retro-marked.
    //
    // Without this, the next time the operator attaches this WorkItem to a
    // workflow and starts a run, the workbench loads the OLD session (latest
    // by updatedAt) and shows stale agent output, partial receipts, and the
    // pre-detach phase state. The user's bug report: "once i detach a
    // workitem from a workflow and then attach back and start then the
    // workbench should be new."
    let abandonedSessionCount = 0
    if (sourceWorkflowInstanceId) {
      const abandoned = await tx.blueprintSession.updateMany({
        where: {
          workflowInstanceId: sourceWorkflowInstanceId,
          status: { in: ['DRAFT', 'SNAPSHOTTED', 'RUNNING'] },
        },
        data: { status: 'ABANDONED' },
      })
      abandonedSessionCount = abandoned.count
    }

    await tx.workItemEvent.create({
      data: {
        workItemId,
        eventType: 'DETACHED',
        actorId: userId,
        payload: {
          ...(reason?.trim() ? { reason: reason.trim() } : {}),
          previousStatus: workItem.status,
          previousOriginType: workItem.originType,
          sourceWorkflowInstanceId,
          sourceWorkflowNodeId,
          parentApprovalRequestId: workItem.parentApprovalRequestId,
          detachedAt,
          abandonedSessionCount,
        } as Prisma.InputJsonValue,
      },
    })
    return tx.workItem.update({
      where: { id: workItemId },
      data: {
        originType: 'CAPABILITY_LOCAL',
        sourceWorkflowInstanceId: null,
        sourceWorkflowNodeId: null,
        parentApprovalRequestId: null,
        approvedById: null,
        finalOutput: Prisma.DbNull,
        status: 'QUEUED',
        detailsLocked: false,
        details: nextDetails as Prisma.InputJsonValue,
      },
      include: {
        targets: { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
        clarifications: { orderBy: { createdAt: 'asc' } },
      },
    })
  })

  await logEvent('WorkItemDetached', 'WorkItem', workItemId, userId, {
    workCode: workItem.workCode,
    previousStatus: workItem.status,
    previousOriginType: workItem.originType,
    sourceWorkflowInstanceId,
    sourceWorkflowNodeId,
  })
  await publishOutbox('WorkItem', workItemId, 'WorkItemDetached', { workItemId })
  return detached
}

export async function detachWorkItemTargetFromWorkflow(
  workItemId: string,
  targetId: string,
  userId: string,
  reason?: string,
) {
  const target = await prisma.workItemTarget.findFirst({
    where: { id: targetId, workItemId },
    include: { workItem: { include: { targets: true } } },
  })
  if (!target) throw new NotFoundError('WorkItemTarget', targetId)
  await assertCanViewWorkItem(userId, target.workItem)
  if (['COMPLETED', 'ARCHIVED'].includes(target.workItem.status)) {
    throw new ValidationError(`WorkItem target cannot be detached when WorkItem is ${target.workItem.status}`)
  }
  if (!target.childWorkflowInstanceId) {
    throw new ValidationError('This WorkItem target is not attached to a workflow run')
  }
  if (['SUBMITTED', 'APPROVED'].includes(target.status)) {
    throw new ValidationError(`WorkItem target cannot be detached from status ${target.status}. Request rework instead.`)
  }

  const detachedAt = new Date().toISOString()
  const childWorkflowInstanceId = target.childWorkflowInstanceId
  const remainingLinkedTargets = target.workItem.targets.filter(t => t.id !== targetId)
  const hasOtherActiveTargets = remainingLinkedTargets.some(t =>
    ['IN_PROGRESS', 'SUBMITTED', 'APPROVED'].includes(t.status),
  )

  const detached = await prisma.$transaction(async tx => {
    const childInstance = await tx.workflowInstance.findUnique({
      where: { id: childWorkflowInstanceId },
      select: { context: true },
    })
    if (childInstance) {
      const context = asRecord(childInstance.context)
      const workItemRef = asRecord(context._workItem)
      const detachedRef = {
        ...workItemRef,
        id: workItemRef.id ?? workItemId,
        targetId: workItemRef.targetId ?? targetId,
        detachedAt,
        detachedById: userId,
        ...(reason?.trim() ? { reason: reason.trim() } : {}),
      }
      const detachedRefs = Array.isArray(context._detachedWorkItems)
        ? context._detachedWorkItems.filter(item => item && typeof item === 'object')
        : []
      context._detachedWorkItems = [...detachedRefs, detachedRef]
      if (workItemRef.id === workItemId || workItemRef.targetId === targetId) {
        delete context._workItem
      }
      await tx.workflowInstance.update({
        where: { id: childWorkflowInstanceId },
        data: { context: context as Prisma.InputJsonValue },
      })
    }

    await tx.workItemTarget.update({
      where: { id: targetId },
      data: {
        status: 'QUEUED',
        claimedById: null,
        claimedAt: null,
        childWorkflowInstanceId: null,
        startedAt: null,
        submittedAt: null,
        completedAt: null,
        output: Prisma.DbNull,
      },
    })
    await tx.workItem.update({
      where: { id: workItemId },
      data: {
        status: hasOtherActiveTargets ? target.workItem.status : 'QUEUED',
        parentApprovalRequestId: hasOtherActiveTargets ? target.workItem.parentApprovalRequestId : null,
      },
    })
    await tx.workItemEvent.create({
      data: {
        workItemId,
        targetId,
        eventType: 'DETACHED',
        actorId: userId,
        payload: {
          scope: 'child_workflow_target',
          ...(reason?.trim() ? { reason: reason.trim() } : {}),
          previousStatus: target.status,
          childWorkflowInstanceId,
          childWorkflowTemplateId: target.childWorkflowTemplateId,
          detachedAt,
        } as Prisma.InputJsonValue,
      },
    })
    return tx.workItem.findUniqueOrThrow({
      where: { id: workItemId },
      include: {
        targets: { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
        clarifications: { orderBy: { createdAt: 'asc' } },
      },
    })
  })

  await logEvent('WorkItemTargetDetached', 'WorkItemTarget', targetId, userId, {
    workItemId,
    workCode: target.workItem.workCode,
    previousStatus: target.status,
    childWorkflowInstanceId,
  })
  await publishOutbox('WorkItemTarget', targetId, 'WorkItemTargetDetached', {
    workItemId,
    targetId,
    childWorkflowInstanceId,
  })
  return detached
}

export async function startWorkItemTarget(
  workItemId: string,
  targetId: string,
  userId: string,
  options: { childWorkflowTemplateId?: string } = {},
) {
  const target = await prisma.workItemTarget.findFirst({
    where: { id: targetId, workItemId },
    include: { workItem: true },
  })
  if (!target) throw new NotFoundError('WorkItemTarget', targetId)
  if (target.claimedById !== userId) throw new ValidationError('Claim this WorkItem target before starting it')
  const templateId = options.childWorkflowTemplateId ?? target.childWorkflowTemplateId
  if (!templateId) throw new ValidationError('Choose a workflow template before starting this WorkItem target')
  if (target.childWorkflowInstanceId) throw new ValidationError('This WorkItem target already has a child workflow run')

  await assertTemplatePermission(userId, templateId, 'start')

  // M93.C — Refuse workbench-profile templates at the API boundary. Even
  // though M93.C filters them out of the UI dropdown, an older client or
  // a direct API caller could still POST a workbench template id here.
  // Starting one as a WorkItem's child produces a workbench-profile
  // WorkflowInstance that no surface knows how to open: blueprint-
  // workbench refuses non-bound sessions (M85.s5) and RunViewerPage
  // isn't designed for the loop-stage view. Workbench templates run
  // nested via a parent main workflow's CALL_WORKFLOW node, whose
  // executor copies template.profile to the child instance (M85.s4).
  const startedTemplate = await prisma.workflow.findUnique({
    where: { id: templateId },
    select: { profile: true, name: true },
  })
  if (startedTemplate?.profile === 'workbench') {
    throw new ValidationError(
      `"${startedTemplate.name}" is a workbench-profile template — it can only run as a sub-workflow ` +
      `inside a main workflow's CALL_WORKFLOW node. Pick a main-profile template, or create a main ` +
      `workflow whose CALL_WORKFLOW node points at this workbench template.`,
    )
  }
  const vars = {
    ...asRecord(target.workItem.input),
    workItemId,
    workCode: target.workItem.workCode,
    workItemTargetId: targetId,
    workItemTypeKey: target.workItem.workItemTypeKey,
    routingMode: target.workItem.routingMode,
    parentCapabilityId: target.workItem.parentCapabilityId,
    targetCapabilityId: target.targetCapabilityId,
    workItemUrgency: target.workItem.urgency,
    workItemRequiredBy: target.workItem.requiredBy?.toISOString(),
    workItemDetails: target.workItem.details,
    workItemBudget: target.workItem.budget,
  }
  const tenantId = tenantIdForCreate({
    _vars: vars,
    _workItem: {
      id: workItemId,
      targetId,
      input: target.workItem.input,
      details: target.workItem.details,
    },
  })
  if (tenantIsolationStrict() && !tenantId) {
    throw new ValidationError('TENANT_ISOLATION_MODE=strict requires tenantId/tenant_id in WorkItem input before starting a child workflow run')
  }

  // Finding #10 — atomically reserve the target before cloning so concurrent starts
  // can't both create a run (see startAttachedTarget). The loser throws rather than
  // double-starting.
  const reservation = await prisma.workItemTarget.updateMany({
    where: { id: targetId, workItemId, childWorkflowInstanceId: null, startedAt: null },
    data: { startedAt: new Date() },
  })
  if (reservation.count === 0) {
    throw new ValidationError('This WorkItem target is already started or being started')
  }

  const result = await (async () => {
    try {
      return await cloneDesignToRun({
        templateId,
        name: `${target.workItem.workCode} · ${target.workItem.title}`,
        vars,
        createdById: userId,
      })
    } catch (err) {
      // Release the reservation so a later retry can start this target.
      await prisma.workItemTarget.updateMany({
        where: { id: targetId, childWorkflowInstanceId: null },
        data: { startedAt: null },
      })
      throw err
    }
  })()

  const instance = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: result.instance.id } })
  const context = asRecord(instance.context)
  context._workItem = {
    id: workItemId,
    workCode: target.workItem.workCode,
    targetId,
    workItemTypeKey: target.workItem.workItemTypeKey,
    routingMode: target.workItem.routingMode,
    originType: target.workItem.originType,
    parentCapabilityId: target.workItem.parentCapabilityId,
    targetCapabilityId: target.targetCapabilityId,
    tenantId: tenantId ?? null,
    sourceWorkflowInstanceId: target.workItem.sourceWorkflowInstanceId,
    sourceWorkflowNodeId: target.workItem.sourceWorkflowNodeId,
    input: target.workItem.input,
    details: target.workItem.details,
    budget: target.workItem.budget,
    urgency: target.workItem.urgency,
    requiredBy: target.workItem.requiredBy?.toISOString(),
    detailsLocked: target.workItem.detailsLocked,
  }
  await prisma.workflowInstance.update({
    where: { id: result.instance.id },
    data: { context: context as Prisma.InputJsonValue },
  })

  const updated = await prisma.workItemTarget.update({
    where: { id: target.id },
    data: {
      status: 'IN_PROGRESS',
      childWorkflowTemplateId: templateId,
      childWorkflowInstanceId: result.instance.id,
      startedAt: new Date(),
    },
  })
  await prisma.workItemEvent.create({
    data: {
      workItemId,
      targetId,
      eventType: 'STARTED',
      actorId: userId,
      payload: { childWorkflowInstanceId: result.instance.id, childWorkflowTemplateId: templateId } as Prisma.InputJsonValue,
    },
  })
  await logEvent('WorkItemTargetStarted', 'WorkItemTarget', targetId, userId, {
    workItemId,
    childWorkflowInstanceId: result.instance.id,
  })

  const { startInstance } = await import('../workflow/runtime/WorkflowRuntime')
  await startInstance(result.instance.id, userId)
  return { target: updated, childWorkflowInstanceId: result.instance.id }
}

export async function requestWorkItemClarification(
  workItemId: string,
  targetId: string | undefined,
  userId: string,
  question: string,
) {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    include: { targets: true },
  })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  await assertCanViewWorkItem(userId, workItem)
  const target = targetId ? workItem.targets.find(t => t.id === targetId) : undefined
  if (targetId && !target) throw new NotFoundError('WorkItemTarget', targetId)
  const text = question.trim()
  if (!text) throw new ValidationError('Clarification question is required')

  const clarification = await prisma.workItemClarification.create({
    data: {
      workItemId,
      targetId,
      direction: 'CHILD_TO_PARENT',
      question: text,
      requestedById: userId,
      payload: { workCode: workItem.workCode } as Prisma.InputJsonValue,
    },
  })
  await prisma.workItemEvent.create({
    data: {
      workItemId,
      targetId,
      eventType: 'CLARIFICATION_REQUESTED',
      actorId: userId,
      payload: { clarificationId: clarification.id, question: text } as Prisma.InputJsonValue,
    },
  })
  await logEvent('WorkItemClarificationRequested', 'WorkItem', workItemId, userId, {
    workCode: workItem.workCode,
    targetId,
    clarificationId: clarification.id,
  })
  await publishOutbox('WorkItem', workItemId, 'WorkItemClarificationRequested', {
    workItemId,
    targetId,
    clarificationId: clarification.id,
  })
  return clarification
}

export async function answerWorkItemClarification(
  workItemId: string,
  clarificationId: string,
  userId: string,
  answer: string,
) {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    include: { targets: true },
  })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  await assertCanViewWorkItem(userId, workItem)
  const text = answer.trim()
  if (!text) throw new ValidationError('Clarification answer is required')

  const clarification = await prisma.workItemClarification.update({
    where: { id: clarificationId },
    data: {
      status: 'ANSWERED',
      answer: text,
      answeredById: userId,
      answeredAt: new Date(),
    },
  })
  await prisma.workItemEvent.create({
    data: {
      workItemId,
      targetId: clarification.targetId,
      eventType: 'CLARIFICATION_ANSWERED',
      actorId: userId,
      payload: { clarificationId, answer: text } as Prisma.InputJsonValue,
    },
  })
  await logEvent('WorkItemClarificationAnswered', 'WorkItem', workItemId, userId, {
    workCode: workItem.workCode,
    targetId: clarification.targetId,
    clarificationId,
  })
  await publishOutbox('WorkItem', workItemId, 'WorkItemClarificationAnswered', {
    workItemId,
    targetId: clarification.targetId,
    clarificationId,
  })
  return clarification
}

async function buildChildOutput(instance: WorkflowInstance): Promise<Record<string, unknown>> {
  const [consumables, budget] = await Promise.all([
    prisma.consumable.findMany({
      where: { instanceId: instance.id },
      select: { id: true, name: true, status: true, currentVersion: true, nodeId: true, formData: true },
      orderBy: { updatedAt: 'desc' },
    }),
    getWorkflowBudgetOverview(instance.id).catch(() => null),
  ])
  const ctx = asRecord(instance.context)
  const finalSummary = ctx.finalSummary ?? walk(ctx, 'workbench.finalPack') ?? ctx.summary ?? ctx.result ?? null
  // M101 (Epic→child) — surface the child's impact-analysis verdict so the
  // parent (Epic) workflow can aggregate it from targetOutputs[*].output
  // without re-reading child context. The child impact-analysis workflow's
  // SET_CONTEXT node sets context.impactVerdict = {impacted, reason,
  // affectedAreas}. null when the child isn't an impact-analysis run.
  const verdictRaw = asRecord(ctx.impactVerdict ?? walk(ctx, 'impactVerdict') ?? {})
  const impactVerdict = Object.keys(verdictRaw).length > 0
    ? {
        impacted: verdictRaw.impacted === true,
        reason: typeof verdictRaw.reason === 'string' ? verdictRaw.reason : null,
        affectedAreas: Array.isArray(verdictRaw.affectedAreas) ? verdictRaw.affectedAreas : [],
      }
    : null
  return {
    childWorkflowInstanceId: instance.id,
    finalSummary,
    impactVerdict,
    consumables,
    consumableIds: consumables.map(c => c.id),
    budget,
    completedAt: instance.completedAt?.toISOString() ?? new Date().toISOString(),
  }
}

export async function handleWorkItemChildCompletion(instance: WorkflowInstance, actorId?: string): Promise<void> {
  const ctx = asRecord(instance.context)
  const workItemRef = asRecord(ctx._workItem)
  const targetId = typeof workItemRef.targetId === 'string' ? workItemRef.targetId : null
  const target = await prisma.workItemTarget.findFirst({
    where: {
      OR: [
        ...(targetId ? [{ id: targetId }] : []),
        { childWorkflowInstanceId: instance.id },
      ],
    },
    include: { workItem: { include: { targets: true } } },
  })
  if (!target || DONE_TARGET_STATUSES.has(target.status) || target.status === 'CANCELLED') return

  const output = await buildChildOutput(instance)
  await prisma.workItemTarget.update({
    where: { id: target.id },
    data: { status: 'SUBMITTED', output: output as Prisma.InputJsonValue, submittedAt: new Date() },
  })
  await prisma.workItemEvent.create({
    data: {
      workItemId: target.workItemId,
      targetId: target.id,
      eventType: 'SUBMITTED',
      actorId,
      payload: output as Prisma.InputJsonValue,
    },
  })
  await logEvent('WorkItemTargetSubmitted', 'WorkItemTarget', target.id, actorId, {
    workItemId: target.workItemId,
    childWorkflowInstanceId: instance.id,
  })
  // M101 (Epic→child) — B6: per-child progress outbox event carrying the
  // impact verdict + a waiting-on-N/M signal, so a join-all fan-in is
  // observable and a stuck child is visible (v1 has no timer; this is the
  // surfacing). `target.workItem.targets` holds pre-update statuses, so the
  // just-submitted target is counted explicitly.
  const siblings = target.workItem.targets
  const total = siblings.length
  const submitted = siblings.filter(t => t.id !== target.id && DONE_TARGET_STATUSES.has(t.status)).length + 1
  const verdict = asRecord(asRecord(output).impactVerdict)
  await publishOutbox('WorkItem', target.workItemId, 'WorkItemTargetSubmitted', {
    workItemId: target.workItemId,
    targetCapabilityId: target.targetCapabilityId,
    childWorkflowInstanceId: instance.id,
    impactVerdict: Object.keys(verdict).length > 0 ? verdict : null,
    submitted,
    total,
    waitingOn: Math.max(0, total - submitted),
  })
  await maybeRequestParentApproval(target.workItemId, actorId)
}

async function maybeRequestParentApproval(workItemId: string, actorId?: string): Promise<void> {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    include: { targets: true },
  })
  if (!workItem || workItem.parentApprovalRequestId || workItem.status === 'COMPLETED') return
  if (!workItem.targets.every(t => DONE_TARGET_STATUSES.has(t.status))) return

  const submittedTargets = workItem.targets.map(t => ({
    targetId: t.id,
    targetCapabilityId: t.targetCapabilityId,
    childWorkflowInstanceId: t.childWorkflowInstanceId,
    output: t.output,
  }))
  const approvalInstanceId = workItem.sourceWorkflowInstanceId
    ?? submittedTargets.find(t => typeof t.childWorkflowInstanceId === 'string' && t.childWorkflowInstanceId)?.childWorkflowInstanceId
    ?? undefined
  if (tenantIsolationStrict() && !approvalInstanceId) {
    throw new ValidationError('TENANT_ISOLATION_MODE=strict requires WorkItem approval requests to be linked to a workflow instance')
  }
  const approval = await prisma.approvalRequest.create({
    data: {
      instanceId: approvalInstanceId,
      nodeId: workItem.sourceWorkflowNodeId ?? undefined,
      subjectType: 'WorkItem',
      subjectId: workItem.id,
      requestedById: actorId ?? workItem.createdById ?? 'system',
      assignedToId: workItem.createdById ?? undefined,
      assignmentMode: workItem.createdById ? 'DIRECT_USER' : 'ROLE_BASED',
      capabilityId: workItem.parentCapabilityId ?? undefined,
      roleKey: workItem.createdById ? undefined : 'owner',
      formData: { workItemId: workItem.id, targets: submittedTargets } as Prisma.InputJsonValue,
    },
  })
  await prisma.workItem.update({
    where: { id: workItem.id },
    data: { status: 'AWAITING_PARENT_APPROVAL', parentApprovalRequestId: approval.id },
  })
  await prisma.workItemEvent.create({
    data: {
      workItemId: workItem.id,
      eventType: 'APPROVAL_REQUESTED',
      actorId,
      payload: { approvalRequestId: approval.id } as Prisma.InputJsonValue,
    },
  })
  await logEvent('WorkItemApprovalRequested', 'WorkItem', workItem.id, actorId, {
    approvalRequestId: approval.id,
  })
  await publishOutbox('WorkItem', workItem.id, 'WorkItemApprovalRequested', {
    workItemId: workItem.id,
    approvalRequestId: approval.id,
  })
}

export async function approveWorkItem(workItemId: string, userId: string, approvalDecision?: string) {
  const workItem = await prisma.workItem.findUnique({
    where: { id: workItemId },
    include: { targets: true },
  })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)

  const targetOutputs = workItem.targets.map(t => ({
    targetId: t.id,
    targetCapabilityId: t.targetCapabilityId,
    childWorkflowInstanceId: t.childWorkflowInstanceId,
    output: t.output,
  }))
  const consumableIds = targetOutputs.flatMap(t => {
    const output = asRecord(t.output)
    return Array.isArray(output.consumableIds) ? output.consumableIds.filter(id => typeof id === 'string') : []
  })
  // M101 (Epic→child) — B4: aggregate the per-child impact verdicts into a
  // ready-to-dispatch target list. A downstream WORK_ITEM node (the impl
  // stage) can set `standard.targetsPath: 'workItem.impactedChildren'` to
  // dispatch ONLY to the children that reported impact (the per-child
  // STORY_IMPL routing policy then selects each child's impl workflow). Empty
  // when this WorkItem isn't an impact-analysis run, so it's harmless on
  // ordinary delegated WorkItems.
  const impactedChildren = targetOutputs
    .filter(t => asRecord(asRecord(t.output).impactVerdict).impacted === true)
    .map(t => ({ targetCapabilityId: t.targetCapabilityId, childWorkflowInstanceId: t.childWorkflowInstanceId }))
  // M101 (Epic→child) — scalar flags for the parent DECISION_GATE. The edge
  // evaluator has no array-length op, so the Epic template branches on
  // `workItem.hasImpact` (== true/false) or `workItem.impactedCount` (> 0).
  const impactedCount = impactedChildren.length
  const hasImpact = impactedCount > 0
  const finalOutput = {
    workItemId,
    title: workItem.title,
    status: 'COMPLETED',
    approvalDecision,
    targetOutputs,
    impactedChildren,
    impactedCount,
    hasImpact,
    consumableIds,
    childWorkflowInstanceIds: targetOutputs.map(t => t.childWorkflowInstanceId).filter(Boolean),
  }

  await prisma.$transaction([
    prisma.workItem.update({
      where: { id: workItemId },
      data: {
        status: 'COMPLETED',
        finalOutput: finalOutput as Prisma.InputJsonValue,
        approvedById: userId,
      },
    }),
    prisma.workItemTarget.updateMany({
      where: { workItemId, status: 'SUBMITTED' },
      data: { status: 'APPROVED', completedAt: new Date() },
    }),
    prisma.workItemEvent.create({
      data: {
        workItemId,
        eventType: 'APPROVED',
        actorId: userId,
        payload: { approvalDecision } as Prisma.InputJsonValue,
      },
    }),
  ])
  await logEvent('WorkItemApproved', 'WorkItem', workItemId, userId, { approvalDecision })
  await publishOutbox('WorkItem', workItemId, 'WorkItemApproved', { workItemId })

  if (workItem.sourceWorkflowInstanceId && workItem.sourceWorkflowNodeId) {
    const sourceNode = await prisma.workflowNode.findUnique({
      where: { id: workItem.sourceWorkflowNodeId },
      select: { config: true },
    })
    const cfg = asRecord(sourceNode?.config)
    const outputPath = String(asRecord(cfg.standard).outputPath ?? cfg.outputPath ?? 'workItem').trim() || 'workItem'
    const advanceOutput: Record<string, unknown> = {}
    setPath(advanceOutput, outputPath, finalOutput)
    const { advance } = await import('../workflow/runtime/WorkflowRuntime')
    await advance(workItem.sourceWorkflowInstanceId, workItem.sourceWorkflowNodeId, advanceOutput, userId)
  }
  return finalOutput
}

export async function requestWorkItemRework(workItemId: string, userId: string, targetIds?: string[], reason?: string) {
  const workItem = await prisma.workItem.findUnique({ where: { id: workItemId }, include: { targets: true } })
  if (!workItem) throw new NotFoundError('WorkItem', workItemId)
  const selected = targetIds && targetIds.length > 0
    ? targetIds
    : workItem.targets.filter(t => t.status === 'SUBMITTED' || t.status === 'APPROVED').map(t => t.id)
  if (selected.length === 0) throw new ValidationError('No submitted WorkItem targets are available for rework')

  await prisma.$transaction([
    prisma.workItem.update({
      where: { id: workItemId },
      data: { status: 'IN_PROGRESS', parentApprovalRequestId: null },
    }),
    prisma.workItemTarget.updateMany({
      where: { workItemId, id: { in: selected } },
      data: {
        status: 'REWORK_REQUESTED',
        claimedById: null,
        claimedAt: null,
        submittedAt: null,
      },
    }),
    prisma.workItemEvent.create({
      data: {
        workItemId,
        eventType: 'REWORK_REQUESTED',
        actorId: userId,
        payload: { targetIds: selected, reason } as Prisma.InputJsonValue,
      },
    }),
  ])
  await logEvent('WorkItemReworkRequested', 'WorkItem', workItemId, userId, { targetIds: selected, reason })
  await publishOutbox('WorkItem', workItemId, 'WorkItemReworkRequested', { workItemId, targetIds: selected })
  return { workItemId, targetIds: selected, status: 'IN_PROGRESS' }
}
