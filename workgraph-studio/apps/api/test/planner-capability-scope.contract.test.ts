import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const service = fs.readFileSync(path.join(process.cwd(), 'src/modules/planner/planner.service.ts'), 'utf8')

describe('planner capability scope contract', () => {
  it('requires the home capability to be active before planner work can proceed', () => {
    expect(service).toMatch(/async function assertPlannerCapabilityActive\(capabilityId: string\)/)
    expect(service).toMatch(/if \(!capability\) throw new ValidationError\(`Capability \$\{capabilityId\} is not available to the planner\.`\)/)
    expect(service).toMatch(/if \(status !== 'ACTIVE'\) \{[\s\S]*?planner converse, commit, and launch require an ACTIVE capability/)
    expect(service).toMatch(/export async function resolveAssignableCapabilities[\s\S]*?const home = await assertPlannerCapabilityActive\(homeId\)/)
  })

  it('filters inactive children and rejects out-of-scope task assignments before creating WorkItems', () => {
    expect(service).toMatch(/if \(!cap \|\| cap\.isGoverning \|\| capabilityStatus\(cap\) !== 'ACTIVE'\) continue/)
    expect(service).toMatch(/async function assertPlannerAssignmentsActive\(homeId: string, milestones: Milestone\[\]\)/)
    expect(service).toMatch(/const caps = await resolveAssignableCapabilities\(homeId, true\)[\s\S]*?const invalid = flattenTasks\(milestones\)\.filter\(\(task\) => !allowed\.has\(task\.capabilityId\)\)/)
    expect(service).toMatch(/throw new ValidationError\(`Planner roadmap includes task assignments outside the active capability scope: \$\{labels\}`\)/)
    expect(service).toMatch(/export async function commitRoadmap[\s\S]*?await assertPlannerAssignmentsActive\(home, input\.milestones\)[\s\S]*?const tasks = flattenTasks\(input\.milestones\)/)
  })

  it('preflights explicit workflow templates before planner launch creates WorkItems', () => {
    expect(service).toMatch(/async function assertPlannerWorkflowTemplateLaunchable\(\s*homeId: string,\s*milestones: Milestone\[\],\s*workflowTemplateId\?: string \| null,\s*\): Promise<void>/)
    expect(service).toMatch(/const workflow = await prisma\.workflow\.findUnique\({[\s\S]*?select: \{[\s\S]*?capabilityId: true,[\s\S]*?archivedAt: true,[\s\S]*?status: true,[\s\S]*?profile: true/)
    expect(service).toMatch(/Workflow template \$\{workflowTemplateId\} is not available for planner launch\./)
    expect(service).toMatch(/workbench-profile template; planner launch requires a main workflow template/)
    expect(service).toMatch(/const targetCapabilityIds = new Set\(flattenTasks\(milestones\)\.map\(\(task\) => task\.capabilityId\)\)/)
    expect(service).toMatch(/export async function launchRoadmap[\s\S]*?await assertPlannerWorkflowTemplateLaunchable\(input\.capabilityId, milestones, input\.workflowTemplateId\)[\s\S]*?const commit = await commitRoadmap/)
  })
})
