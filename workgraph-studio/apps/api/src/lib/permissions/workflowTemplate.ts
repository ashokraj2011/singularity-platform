import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma'
import { currentTenantIdForDb, withTenantDbTransaction } from '../tenant-db-context'
import { ForbiddenError } from '../errors'
import { logEvent } from '../audit'
import { authzCheck, IamUnavailableError } from '../iam/client'
import { config } from '../../config'
import { isAdminUser } from './admin'

export const WORKFLOW_ACTIONS = [
  'view', 'create', 'edit', 'publish', 'delete', 'start', 'pause', 'resume',
  'cancel', 'simulate', 'checkpoint', 'replay', 'route', 'claim', 'approve',
  'operate', 'audit_view', 'event_publish',
] as const

export type WorkflowAction = typeof WORKFLOW_ACTIONS[number]

export type WorkflowResource =
  | 'workflow_template'
  | 'workflow_instance'
  | 'work_item'
  | 'work_item_target'
  | 'workflow_operation'
  | 'artifact'
  | 'document'
  | 'approval'
  | 'runner_execution'

// A creator owns the workflow configuration surface. These grants are written
// at creation time, and the legacy-owner fallback below keeps drafts created
// before the resource-grant migration editable without bypassing explicit
// denies or tenant boundaries.
const WORKFLOW_OWNER_ACTIONS: WorkflowAction[] = ['view', 'edit', 'publish', 'delete']

export type WorkflowAuthorizationDecision = {
  allowed: boolean
  decisionId: string
  tenantId: string | null
  resourceType: WorkflowResource
  resourceId: string | null
  action: WorkflowAction
  policyVersion: string
  source: string
  reason: string
  actorWorkGraphId: string
  actorIamUserId: string | null
  capabilityId: string | null
  teamId: string | null
  roles: string[]
  permissions: string[]
  grants: Array<Record<string, unknown>>
}

type TemplateOwnership = {
  id: string
  createdById: string | null
  teamId: string
  capabilityId: string | null
  tenantId: string | null
  metadata: Prisma.JsonValue | null
  accessGrants: Array<{
    id: string
    subjectType: string
    subjectId: string
    action: string
    effect: string
    tenantId: string | null
    startsAt: Date | null
    endsAt: Date | null
  }>
}

type Actor = {
  id: string
  iamUserId: string | null
  teamId: string | null
  roleIds: string[]
  roleNames: string[]
  isAdmin: boolean
}

const IAM_PERMISSION_BY_ACTION: Record<WorkflowAction, string> = {
  view: 'workflow:view',
  create: 'workflow:create',
  edit: 'workflow:update',
  publish: 'workflow:template:publish',
  delete: 'workflow:delete',
  start: 'workflow:execute',
  pause: 'workflow:update',
  resume: 'workflow:execute',
  cancel: 'workflow:update',
  simulate: 'workflow:execute',
  checkpoint: 'workflow:update',
  replay: 'workflow:execute',
  route: 'workflow:assign',
  claim: 'workflow:assign',
  approve: 'workflow:approve',
  operate: 'workflow:operations:view',
  audit_view: 'workflow:audit:view',
  event_publish: 'workflow:event:publish',
}

const LEGACY_ACTION_BY_ACTION: Record<WorkflowAction, string[]> = {
  view: ['VIEW', 'ADMIN'],
  create: ['ADMIN'],
  edit: ['EDIT', 'ADMIN'],
  publish: ['ADMIN', 'EDIT'],
  delete: ['ADMIN'],
  start: ['START', 'ADMIN'],
  pause: ['EDIT', 'ADMIN'],
  resume: ['START', 'ADMIN'],
  cancel: ['EDIT', 'ADMIN'],
  simulate: ['VIEW', 'EDIT', 'ADMIN'],
  checkpoint: ['EDIT', 'ADMIN'],
  replay: ['START', 'ADMIN'],
  route: ['START', 'EDIT', 'ADMIN'],
  claim: ['START', 'EDIT', 'ADMIN'],
  approve: ['ADMIN'],
  operate: ['ADMIN'],
  audit_view: ['VIEW', 'ADMIN'],
  event_publish: [],
}

function isRecord(value: Prisma.JsonValue | null | undefined): value is Prisma.JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function activeGrant(grant: TemplateOwnership['accessGrants'][number], tenantId: string | null): boolean {
  const now = Date.now()
  if (grant.tenantId && tenantId && grant.tenantId !== tenantId) return false
  if (grant.startsAt && grant.startsAt.getTime() > now) return false
  if (grant.endsAt && grant.endsAt.getTime() <= now) return false
  return true
}

async function loadActor(userId: string): Promise<Actor> {
  const [user, isAdmin] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        iamUserId: true,
        teamId: true,
        roles: { select: { roleId: true, role: { select: { name: true } } } },
      },
    }),
    config.AUTH_PROVIDER === 'local' ? isAdminUser(userId) : Promise.resolve(false),
  ])
  return {
    id: user?.id ?? userId,
    iamUserId: user?.iamUserId ?? null,
    teamId: user?.teamId ?? null,
    roleIds: user?.roles.map(role => role.roleId) ?? [],
    roleNames: user?.roles.map(role => role.role.name) ?? [],
    isAdmin,
  }
}

async function loadTemplate(templateId: string): Promise<TemplateOwnership | null> {
  return withTenantDbTransaction(prisma, tx => tx.workflow.findUnique({
    where: { id: templateId, ...(currentTenantIdForDb() ? { tenantId: currentTenantIdForDb() } : {}) },
    select: {
      id: true,
      createdById: true,
      teamId: true,
      capabilityId: true,
      tenantId: true,
      metadata: true,
      accessGrants: {
        select: {
          id: true,
          subjectType: true,
          subjectId: true,
          action: true,
          effect: true,
          tenantId: true,
          startsAt: true,
          endsAt: true,
        },
      },
    },
  }), currentTenantIdForDb())
}

function workflowMetadataVisibility(template: TemplateOwnership): string {
  const metadata = isRecord(template.metadata) ? template.metadata : {}
  const raw = metadata.visibility ?? (metadata.globallyAvailable === true ? 'GLOBAL' : 'PRIVATE')
  return String(raw).trim().toUpperCase()
}

function actorGrantSubjects(actor: Actor): Set<string> {
  return new Set([
    `USER:${actor.id}`,
    ...(actor.iamUserId ? [`IAM_USER:${actor.iamUserId}`] : []),
    ...(actor.teamId ? [`TEAM:${actor.teamId}`] : []),
    ...actor.roleIds.map(id => `ROLE:${id}`),
  ])
}

function grantMatches(grant: TemplateOwnership['accessGrants'][number], actor: Actor, action: WorkflowAction, tenantId: string | null, capabilityId: string | null): boolean {
  if (!activeGrant(grant, tenantId)) return false
  const normalizedAction = grant.action.trim().toLowerCase()
  if (normalizedAction !== action && normalizedAction !== '*') return false
  const subjects = actorGrantSubjects(actor)
  if (grant.subjectType.trim().toUpperCase() === 'CAPABILITY') return Boolean(capabilityId && grant.subjectId === capabilityId)
  return subjects.has(`${grant.subjectType.trim().toUpperCase()}:${grant.subjectId}`)
}

function legacyPermissionMatches(actor: Actor, templateId: string, action: WorkflowAction): Promise<boolean> {
  const allowed = LEGACY_ACTION_BY_ACTION[action]
  return prisma.workflowPermission.findFirst({
    where: { templateId, roleId: { in: actor.roleIds }, action: { in: allowed as any } },
    select: { id: true },
  }).then(Boolean)
}

function baseDecision(input: {
  actor: Actor
  template: TemplateOwnership
  action: WorkflowAction
  source: string
  reason: string
  allowed: boolean
  grants?: Array<Record<string, unknown>>
  permissions?: string[]
}): WorkflowAuthorizationDecision {
  const { actor, template, action } = input
  return {
    allowed: input.allowed,
    decisionId: randomUUID(),
    tenantId: template.tenantId ?? config.WORKGRAPH_DEFAULT_TENANT_ID,
    resourceType: 'workflow_template',
    resourceId: template.id,
    action,
    policyVersion: 'workflow-authz-v1',
    source: input.source,
    reason: input.reason,
    actorWorkGraphId: actor.id,
    actorIamUserId: actor.iamUserId,
    capabilityId: template.capabilityId,
    teamId: template.teamId,
    roles: actor.roleNames,
    permissions: input.permissions ?? [],
    grants: input.grants ?? [],
  }
}

async function evaluateTemplate(actor: Actor, template: TemplateOwnership, action: WorkflowAction): Promise<WorkflowAuthorizationDecision> {
  const tenantId = template.tenantId ?? config.WORKGRAPH_DEFAULT_TENANT_ID
  const matching = template.accessGrants.filter(grant => grantMatches(grant, actor, action, tenantId, template.capabilityId))
  const denies = matching.filter(grant => grant.effect.trim().toUpperCase() === 'DENY')
  if (denies.length > 0) {
    return baseDecision({ actor, template, action, allowed: false, source: 'explicit_deny', reason: 'An explicit workflow access deny applies.', grants: denies.map(grant => ({ id: grant.id, subjectType: grant.subjectType, subjectId: grant.subjectId, action: grant.action })) })
  }
  if (matching.some(grant => grant.effect.trim().toUpperCase() === 'ALLOW')) {
    return baseDecision({ actor, template, action, allowed: true, source: 'resource_grant', reason: 'An explicit workflow access grant applies.', grants: matching.map(grant => ({ id: grant.id, subjectType: grant.subjectType, subjectId: grant.subjectId, action: grant.action })) })
  }

  // Migrate older drafts lazily. Before WorkflowAccessGrant existed, the
  // creator was persisted on the workflow but no USER grant was created. Keep
  // that ownership meaningful for configuration actions while preserving the
  // explicit-deny check above and requiring normal IAM permissions for start,
  // replay, approvals, and external side effects.
  if (template.createdById === actor.id && WORKFLOW_OWNER_ACTIONS.includes(action)) {
    return baseDecision({ actor, template, action, allowed: true, source: 'creator_ownership', reason: 'Workflow creator ownership.' })
  }

  if (config.AUTH_PROVIDER === 'local' && actor.isAdmin) {
    return baseDecision({ actor, template, action, allowed: true, source: 'local_admin', reason: 'Local development administrator.' })
  }
  if (template.capabilityId && config.AUTH_PROVIDER === 'iam') {
    if (!actor.iamUserId) {
      return baseDecision({ actor, template, action, allowed: false, source: 'missing_iam_identity', reason: 'An IAM identity is required for capability-scoped workflow access.' })
    }
    try {
      const permission = IAM_PERMISSION_BY_ACTION[action]
      const result = await authzCheck(actor.iamUserId, template.capabilityId, permission, {
        resourceType: 'WorkflowTemplate',
        resourceId: template.id,
        tenantId,
      })
      return baseDecision({ actor, template, action, allowed: result.allowed, source: result.source ?? 'iam', reason: result.reason ?? (result.allowed ? 'IAM capability permission.' : 'IAM denied the capability permission.'), permissions: result.permissions ?? [] })
    } catch (err) {
      const reason = err instanceof IamUnavailableError ? 'IAM authorization is unavailable; access is denied.' : 'IAM authorization failed; access is denied.'
      return baseDecision({ actor, template, action, allowed: false, source: 'iam_unavailable', reason })
    }
  }

  // Published/common templates may be visible through an explicit platform
  // read policy, but visibility alone never grants start or edit. This keeps
  // the gallery useful without turning it into an execution bypass.
  if (config.AUTH_PROVIDER === 'iam' && action === 'view' && ['GLOBAL', 'TENANT', 'PLATFORM_READONLY'].includes(workflowMetadataVisibility(template))) {
    if (!actor.iamUserId) {
      return baseDecision({ actor, template, action, allowed: false, source: 'missing_iam_identity', reason: 'An IAM identity is required for workflow visibility.' })
    }
    const result = await authzCheck(actor.iamUserId, '__platform__', IAM_PERMISSION_BY_ACTION.view, {
      resourceType: 'WorkflowTemplate', resourceId: template.id, tenantId,
    })
    if (result.allowed) {
      return baseDecision({ actor, template, action, allowed: true, source: result.source ?? 'iam_platform_visibility', reason: result.reason ?? 'IAM platform visibility permission.', permissions: result.permissions ?? [] })
    }
  }

  if (config.AUTH_PROVIDER !== 'iam') {
    if (template.createdById === actor.id && ['view', 'create', 'edit', 'publish', 'start', 'simulate', 'checkpoint', 'replay', 'route', 'claim'].includes(action)) {
      return baseDecision({ actor, template, action, allowed: true, source: 'owner', reason: 'Workflow owner access.' })
    }
    if (actor.teamId === template.teamId && ['view', 'edit', 'start', 'simulate', 'checkpoint', 'route', 'claim'].includes(action)) {
      return baseDecision({ actor, template, action, allowed: true, source: 'team', reason: 'Workflow team access.' })
    }
    if (await legacyPermissionMatches(actor, template.id, action)) {
      return baseDecision({ actor, template, action, allowed: true, source: 'legacy_workflow_permission', reason: 'Existing workflow role grant.' })
    }
    if (action === 'view' && ['GLOBAL', 'TENANT'].includes(workflowMetadataVisibility(template))) {
      return baseDecision({ actor, template, action, allowed: true, source: 'workflow_visibility', reason: 'Development workflow visibility policy.' })
    }
  }
  return baseDecision({ actor, template, action, allowed: false, source: 'default_deny', reason: 'No matching workflow grant or capability permission.' })
}

export async function ensureWorkflowOwnerAccess(
  workflowId: string,
  tenantId: string,
  userId: string,
): Promise<void> {
  await prisma.workflowAccessGrant.createMany({
    data: WORKFLOW_OWNER_ACTIONS.map(action => ({
      workflowId,
      tenantId,
      subjectType: 'USER',
      subjectId: userId,
      action,
      effect: 'ALLOW',
      createdById: userId,
    })),
    skipDuplicates: true,
  })
}

export async function evaluateTemplatePermission(userId: string, templateId: string, action: WorkflowAction): Promise<WorkflowAuthorizationDecision> {
  const [actor, template] = await Promise.all([loadActor(userId), loadTemplate(templateId)])
  if (!template) {
    return {
      allowed: false,
      decisionId: randomUUID(),
      tenantId: null,
      resourceType: 'workflow_template',
      resourceId: templateId,
      action,
      policyVersion: 'workflow-authz-v1',
      source: 'not_found',
      reason: 'Workflow template not found or not accessible.',
      actorWorkGraphId: actor.id,
      actorIamUserId: actor.iamUserId,
      capabilityId: null,
      teamId: null,
      roles: actor.roleNames,
      permissions: [],
      grants: [],
    }
  }
  return evaluateTemplate(actor, template, action)
}

export async function assertWorkflowCreatePermission(
  userId: string,
  capabilityId: string | null | undefined,
  tenantId?: string | null,
): Promise<void> {
  const actor = await loadActor(userId)
  if (config.AUTH_PROVIDER === 'local' && actor.isAdmin) return
  if (!actor.iamUserId) {
    throw new ForbiddenError('IAM identity is required to create workflow templates')
  }
  const result = await authzCheck(
    actor.iamUserId,
    capabilityId ?? '__platform__',
    IAM_PERMISSION_BY_ACTION.create,
    { resourceType: 'WorkflowTemplate', tenantId: tenantId ?? config.WORKGRAPH_DEFAULT_TENANT_ID },
  )
  if (!result.allowed) {
    throw new ForbiddenError(`User does not have workflow:create permission (${result.reason ?? 'IAM denied the request'})`)
  }
}

export async function assertPlatformWorkflowPermission(
  userId: string,
  action: WorkflowAction,
  resourceType: string,
  resourceId?: string,
  tenantId?: string | null,
): Promise<void> {
  const actor = await loadActor(userId)
  if (config.AUTH_PROVIDER === 'local' && actor.isAdmin) return
  if (!actor.iamUserId) {
    throw new ForbiddenError(`IAM identity is required for ${resourceType} ${action}`)
  }
  const result = await authzCheck(
    actor.iamUserId,
    '__platform__',
    IAM_PERMISSION_BY_ACTION[action],
    { resourceType, resourceId, tenantId: tenantId ?? config.WORKGRAPH_DEFAULT_TENANT_ID },
  )
  if (!result.allowed) {
    throw new ForbiddenError(`User does not have ${IAM_PERMISSION_BY_ACTION[action]} for ${resourceType} (${result.reason ?? 'IAM denied the request'})`)
  }
}

export type WorkflowOperationsAction = 'view' | 'replay' | 'retry_delivery' | 'manage_runners' | 'audit_view'

const OPERATIONS_PERMISSION_BY_ACTION: Record<WorkflowOperationsAction, string> = {
  view: 'workflow:operations:view',
  replay: 'workflow:operations:replay',
  retry_delivery: 'workflow:operations:retry_delivery',
  manage_runners: 'workflow:operations:manage_runners',
  audit_view: 'workflow:audit:view',
}

export async function assertWorkflowOperationsPermission(userId: string, action: WorkflowOperationsAction, tenantId?: string | null): Promise<void> {
  const actor = await loadActor(userId)
  if (config.AUTH_PROVIDER === 'local' && actor.isAdmin) return
  if (!actor.iamUserId) throw new ForbiddenError('IAM identity is required for workflow operations access')
  const result = await authzCheck(actor.iamUserId, '__platform__', OPERATIONS_PERMISSION_BY_ACTION[action], {
    resourceType: 'WorkflowOperation',
    tenantId: tenantId ?? config.WORKGRAPH_DEFAULT_TENANT_ID,
  })
  if (!result.allowed) throw new ForbiddenError(`User does not have ${OPERATIONS_PERMISSION_BY_ACTION[action]} permission (${result.reason ?? 'IAM denied the request'})`)
}

export async function canViewWorkflowOperations(userId: string, action: WorkflowOperationsAction = 'view', tenantId?: string | null): Promise<boolean> {
  try {
    await assertWorkflowOperationsPermission(userId, action, tenantId)
    return true
  } catch {
    return false
  }
}

/**
 * Capability-scoped authorization for workflow configuration that is not a
 * template itself, such as routing policies and event triggers. Keeping this
 * beside template authorization prevents those resources from inventing a
 * second IAM permission vocabulary.
 */
export async function assertCapabilityPermission(
  userId: string,
  capabilityId: string,
  action: WorkflowAction,
  resourceType: string,
  resourceId?: string,
  tenantId?: string | null,
): Promise<void> {
  const actor = await loadActor(userId)
  if (config.AUTH_PROVIDER === 'local' && actor.isAdmin) return
  if (!actor.iamUserId) throw new ForbiddenError('IAM identity is required for capability-scoped workflow configuration')
  const result = await authzCheck(actor.iamUserId, capabilityId, IAM_PERMISSION_BY_ACTION[action], {
    resourceType,
    resourceId,
    tenantId: tenantId ?? config.WORKGRAPH_DEFAULT_TENANT_ID,
  })
  if (!result.allowed) {
    throw new ForbiddenError(`User does not have ${IAM_PERMISSION_BY_ACTION[action]} for ${resourceType} (${result.reason ?? 'IAM denied the request'})`)
  }
}

export async function canCapabilityPermission(
  userId: string,
  capabilityId: string,
  action: WorkflowAction,
  resourceType: string,
  resourceId?: string,
  tenantId?: string | null,
): Promise<boolean> {
  try {
    await assertCapabilityPermission(userId, capabilityId, action, resourceType, resourceId, tenantId)
    return true
  } catch {
    return false
  }
}

export async function assertTemplatePermission(userId: string, templateId: string, action: WorkflowAction): Promise<TemplateOwnership> {
  const decision = await evaluateTemplatePermission(userId, templateId, action)
  if (!decision.allowed) {
    await logEvent('PermissionDenied', 'WorkflowTemplate', templateId, userId, {
      action,
      decisionId: decision.decisionId,
      policyVersion: decision.policyVersion,
      source: decision.source,
      reason: decision.reason,
      tenantId: decision.tenantId,
      capabilityId: decision.capabilityId,
    })
    throw new ForbiddenError(`User does not have ${action} permission on this workflow template (${decision.reason})`)
  }
  return (await loadTemplate(templateId)) as TemplateOwnership
}

export async function canEditTemplate(userId: string, templateId: string): Promise<boolean> {
  return (await evaluateTemplatePermission(userId, templateId, 'edit')).allowed
}

export async function canViewTemplate(userId: string, templateId: string): Promise<boolean> {
  return (await evaluateTemplatePermission(userId, templateId, 'view')).allowed
}

export async function canStartTemplate(userId: string, templateId: string): Promise<boolean> {
  return (await evaluateTemplatePermission(userId, templateId, 'start')).allowed
}

export async function assertInstancePermission(userId: string, instanceId: string, action: WorkflowAction, tenantId?: string): Promise<void> {
  const instance = await withTenantDbTransaction(prisma, tx => tx.workflowInstance.findUnique({
    where: { id: instanceId },
    select: { id: true, templateId: true, createdById: true, tenantId: true },
  }), tenantId)
  if (!instance) throw new ForbiddenError(`WorkflowInstance ${instanceId} not found or not accessible`)

  if (instance.templateId) {
    const decision = await evaluateTemplatePermission(userId, instance.templateId, action)
    if (decision.allowed) return
    await logEvent('PermissionDenied', 'WorkflowInstance', instanceId, userId, {
      action, decisionId: decision.decisionId, policyVersion: decision.policyVersion,
      source: decision.source, reason: decision.reason, tenantId: instance.tenantId,
    })
    throw new ForbiddenError(`User does not have ${action} permission on this workflow instance (${decision.reason})`)
  }

  const actor = await loadActor(userId)
  if (config.AUTH_PROVIDER === 'iam') {
    if (!actor.iamUserId) throw new ForbiddenError('IAM identity is required for this workflow instance')
    const result = await authzCheck(actor.iamUserId, '__platform__', IAM_PERMISSION_BY_ACTION[action], {
      resourceType: 'WorkflowInstance',
      resourceId: instanceId,
      tenantId: instance.tenantId ?? tenantId ?? config.WORKGRAPH_DEFAULT_TENANT_ID,
    })
    if (result.allowed) return
    throw new ForbiddenError(`User does not have ${action} permission on this workflow instance (${result.reason ?? 'IAM denied the request'})`)
  }
  if (actor.isAdmin) return
  if (instance.createdById && instance.createdById === actor.id && ['view', 'edit', 'simulate', 'checkpoint', 'replay'].includes(action)) return
  throw new ForbiddenError(`User does not have ${action} permission on this workflow instance`)
}

export async function resolveDefaultTeamId(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { teamId: true } })
  if (user?.teamId) return user.teamId
  const fallback = await prisma.team.findFirst({ where: { name: config.DEFAULT_WORKFLOW_TEAM_NAME }, select: { id: true } })
  if (fallback) return fallback.id
  const created = await prisma.team.create({
    data: { name: config.DEFAULT_WORKFLOW_TEAM_NAME, description: 'Auto-created default team for workflow templates' },
    select: { id: true },
  })
  return created.id
}

export function authorizationSnapshotDigest(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

export async function createWorkflowAuthorizationSnapshot(input: {
  instanceId: string
  workflowId?: string | null
  tenantId?: string | null
  actorWorkGraphId: string
  actorIamUserId?: string | null
  capabilityId?: string | null
  runOwnerId?: string | null
  decision: WorkflowAuthorizationDecision
}) {
  const snapshot = {
    policyVersion: input.decision.policyVersion,
    actorWorkGraphId: input.actorWorkGraphId,
    actorIamUserId: input.actorIamUserId ?? null,
    tenantId: input.tenantId ?? input.decision.tenantId,
    workflowId: input.workflowId ?? null,
    capabilityId: input.capabilityId ?? input.decision.capabilityId,
    roles: input.decision.roles,
    permissions: input.decision.permissions,
    grants: input.decision.grants,
  }
  const created = await prisma.workflowAuthorizationSnapshot.upsert({
    where: { instanceId: input.instanceId },
    create: {
      instanceId: input.instanceId,
      tenantId: input.tenantId ?? input.decision.tenantId,
      actorIamUserId: input.actorIamUserId ?? null,
      actorWorkGraphId: input.actorWorkGraphId,
      runOwnerId: input.runOwnerId ?? input.actorWorkGraphId,
      workflowId: input.workflowId ?? null,
      capabilityId: input.capabilityId ?? input.decision.capabilityId,
      policyVersion: input.decision.policyVersion,
      effectiveRoles: input.decision.roles as unknown as Prisma.InputJsonValue,
      effectivePermissions: input.decision.permissions as unknown as Prisma.InputJsonValue,
      resourceGrants: input.decision.grants as unknown as Prisma.InputJsonValue,
      snapshotDigest: authorizationSnapshotDigest(snapshot),
    },
    update: {},
  })
  return created
}
