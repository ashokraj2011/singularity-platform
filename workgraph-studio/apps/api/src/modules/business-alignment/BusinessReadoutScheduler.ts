import cron from 'node-cron'
import { prisma } from '../../lib/prisma'
import { adminPrisma } from '../../lib/admin-prisma'
import { runWithTenantDbContext } from '../../lib/tenant-db-context'
import { generateBusinessReadout } from './business-alignment.service'
import { previousCompleteUtcWeek } from './business-alignment'

const schedulerReader = adminPrisma ?? prisma

function enabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.BUSINESS_WEEKLY_READOUT_ENABLED ?? '').toLowerCase())
}

export function startBusinessReadoutScheduler(): void {
  if (!enabled()) {
    console.log('Business weekly readout scheduler disabled')
    return
  }
  const expression = process.env.BUSINESS_WEEKLY_READOUT_CRON ?? '0 8 * * 1'
  if (!cron.validate(expression)) {
    console.warn(`[business-readout] invalid BUSINESS_WEEKLY_READOUT_CRON: ${expression}; scheduler disabled`)
    return
  }
  const timezone = process.env.BUSINESS_WEEKLY_READOUT_TIMEZONE || undefined
  cron.schedule(expression, () => {
    void generateWeeklyReadouts().catch(error => console.error('[business-readout] weekly sweep failed:', error))
  }, timezone ? { timezone } : undefined)
  console.log(`Business weekly readout scheduler started (${expression}${timezone ? `, ${timezone}` : ''})`)
}

export async function generateWeeklyReadouts(now = new Date()): Promise<{ generated: number; skipped: number; failed: number }> {
  const { periodStart, periodEnd } = previousCompleteUtcWeek(now)
  const projects = await schedulerReader.specificationProject.findMany({
    where: { status: { in: ['ACTIVE', 'GENERATING', 'IN_REVIEW'] }, archivedAt: null },
    select: { id: true, tenantId: true },
  })
  let generated = 0
  let skipped = 0
  let failed = 0
  for (const project of projects) {
    const projectTenantId = project.tenantId ?? 'default'
    try {
      const existing = await schedulerReader.businessReadout.findFirst({
        where: {
          studioProjectId: project.id,
          tenantId: projectTenantId,
          kind: 'WEEKLY',
          periodStart,
          periodEnd,
        },
        select: { id: true },
      })
      if (existing) {
        skipped += 1
        continue
      }
      await runWithTenantDbContext(projectTenantId, () => generateBusinessReadout(project.id, {
        kind: 'WEEKLY',
        periodStart,
        periodEnd,
      }, 'business-readout-scheduler'))
      generated += 1
    } catch (error) {
      failed += 1
      console.error(`[business-readout] project ${project.id} failed:`, error)
    }
  }
  return { generated, skipped, failed }
}
