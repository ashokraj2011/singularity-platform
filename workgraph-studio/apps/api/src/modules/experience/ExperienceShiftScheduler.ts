import cron from 'node-cron'
import { prisma } from '../../lib/prisma'
import { adminPrisma } from '../../lib/admin-prisma'
import { runWithTenantDbContext } from '../../lib/tenant-db-context'
import { autoConfirmDueAttention, runOvernightShift } from './experience.service'

const reader = adminPrisma ?? prisma

function enabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.EXPERIENCE_OVERNIGHT_SHIFT_ENABLED ?? '').toLowerCase())
}

export function startExperienceShiftScheduler(): void {
  if (!enabled()) {
    console.log('Experience overnight shift scheduler disabled')
    return
  }
  const expression = process.env.EXPERIENCE_OVERNIGHT_SHIFT_CRON ?? '0 2 * * *'
  if (!cron.validate(expression)) {
    console.warn(`[experience-shift] invalid EXPERIENCE_OVERNIGHT_SHIFT_CRON: ${expression}; scheduler disabled`)
    return
  }
  const timezone = process.env.EXPERIENCE_OVERNIGHT_SHIFT_TIMEZONE || undefined
  cron.schedule(expression, () => {
    void runExperienceShiftSweep().catch(error => console.error('[experience-shift] sweep failed:', error))
  }, timezone ? { timezone } : undefined)
  console.log(`Experience overnight shift scheduler started (${expression}${timezone ? `, ${timezone}` : ''})`)
}

export async function runExperienceShiftSweep(): Promise<{ projects: number; completed: number; skipped: number; failed: number }> {
  const projects = await reader.specificationProject.findMany({
    where: { status: { in: ['ACTIVE', 'GENERATING', 'IN_REVIEW'] }, archivedAt: null },
    select: { id: true, tenantId: true },
  })
  let completed = 0
  let skipped = 0
  let failed = 0
  const tenants = new Set(projects.map(project => project.tenantId ?? 'default'))
  for (const tenantId of tenants) {
    await runWithTenantDbContext(tenantId, () => autoConfirmDueAttention()).catch(error => console.error(`[experience-shift] auto-confirm failed for tenant ${tenantId}:`, error))
  }
  for (const project of projects) {
    try {
      const result = await runWithTenantDbContext(project.tenantId ?? 'default', () => runOvernightShift(project.id))
      if (result.skipped) skipped += 1
      else completed += 1
    } catch (error) {
      failed += 1
      console.error(`[experience-shift] project ${project.id} failed:`, error)
    }
  }
  return { projects: projects.length, completed, skipped, failed }
}
