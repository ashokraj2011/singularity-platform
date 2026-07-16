import type { RequestHandler } from 'express'
import { config } from '../../config'
import { ForbiddenError } from '../../lib/errors'
import { authzCheck } from '../../lib/iam/client'
import { resolveTenantFromRequest } from '../../lib/tenant-isolation'

export type StudioAction = 'view' | 'edit'

/**
 * One authorization boundary for the Studio surface. Local auth remains useful
 * for development; IAM deployments must prove the caller's platform permission
 * before any project, board, ingestion, merge, or verdict data is touched.
 */
export async function assertStudioPermission(req: Parameters<RequestHandler>[0], action: StudioAction, resourceType: string): Promise<void> {
  if (config.AUTH_PROVIDER === 'local') return
  const iamUserId = req.iamUser?.id
  if (!iamUserId) throw new ForbiddenError('IAM identity is required for Studio access')
  const tenantId = resolveTenantFromRequest(req) ?? config.WORKGRAPH_DEFAULT_TENANT_ID
  const permission = action === 'view' ? 'workflow:view' : 'workflow:update'
  const decision = await authzCheck(iamUserId, '__platform__', permission, { resourceType, tenantId })
  if (!decision.allowed) {
    throw new ForbiddenError(`Studio access denied: ${permission} (${decision.reason ?? 'IAM policy denied the request'})`)
  }
}

export const studioAuthz: RequestHandler = async (req, _res, next) => {
  try {
    const action: StudioAction = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? 'edit' : 'view'
    await assertStudioPermission(req, action, req.path.includes('/boards') ? 'StudioBoard' : 'StudioProject')
    next()
  } catch (error) {
    next(error)
  }
}
