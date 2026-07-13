import type { ApprovalRequest } from '@prisma/client'
import { config } from '../../config'
import { ForbiddenError } from '../errors'
import { authzCheck, type IamAuthzCheckResponse } from '../iam/client'
import { loadCallerContext, type CallerContext } from '../iam/callerContext'
import { prisma } from '../prisma'

/**
 * Approval is a human action, not just a tenant-scoped mutation.  The policy
 * vocabulary is permission-based. Roles are deliberately absent here: local
 * roles are joined to permissions from the database, while IAM resolves the
 * same permission key against its capability membership.
 */
export type ApprovalSurface = 'workflow' | 'agent' | 'tool' | 'governance' | 'consumable'

export function approvalPermission(surface: ApprovalSurface): string {
  switch (surface) {
    case 'workflow': return config.APPROVAL_WORKFLOW_PERMISSION
    case 'agent': return config.APPROVAL_AGENT_PERMISSION
    case 'tool': return config.APPROVAL_TOOL_PERMISSION
    case 'governance': return config.APPROVAL_GOVERNANCE_PERMISSION
    case 'consumable': return config.APPROVAL_CONSUMABLE_PERMISSION
  }
}

export type ApprovalRouting = {
  assignedToId?: string | null
  assignmentMode?: string | null
  teamId?: string | null
  roleKey?: string | null
  skillKey?: string | null
  capabilityId?: string | null
  dueAt?: Date | null
}

export type ApprovalAuthorizationOptions = {
  /** Permission key used by both the local permission graph and IAM. */
  permissionKey?: string
  /** A stable resource label for the denial message and audit caller. */
  resourceType?: string
  resourceId?: string
  /** Tenant boundary forwarded to IAM for every approval decision. */
  tenantId?: string | null
}

type LocalActor = {
  id: string
  permissionKeys: string[]
}

export type ApprovalEligibility = {
  allowed: boolean
  isAdmin?: boolean
  reason: string
  source: 'local' | 'iam'
}

/**
 * Validate the routing contract before a request can be created or decided.
 * A missing selector must never silently degrade a role/skill/team approval
 * into a permission-only approval.  Legacy rows with no assignmentMode and no
 * selector remain readable for migration purposes; newly routed rows do not.
 */
export function validateApprovalRouting(routing: ApprovalRouting): { mode?: string } {
  const configured = normalize(routing.assignmentMode)
  const inferred = configured || (
    routing.assignedToId ? 'DIRECT_USER' :
      routing.teamId ? 'TEAM_QUEUE' :
        routing.roleKey ? 'ROLE_BASED' :
          routing.skillKey ? 'SKILL_BASED' : ''
  )
  if (!inferred) return {}

  if (!['DIRECT_USER', 'TEAM_QUEUE', 'ROLE_BASED', 'SKILL_BASED'].includes(inferred)) {
    throw new Error(`unsupported approval assignment mode ${inferred}`)
  }
  if (inferred === 'DIRECT_USER' && !routing.assignedToId) {
    throw new Error('DIRECT_USER approval routing requires assignedToId')
  }
  if (inferred === 'TEAM_QUEUE' && !routing.teamId) {
    throw new Error('TEAM_QUEUE approval routing requires teamId')
  }
  if (inferred === 'ROLE_BASED' && (!routing.roleKey || !routing.capabilityId)) {
    throw new Error('ROLE_BASED approval routing requires roleKey and capabilityId')
  }
  if (inferred === 'SKILL_BASED' && !routing.skillKey) {
    throw new Error('SKILL_BASED approval routing requires skillKey')
  }
  if (inferred !== 'DIRECT_USER' && routing.assignedToId) {
    throw new Error(`${inferred} approval routing cannot include assignedToId`)
  }
  return { mode: inferred }
}

function normalize(value: string | null | undefined): string {
  return String(value ?? '').trim().toUpperCase()
}

function includesNormalized(values: string[] | undefined, expected: string | null | undefined): boolean {
  const wanted = normalize(expected)
  return Boolean(wanted && (values ?? []).some(value => normalize(value) === wanted))
}

async function loadLocalActor(userId: string): Promise<LocalActor | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      roles: {
        select: {
          role: {
            select: {
              permissions: { select: { permission: { select: { name: true } } } },
            },
          },
        },
      },
    },
  })
  if (!user) return null
  return {
    id: user.id,
    permissionKeys: [...new Set(user.roles.flatMap(row => row.role.permissions.map(item => item.permission.name)))],
  }
}

function localEligibility(
  userId: string,
  routing: ApprovalRouting,
  context: CallerContext,
  permissionKeys: string[],
  permissionKey: string,
  now = new Date(),
): ApprovalEligibility {
  const normalizedPermissions = new Set(permissionKeys.map(normalize))
  const isAdmin = normalizedPermissions.has(normalize(config.PLATFORM_ADMIN_PERMISSION))
  if (routing.dueAt && routing.dueAt.getTime() <= now.getTime()) {
    return { allowed: false, isAdmin, reason: 'approval request has expired', source: 'local' }
  }
  if (!isAdmin && routing.assignedToId && routing.assignedToId !== userId) {
    return { allowed: false, isAdmin, reason: 'approval is assigned to another user', source: 'local' }
  }
  if (!isAdmin && routing.teamId && !context.teamIds.includes(routing.teamId)) {
    return { allowed: false, isAdmin, reason: 'user is not a member of the approval team', source: 'local' }
  }
  if (!isAdmin && routing.skillKey && !includesNormalized(context.skillKeys, routing.skillKey)) {
    return { allowed: false, isAdmin, reason: 'user does not hold the required approval skill', source: 'local' }
  }
  if (!isAdmin && routing.roleKey && !includesNormalized(context.roleKeys, routing.roleKey)) {
    return { allowed: false, isAdmin, reason: 'user does not hold the required approval role', source: 'local' }
  }
  if (!normalizedPermissions.has(normalize(permissionKey)) && !isAdmin) {
    return { allowed: false, isAdmin, reason: `user does not hold permission ${permissionKey}`, source: 'local' }
  }
  return { allowed: true, isAdmin, reason: `local permission ${permissionKey} and routing matched`, source: 'local' }
}

/** Pure routing/role predicate used by the API gate and regression tests. */
export function evaluateLocalApprovalRouting(args: {
  userId: string
  routing: ApprovalRouting
  context: CallerContext
  permissionKeys: string[]
  permissionKey?: string
  now?: Date
}): ApprovalEligibility {
  try {
    validateApprovalRouting(args.routing)
  } catch (error) {
    return {
      allowed: false,
      isAdmin: false,
      reason: error instanceof Error ? error.message : 'approval routing is invalid',
      source: 'local',
    }
  }
  return localEligibility(
    args.userId,
    args.routing,
    args.context,
    args.permissionKeys,
    args.permissionKey ?? approvalPermission('workflow'),
    args.now,
  )
}

/**
 * Evaluate whether a user may decide a routed approval.  This function is
 * intentionally deny-by-default for IAM mode: a capability-bound approval
 * must be authorized by IAM with the approval permission.  Local role rows
 * are not treated as an IAM substitute in a federated deployment.
 */
export async function canDecideApproval(
  userId: string,
  routing: ApprovalRouting,
  options: ApprovalAuthorizationOptions = {},
): Promise<ApprovalEligibility> {
  const permissionKey = options.permissionKey ?? approvalPermission('workflow')

  try {
    validateApprovalRouting(routing)
  } catch (error) {
    return {
      allowed: false,
      isAdmin: false,
      reason: error instanceof Error ? error.message : 'approval routing is invalid',
      source: config.AUTH_PROVIDER === 'iam' ? 'iam' : 'local',
    }
  }

  if (routing.dueAt && routing.dueAt.getTime() <= Date.now()) {
    return { allowed: false, isAdmin: false, reason: 'approval request has expired', source: config.AUTH_PROVIDER === 'iam' ? 'iam' : 'local' }
  }

  // A principal can temporarily delegate a DIRECT_USER approval while out of
  // office. The delegation is tenant-scoped and time-bounded; it never grants
  // platform-admin access and does not widen role/skill/capability approvals.
  let decisionRouting = routing
  if (routing.assignedToId && routing.assignedToId !== userId) {
    const delegation = await prisma.outOfOfficeDelegation.findFirst({
      where: {
        principalUserId: routing.assignedToId,
        delegateUserId: userId,
        status: 'ACTIVE',
        startsAt: { lte: new Date() },
        endsAt: { gte: new Date() },
      },
      select: { id: true },
    }).catch(() => null)
    if (delegation) decisionRouting = { ...routing, assignedToId: userId }
  }

  const actor = await loadLocalActor(userId)
  if (!actor) return { allowed: false, isAdmin: false, reason: 'approving user was not found', source: config.AUTH_PROVIDER === 'iam' ? 'iam' : 'local' }

  const context = await loadCallerContext(userId)
  if (config.AUTH_PROVIDER !== 'iam') {
    return evaluateLocalApprovalRouting({
      userId,
      routing: decisionRouting,
      context,
      permissionKeys: actor.permissionKeys,
      permissionKey,
    })
  }

  // In IAM mode, approval must be scoped to the governed capability.  This
  // prevents a platform user from approving a capability merely because the
  // request id was discoverable.  Legacy unscoped rows fail closed.
  if (!decisionRouting.capabilityId) {
    return { allowed: false, isAdmin: false, reason: 'approval has no governed capability scope', source: 'iam' }
  }
  if (!context.iamUserId) {
    return { allowed: false, isAdmin: false, reason: 'IAM identity is missing for approving user', source: 'iam' }
  }

  const result = await authzCheck(
    context.iamUserId,
    decisionRouting.capabilityId,
    permissionKey,
    {
      resourceType: options.resourceType ?? 'ApprovalRequest',
      resourceId: options.resourceId,
      tenantId: options.tenantId ?? undefined,
    },
  ).catch(() => ({ allowed: false, reason: 'IAM authorization check was unavailable' } as IamAuthzCheckResponse))

  const adminResult = await authzCheck(
    context.iamUserId,
    decisionRouting.capabilityId,
    config.PLATFORM_ADMIN_PERMISSION,
    {
      resourceType: options.resourceType ?? 'ApprovalRequest',
      resourceId: options.resourceId,
      tenantId: options.tenantId ?? undefined,
    },
  ).catch(() => ({ allowed: false } as IamAuthzCheckResponse))
  if (!result.allowed && !adminResult.allowed) {
    return { allowed: false, isAdmin: false, reason: result.reason || `IAM denied ${permissionKey}`, source: 'iam' }
  }
  const isAdmin = adminResult.allowed || (result.permissions ?? []).some(permission => normalize(permission) === normalize(config.PLATFORM_ADMIN_PERMISSION))
  if (!isAdmin && decisionRouting.teamId && !context.teamIds.includes(decisionRouting.teamId)) {
    return { allowed: false, isAdmin, reason: 'user is not a member of the approval team', source: 'iam' }
  }
  if (!isAdmin && decisionRouting.skillKey && !includesNormalized(context.skillKeys, decisionRouting.skillKey)) {
    return { allowed: false, isAdmin, reason: 'user does not hold the required approval skill', source: 'iam' }
  }
  if (!isAdmin && decisionRouting.roleKey && !includesNormalized(result.roles, decisionRouting.roleKey)) {
    return { allowed: false, isAdmin, reason: 'IAM did not return the required approval role', source: 'iam' }
  }
  return { allowed: true, isAdmin, reason: `IAM granted ${permissionKey} on the governed capability`, source: 'iam' }
}

export async function assertCanDecideApproval(
  userId: string,
  routing: ApprovalRouting,
  options: ApprovalAuthorizationOptions = {},
): Promise<ApprovalEligibility> {
  const result = await canDecideApproval(userId, routing, options)
  if (!result.allowed) {
    const resource = options.resourceType && options.resourceId
      ? ` for ${options.resourceType} ${options.resourceId}`
      : ''
    throw new ForbiddenError(`User is not authorized to decide this approval${resource}: ${result.reason}`)
  }
  return result
}

/** Authorization for creating a human approval request.  This is separate from
 * deciding one: a requester may be allowed to submit a review without being
 * eligible to vote on the resulting routed request. */
export async function assertCanRequestApproval(
  userId: string,
  capabilityId: string | null | undefined,
  permissionKey: string,
  tenantId?: string | null,
): Promise<void> {
  const actor = await loadLocalActor(userId)
  if (!actor) throw new ForbiddenError('approving user was not found')
  const isAdmin = actor.permissionKeys.some(permission => normalize(permission) === normalize(config.PLATFORM_ADMIN_PERMISSION))
  if (config.AUTH_PROVIDER !== 'iam') {
    if (!isAdmin && !actor.permissionKeys.some(permission => normalize(permission) === normalize(permissionKey))) {
      throw new ForbiddenError(`User does not hold permission ${permissionKey} to request an approval`)
    }
    return
  }
  if (!capabilityId) throw new ForbiddenError('IAM approval requests require a governed capability scope')
  const context = await loadCallerContext(userId)
  if (!context.iamUserId) throw new ForbiddenError('IAM identity is missing for approval request')
  const result = await authzCheck(context.iamUserId, capabilityId, permissionKey, { tenantId: tenantId ?? undefined })
    .catch(() => ({ allowed: false, reason: 'IAM authorization check was unavailable' } as IamAuthzCheckResponse))
  const adminResult = await authzCheck(context.iamUserId, capabilityId, config.PLATFORM_ADMIN_PERMISSION, { tenantId: tenantId ?? undefined })
    .catch(() => ({ allowed: false } as IamAuthzCheckResponse))
  if (!result.allowed && !adminResult.allowed) throw new ForbiddenError(result.reason || `IAM denied ${permissionKey} for approval request`)
}

export type ApprovalRequestRouting = Pick<
  ApprovalRequest,
  'assignedToId' | 'assignmentMode' | 'teamId' | 'roleKey' | 'skillKey' | 'capabilityId' | 'dueAt'
>

export function approvalRequestRouting(request: ApprovalRequestRouting): ApprovalRouting {
  return {
    assignedToId: request.assignedToId,
    assignmentMode: request.assignmentMode,
    teamId: request.teamId,
    roleKey: request.roleKey,
    skillKey: request.skillKey,
    capabilityId: request.capabilityId,
    dueAt: request.dueAt,
  }
}
