/**
 * Tiny shared admin-check helper used by routers that gate on "is the caller
 * an admin user?" — e.g. mutation of SYSTEM-tagged variables, deletion of
 * org-wide records.
 *
 * Admin is a permission, not a role-name convention.  The permission key is
 * configurable so local roles can be renamed or replaced without changing
 * application code.
 */

import { prisma } from '../prisma'
import { config } from '../../config'

export async function isAdminUser(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      roles: {
        select: {
          role: {
            select: { permissions: { select: { permission: { select: { name: true } } } } },
          },
        },
      },
    },
  })
  if (!user) return false
  const required = config.PLATFORM_ADMIN_PERMISSION.trim().toUpperCase()
  return user.roles.some(ur => ur.role.permissions.some(rp => rp.permission.name.trim().toUpperCase() === required))
}
