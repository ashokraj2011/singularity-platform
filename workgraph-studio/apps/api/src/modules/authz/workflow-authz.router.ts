import { Router } from 'express'
import { prisma } from '../../lib/prisma'
import { proxyGet } from '../../lib/iam/client'
import { tokenFromAuthorizationHeader } from '../../lib/iam/teamMirror'
import { config } from '../../config'
import { requireTenantFromRequest } from '../../lib/tenant-isolation'

export const workflowAuthzRouter: Router = Router()

workflowAuthzRouter.get('/effective-access', async (req, res, next) => {
  try {
    const tenantId = requireTenantFromRequest(req, 'effective access') ?? config.WORKGRAPH_DEFAULT_TENANT_ID
    const token = tokenFromAuthorizationHeader(req.headers.authorization)
    if (config.AUTH_PROVIDER === 'iam') {
      const result = await proxyGet('/authz/effective-access', { tenant_id: tenantId }, token)
      res.json(result)
      return
    }

    const actor = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        roles: { select: { role: { select: { name: true, permissions: { select: { permission: { select: { name: true } } } } } } } },
      },
    })
    const permissions = [...new Set(actor?.roles.flatMap(role => role.role.permissions.map(item => item.permission.name)) ?? [])].sort()
    res.json({ user_id: req.user!.userId, tenant_id: tenantId, permissions, policy_version: 'workgraph-local-v1' })
  } catch (err) { next(err) }
})
