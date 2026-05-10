/**
 * Tiny shared admin-check helper used by routers that gate on "is the caller
 * an admin user?" — e.g. mutation of SYSTEM-tagged variables, deletion of
 * org-wide records.
 *
 * The local `Role.name` strings considered admin are kept in sync with the
 * workflow-template permission helper so routers don't drift.
 */

import { prisma } from '../prisma'

const ADMIN_ROLE_NAMES = ['ADMIN', 'admin', 'Admin', 'SYSTEM_ADMIN', 'SystemAdmin', 'WORKFLOW_ADMIN', 'WorkflowAdmin']

export async function isAdminUser(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      roles: { include: { role: { select: { name: true } } } },
    },
  })
  if (!user) return false
  return user.roles.some(ur => ADMIN_ROLE_NAMES.includes(ur.role.name))
}
