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
async function ensureAdminRole(userId: string): Promise<void> {
  // Mirror IAM's `is_super_admin=true` into a local ADMIN role binding so the
  // legacy permission helpers (decideLegacy / canStartTemplate / …) recognise
  // the user without us having to plumb the IAM flag through every check.
  const adminRole = await prisma.role.upsert({
    where:  { name: 'ADMIN' },
    update: {},
    create: { name: 'ADMIN', description: 'Mirrored from IAM is_super_admin', isSystemRole: true },
  })
  await prisma.userRole.createMany({
    data: [{ userId, roleId: adminRole.id }],
    skipDuplicates: true,
  })
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
      if (iamUser.is_super_admin) await ensureAdminRole(updated.id)
      return { id: updated.id, email: updated.email, displayName: updated.displayName }
    }
    if (iamUser.is_super_admin) await ensureAdminRole(existing.id)
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
    if (iamUser.is_super_admin) await ensureAdminRole(linked.id)
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
  if (iamUser.is_super_admin) await ensureAdminRole(created.id)
  return { id: created.id, email: created.email, displayName: created.displayName }
}

export const authMiddleware: RequestHandler = async (req, res, next) => {
  const authHeader = req.headers.authorization
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
      const mirrored = await mirrorIamUser(iamUser)
      await syncIamUserTeams(mirrored.id, iamUser.id, token).catch((err) => {
        console.warn(`[auth] IAM team mirror skipped for ${iamUser.id}: ${(err as Error).message}`)
      })
      req.iamUser = iamUser
      req.user    = { userId: mirrored.id, email: mirrored.email, displayName: mirrored.displayName }
      next()
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
