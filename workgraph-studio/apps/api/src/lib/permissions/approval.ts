import type { ApprovalRequest } from '@prisma/client'
import { config } from '../../config'
import { ForbiddenError } from '../errors'
import { authzCheck } from '../iam/client'
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
}

type LocalActor = {
  id: string
  permissionKeys: string[]
}

export type ApprovalEligibility = {
  allowed: boolean
  reason: string
  source: 'local' | 'iam'
}

function normalize(value: string | null | undefined): string {
  return String(value ?? '').trim().toUpperCase()
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
  if (routing.assignedToId && routing.assignedToId !== userId) {
    return { allowed: false, reason: 'approval is assigned to another user', source: 'local' }
  }
  if (routing.dueAt && routing.dueAt.getTime() <= now.getTime()) {
    return { allowed: false, reason: 'approval request has expired', source: 'local' }
  }
  if (routing.teamId && !context.teamIds.includes(routing.teamId)) {
    return { allowed: false, reason: 'user is not a member of the approval team', source: 'local' }
  }
  if (routing.skillKey && !context.skillKeys.includes(routing.skillKey)) {
    return { allowed: false, reason: 'user does not hold the required approval skill', source: 'local' }
  }
  const normalizedPermissions = new Set(permissionKeys.map(normalize))
  if (!normalizedPermissions.has(normalize(permissionKey)) && !normalizedPermissions.has('PLATFORM:ALL')) {
    return { allowed: false, reason: `user does not hold permission ${permissionKey}`, source: 'local' }
  }
  return { allowed: true, reason: `local permission ${permissionKey} and routing matched`, source: 'local' }
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

  if (routing.assignedToId && routing.assignedToId !== userId) {
    return { allowed: false, reason: 'approval is assigned to another user', source: config.AUTH_PROVIDER === 'iam' ? 'iam' : 'local' }
  }
  if (routing.dueAt && routing.dueAt.getTime() <= Date.now()) {
    return { allowed: false, reason: 'approval request has expired', source: config.AUTH_PROVIDER === 'iam' ? 'iam' : 'local' }
  }

  const actor = await loadLocalActor(userId)
  if (!actor) return { allowed: false, reason: 'approving user was not found', source: config.AUTH_PROVIDER === 'iam' ? 'iam' : 'local' }

  const context = await loadCallerContext(userId)
  if (routing.teamId && !context.teamIds.includes(routing.teamId)) {
    return { allowed: false, reason: 'user is not a member of the approval team', source: config.AUTH_PROVIDER === 'iam' ? 'iam' : 'local' }
  }
  if (routing.skillKey && !context.skillKeys.includes(routing.skillKey)) {
    return { allowed: false, reason: 'user does not hold the required approval skill', source: config.AUTH_PROVIDER === 'iam' ? 'iam' : 'local' }
  }

  if (config.AUTH_PROVIDER !== 'iam') {
    return evaluateLocalApprovalRouting({
      userId,
      routing,
      context,
      permissionKeys: actor.permissionKeys,
      permissionKey,
    })
  }

  // In IAM mode, approval must be scoped to the governed capability.  This
  // prevents a platform user from approving a capability merely because the
  // request id was discoverable.  Legacy unscoped rows fail closed.
  if (!routing.capabilityId) {
    return { allowed: false, reason: 'approval has no governed capability scope', source: 'iam' }
  }
  if (!context.iamUserId) {
    return { allowed: false, reason: 'IAM identity is missing for approving user', source: 'iam' }
  }

  const result = await authzCheck(
    context.iamUserId,
    routing.capabilityId,
    permissionKey,
    { resourceType: options.resourceType ?? 'ApprovalRequest', resourceId: options.resourceId },
  ).catch(() => ({ allowed: false, reason: 'IAM authorization check was unavailable' }))

  if (!result.allowed) {
    return { allowed: false, reason: result.reason || `IAM denied ${permissionKey}`, source: 'iam' }
  }
  return { allowed: true, reason: `IAM granted ${permissionKey} on the governed capability`, source: 'iam' }
}

export async function assertCanDecideApproval(
  userId: string,
  routing: ApprovalRouting,
  options: ApprovalAuthorizationOptions = {},
): Promise<void> {
  const result = await canDecideApproval(userId, routing, options)
  if (!result.allowed) {
    const resource = options.resourceType && options.resourceId
      ? ` for ${options.resourceType} ${options.resourceId}`
      : ''
    throw new ForbiddenError(`User is not authorized to decide this approval${resource}: ${result.reason}`)
  }
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
