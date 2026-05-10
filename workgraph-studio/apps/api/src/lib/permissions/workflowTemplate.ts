import { prisma } from '../prisma'
import { ForbiddenError } from '../errors'
import { logEvent } from '../audit'
import { authzCheck, IamUnavailableError } from '../iam/client'
import { config } from '../../config'

/**
 * Permission helper for workflow templates.
 *
 * When `template.capabilityId` is set:
 *   → ABAC via Singularity IAM.  Calls `authzCheck(iamUserId, capabilityId, action)`.
 *   → If IAM is unavailable, fail-closed by default (return false / throw 503-equiv).
 *
 * When `template.capabilityId` is null (legacy):
 *   → Fall back to the original team-membership rule:
 *       admin || creator || same team.
 *
 * The action passed to IAM follows IAM's verbs: `view`, `edit`, `start`.
 */

const ADMIN_ROLE_NAMES = ['ADMIN', 'admin', 'Admin', 'SYSTEM_ADMIN', 'SystemAdmin', 'WORKFLOW_ADMIN', 'WorkflowAdmin']

type TemplateOwnership = {
  id: string
  createdById: string | null
  teamId: string
  capabilityId: string | null
}

async function loadActor(userId: string): Promise<{
  id: string
  iamUserId: string | null
  teamId: string | null
  isAdmin: boolean
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      iamUserId: true,
      teamId: true,
      roles: { include: { role: { select: { name: true } } } },
    },
  })
  if (!user) return { id: userId, iamUserId: null, teamId: null, isAdmin: false }
  const isAdmin = user.roles.some(ur => ADMIN_ROLE_NAMES.includes(ur.role.name))
  return { id: user.id, iamUserId: user.iamUserId, teamId: user.teamId, isAdmin }
}

async function loadTemplate(templateId: string): Promise<TemplateOwnership | null> {
  const t = await prisma.workflow.findUnique({
    where: { id: templateId },
    select: { id: true, createdById: true, teamId: true, capabilityId: true },
  })
  return t
}

function decideLegacy(
  actor: { id: string; teamId: string | null; isAdmin: boolean },
  template: TemplateOwnership,
): boolean {
  if (actor.isAdmin) return true
  if (template.createdById && template.createdById === actor.id) return true
  if (actor.teamId && actor.teamId === template.teamId) return true
  return false
}

async function decideViaIam(
  actor: { id: string; iamUserId: string | null; isAdmin: boolean },
  template: TemplateOwnership,
  action: 'view' | 'edit' | 'start',
): Promise<boolean> {
  // workgraph-studio admins always allowed (mirrors local behaviour)
  if (actor.isAdmin) return true
  // IAM authz needs the IAM-side user id.  Without it, the user is local-only
  // → fail closed unless they're the creator (legacy compatibility).
  if (!actor.iamUserId) {
    return template.createdById === actor.id
  }
  try {
    const result = await authzCheck(actor.iamUserId, template.capabilityId!, action, {
      resourceType: 'WorkflowTemplate', resourceId: template.id,
    })
    return result.allowed
  } catch (err) {
    if (err instanceof IamUnavailableError) {
      // Fail-closed: treat as denied. Caller can surface a 503-style message.
      console.error('IAM authz unavailable; denying:', err.message)
      return false
    }
    throw err
  }
}

async function decide(
  actor: { id: string; iamUserId: string | null; teamId: string | null; isAdmin: boolean },
  template: TemplateOwnership,
  action: 'view' | 'edit' | 'start',
): Promise<boolean> {
  // IAM path when both the template is capability-bound AND the runtime is
  // configured to delegate auth.  Otherwise fall through to legacy.
  if (template.capabilityId && config.AUTH_PROVIDER === 'iam') {
    return decideViaIam(actor, template, action)
  }
  return decideLegacy(actor, template)
}

export async function canEditTemplate(userId: string, templateId: string): Promise<boolean> {
  const [actor, template] = await Promise.all([loadActor(userId), loadTemplate(templateId)])
  if (!template) return false
  return decide(actor, template, 'edit')
}

export async function canViewTemplate(userId: string, templateId: string): Promise<boolean> {
  const [actor, template] = await Promise.all([loadActor(userId), loadTemplate(templateId)])
  if (!template) return false
  return decide(actor, template, 'view')
}

export async function canStartTemplate(userId: string, templateId: string): Promise<boolean> {
  const [actor, template] = await Promise.all([loadActor(userId), loadTemplate(templateId)])
  if (!template) return false
  return decide(actor, template, 'start')
}

export async function assertTemplatePermission(
  userId: string,
  templateId: string,
  action: 'view' | 'edit' | 'start',
): Promise<TemplateOwnership> {
  const [actor, template] = await Promise.all([loadActor(userId), loadTemplate(templateId)])
  if (!template) throw new ForbiddenError(`WorkflowTemplate ${templateId} not found or not accessible`)
  if (!(await decide(actor, template, action))) {
    await logEvent('PermissionDenied', 'WorkflowTemplate', templateId, userId, {
      action,
      via: template.capabilityId && config.AUTH_PROVIDER === 'iam' ? 'iam' : 'legacy',
      capabilityId: template.capabilityId,
    })
    throw new ForbiddenError(`User does not have ${action} permission on this workflow template`)
  }
  return template
}

export async function assertInstancePermission(
  userId: string,
  instanceId: string,
  action: 'view' | 'edit' | 'start',
): Promise<void> {
  const instance = await prisma.workflowInstance.findUnique({
    where: { id: instanceId },
    select: { id: true, templateId: true, createdById: true },
  })
  if (!instance) throw new ForbiddenError(`WorkflowInstance ${instanceId} not found or not accessible`)

  if (instance.templateId) {
    await assertTemplatePermission(userId, instance.templateId, action)
    return
  }

  // No template — allow creator or admin only
  const actor = await loadActor(userId)
  if (actor.isAdmin) return
  if (instance.createdById && instance.createdById === actor.id) return
  await logEvent('PermissionDenied', 'WorkflowInstance', instanceId, userId, { action })
  throw new ForbiddenError(`User does not have ${action} permission on this workflow instance`)
}

export async function resolveDefaultTeamId(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { teamId: true } })
  if (user?.teamId) return user.teamId
  const fallback = await prisma.team.findFirst({ where: { name: 'Default' }, select: { id: true } })
  if (fallback) return fallback.id
  const created = await prisma.team.create({
    data: { name: 'Default', description: 'Auto-created default team for workflow templates' },
    select: { id: true },
  })
  return created.id
}
