/**
 * Auth middleware — strict, AUTH_PROVIDER-gated.
 *
 *   AUTH_PROVIDER=local → verify the local HS256 JWT (offline dev).
 *   AUTH_PROVIDER=iam   → verify the bearer with Singularity IAM.  On success
 *                         lazily mirror the IAM user into the local `users`
 *                         table so all existing FKs (TaskAssignment.assignedToId,
 *                         WorkflowTemplate.createdById, etc.) keep working.
 *
 * `req.user` is always populated with the workgraph-studio User.id (whether
 * locally minted or mirrored from IAM) so downstream code never has to branch.
 */

import type { RequestHandler } from 'express'
import { verifyToken as verifyLocalToken, type JWTUser } from '../lib/jwt'
import { verifyToken as verifyIamToken, IamUnauthorizedError, IamUnavailableError, type IamUser } from '../lib/iam/client'
import { config } from '../config'
import { prisma } from '../lib/prisma'
import { syncIamUserTeams } from '../lib/iam/teamMirror'
import { resolveTenantFromRequest, tenantIsolationStrict, tenantSelectorsFromRequest } from '../lib/tenant-isolation'
import { runWithTenantDbContext } from '../lib/tenant-db-context'

declare global {
  namespace Express {
    interface Request {
      user?:    JWTUser              // local-shape user (always populated when authenticated)
      iamUser?: IamUser              // raw IAM payload, only set when AUTH_PROVIDER=iam
    }
  }
}

/**
 * Upsert a workgraph User row keyed by IAM user-id.  Returns the local user.
 * Lazy mirroring keeps every existing FK working without touching IAM as the
 * source of truth.
 */
async function reconcileAdminRole(userId: string, isSuperAdmin: boolean | undefined): Promise<void> {
  // Finding #8 — keep the local ADMIN binding in sync with IAM's is_super_admin in BOTH
  // directions. Granting mirrors the flag (so legacy permission helpers recognise the
  // user); revoking removes the privilege when IAM demotes them. Provenance keeps this
  // safe: we only ever create/remove bindings tagged source='IAM' and never touch a
  // locally-granted ADMIN (source!='IAM'), so a demotion cannot strip a real local grant.
  const adminRole = await prisma.role.upsert({
    where:  { name: 'ADMIN' },
    update: {},
    create: { name: 'ADMIN', description: 'Mirrored from IAM is_super_admin', isSystemRole: true },
  })
  // Admin status is permission-driven throughout Workgraph. Keep the mirrored
  // role connected to the same catalog entry used by local authorization so a
  // federated super-admin does not depend on a role-name special case.
  const platformPermission = await prisma.permission.upsert({
    where: { name: config.PLATFORM_ADMIN_PERMISSION },
    update: {},
    create: {
      name: config.PLATFORM_ADMIN_PERMISSION,
      resource: 'platform',
      action: 'all',
      description: 'Unrestricted platform administration',
    },
    select: { id: true },
  })
  await prisma.rolePermission.upsert({
    where: { roleId_permissionId: { roleId: adminRole.id, permissionId: platformPermission.id } },
    update: {},
    create: { roleId: adminRole.id, permissionId: platformPermission.id },
  })
  if (isSuperAdmin) {
    // Create an IAM-sourced binding only when none exists — a pre-existing binding
    // (LOCAL or IAM) is left untouched so we never downgrade a genuine local grant.
    await prisma.userRole.upsert({
      where:  { userId_roleId: { userId, roleId: adminRole.id } },
      update: {},
      create: { userId, roleId: adminRole.id, source: 'IAM' },
    })
  } else {
    await prisma.userRole.deleteMany({
      where: { userId, roleId: adminRole.id, source: 'IAM' },
    })
  }
}

async function mirrorIamUser(iamUser: IamUser): Promise<{ id: string; email: string; displayName: string }> {
  const displayName = iamUser.display_name?.trim() || iamUser.email.split('@')[0]

  // Fast path: already mirrored
  const existing = await prisma.user.findUnique({ where: { iamUserId: iamUser.id } })
  if (existing) {
    // Refresh display name + email if IAM changed them
    if (existing.email !== iamUser.email || existing.displayName !== displayName) {
      const updated = await prisma.user.update({
        where: { id: existing.id },
        data:  { email: iamUser.email, displayName },
      })
      await reconcileAdminRole(updated.id, iamUser.is_super_admin)
      return { id: updated.id, email: updated.email, displayName: updated.displayName }
    }
    await reconcileAdminRole(existing.id, iamUser.is_super_admin)
    return { id: existing.id, email: existing.email, displayName: existing.displayName }
  }

  // First sight — create.  Some workgraph DBs may already have a row keyed by
  // the same email (legacy local accounts); attach `iamUserId` to it instead
  // of creating a duplicate.
  const byEmail = await prisma.user.findUnique({ where: { email: iamUser.email } })
  if (byEmail) {
    const linked = await prisma.user.update({
      where: { id: byEmail.id },
      data:  { iamUserId: iamUser.id, displayName },
    })
    await reconcileAdminRole(linked.id, iamUser.is_super_admin)
    return { id: linked.id, email: linked.email, displayName: linked.displayName }
  }

  const created = await prisma.user.create({
    data: {
      email:       iamUser.email,
      displayName,
      iamUserId:   iamUser.id,
      // No local password — this user authenticates only through IAM.
      passwordHash: null,
      isActive:     true,
    },
  })
  await reconcileAdminRole(created.id, iamUser.is_super_admin)
  return { id: created.id, email: created.email, displayName: created.displayName }
}

function isIamServicePrincipal(iamUser: IamUser): boolean {
  return iamUser.id.startsWith('service:') || iamUser.email.endsWith('@service.local')
}

export function iamTokenKind(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
    const kind = payload.kind
    return typeof kind === 'string' && kind.trim() ? kind.trim().toLowerCase() : undefined
  } catch {
    return undefined
  }
}

export function isNonUserIamTokenKind(token: string): boolean {
  const kind = iamTokenKind(token)
  return Boolean(kind && kind !== 'user')
}

export const authMiddleware: RequestHandler = async (req, res, next) => {
  let authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ') && req.path.endsWith('/events/stream')) {
    const queryToken = typeof req.query.access_token === 'string' ? req.query.access_token : undefined
    if (queryToken) authHeader = `Bearer ${queryToken}`
  }
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' })
    return
  }
  const token = authHeader.slice(7)

  try {
    if (config.AUTH_PROVIDER === 'iam') {
      if (!config.IAM_BASE_URL) {
        res.status(500).json({ code: 'CONFIG', message: 'AUTH_PROVIDER=iam but IAM_BASE_URL is not set' })
        return
      }
      const iamUser = await verifyIamToken(token)
      if (isNonUserIamTokenKind(token)) {
        res.status(403).json({
          code: 'NON_USER_TOKEN_NOT_USER_AUTH',
          message: 'IAM service/device tokens are not accepted on user-facing Workgraph routes; use a real user session token.',
        })
        return
      }
      if (isIamServicePrincipal(iamUser)) {
        res.status(403).json({
          code: 'SERVICE_TOKEN_NOT_USER_AUTH',
          message: 'IAM service tokens are not accepted on user-facing Workgraph routes; use a dedicated internal service endpoint.',
        })
        return
      }
      const tenantSelectors = tenantSelectorsFromRequest(req)
      if (tenantSelectors.length > 1) {
        res.status(400).json({
          code: 'CONFLICTING_TENANT_CONTEXT',
          message: 'Tenant must be specified consistently across headers, query parameters, and body.',
        })
        return
      }
      const requestedTenant = resolveTenantFromRequest(req)
      const tokenTenants = [...new Set((iamUser.tenant_ids ?? []).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))]
      // In strict mode the bearer must carry a tenant membership claim. IAM's
      // /authz/check remains the final permission decision, but this early
      // binding prevents a caller-controlled X-Tenant-Id from selecting the
      // database scope before route authorization runs.
      if (tenantIsolationStrict() && (!requestedTenant || tokenTenants.length === 0 || !tokenTenants.includes(requestedTenant))) {
        res.status(403).json({
          code: 'TENANT_NOT_BOUND_TO_TOKEN',
          message: 'The requested tenant is not present in the authenticated IAM token. Sign in again after tenant membership is granted.',
        })
        return
      }
      if (requestedTenant && tokenTenants.length > 0 && !tokenTenants.includes(requestedTenant)) {
        res.status(403).json({ code: 'TENANT_NOT_BOUND_TO_TOKEN', message: 'The requested tenant is not available to this user.' })
        return
      }
      const mirrored = await mirrorIamUser(iamUser)
      await syncIamUserTeams(mirrored.id, iamUser.id, token).catch((err) => {
        console.warn(`[auth] IAM team mirror skipped for ${iamUser.id}: ${(err as Error).message}`)
      })
      req.iamUser = iamUser
      req.user    = { userId: mirrored.id, email: mirrored.email, displayName: mirrored.displayName }
      // Re-enter the tenant context after authentication so downstream code
      // cannot retain an unverified selector from the pre-auth middleware.
      runWithTenantDbContext(requestedTenant, next)
      return
    }

    // Local provider — keep current HS256 behaviour.
    req.user = await verifyLocalToken(token)
    next()
  } catch (err) {
    if (err instanceof IamUnauthorizedError) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: err.message })
      return
    }
    if (err instanceof IamUnavailableError) {
      res.status(503).json({ code: 'IAM_UNAVAILABLE', message: 'Identity provider is unreachable. Please retry.' })
      return
    }
    res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' })
  }
}
