import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const service = fs.readFileSync(path.join(process.cwd(), 'src/modules/planner/planner.service.ts'), 'utf8')
const router = fs.readFileSync(path.join(process.cwd(), 'src/modules/planner/planner.router.ts'), 'utf8')
const agentToolsClient = fs.readFileSync(path.join(process.cwd(), 'src/lib/agent-and-tools/client.ts'), 'utf8')

describe('planner capability scope contract', () => {
  it('requires the home capability to be active before planner work can proceed', () => {
    expect(service).toMatch(/async function assertPlannerCapabilityActive\(capabilityId: string, callerToken\?: string\)/)
    expect(service).toMatch(/const capability = await getRuntimeCapability\(capabilityId, callerToken\)/)
    expect(service).toMatch(/Capability \$\{capabilityId\} is not available in the Agent and Tools capability catalog/)
    expect(service).toMatch(/if \(status !== 'ACTIVE'\) \{[\s\S]*?planner converse, commit, and launch require an ACTIVE capability/)
    expect(service).toMatch(/export async function resolveAssignableCapabilities\(homeId: string, allowChildren: boolean, callerToken\?: string\)[\s\S]*?const home = await assertPlannerCapabilityActive\(homeId, callerToken\)/)
  })

  it('filters inactive children and rejects out-of-scope task assignments before creating WorkItems', () => {
    expect(service).toMatch(/const runtimeCapabilities = await listRuntimeCapabilities\(callerToken\)/)
    expect(service).toMatch(/runtimeCapabilities\.filter\(capability => String\(capability\.parentCapabilityId \?\? ''\) === homeId\)/)
    expect(service).toMatch(/if \(isGoverning \|\| capabilityStatus\(capability\) !== 'ACTIVE'\) continue/)
    expect(service).toMatch(/async function assertPlannerAssignmentsActive\(homeId: string, milestones: Milestone\[\], callerToken\?: string\)/)
    expect(service).toMatch(/const caps = await resolveAssignableCapabilities\(homeId, true, callerToken\)[\s\S]*?const invalid = flattenTasks\(milestones\)\.filter\(\(task\) => !allowed\.has\(task\.capabilityId\)\)/)
    expect(service).toMatch(/throw new ValidationError\(`Planner roadmap includes task assignments outside the active capability scope: \$\{labels\}`\)/)
    expect(service).toMatch(/export async function commitRoadmap\(input: CommitInput, actorId: string, callerToken\?: string\)[\s\S]*?await assertPlannerAssignmentsActive\(home, input\.milestones, callerToken\)[\s\S]*?const tasks = flattenTasks\(input\.milestones\)/)
  })

  it('preflights explicit workflow templates before planner launch creates WorkItems', () => {
    expect(service).toMatch(/async function assertPlannerWorkflowTemplateLaunchable\(\s*homeId: string,\s*milestones: Milestone\[\],\s*workflowTemplateId\?: string \| null,\s*callerToken\?: string,\s*\): Promise<void>/)
    expect(service).toMatch(/const workflow = await prisma\.workflow\.findUnique\({[\s\S]*?select: \{[\s\S]*?capabilityId: true,[\s\S]*?archivedAt: true,[\s\S]*?status: true,[\s\S]*?profile: true/)
    expect(service).toMatch(/Workflow template \$\{workflowTemplateId\} is not available for planner launch\./)
    expect(service).toMatch(/workbench-profile template; planner launch requires a main workflow template/)
    expect(service).toMatch(/const targetCapabilityIds = new Set\(flattenTasks\(milestones\)\.map\(\(task\) => task\.capabilityId\)\)/)
    expect(service).toMatch(/export async function launchRoadmap\(input: LaunchInput, actorId: string, callerToken\?: string\)[\s\S]*?await assertPlannerWorkflowTemplateLaunchable\(input\.capabilityId, milestones, input\.workflowTemplateId, callerToken\)[\s\S]*?const commit = await commitRoadmap\(\{ capabilityId: input\.capabilityId, milestones(?:, loopStrategyId: input\.loopStrategyId)? \}, actorId, callerToken\)/)
  })

  it('uses caller IAM tokens and does not crash the API on planner validation errors', () => {
    expect(router).toMatch(/function callerBearerToken\(req: Request\): string \| undefined/)
    expect(router).toMatch(/const result = await launchRoadmap\(body, req\.user!\.userId, callerBearerToken\(req\)\)/)
    expect(router).toMatch(/plannerRouter\.post\('\/launch'[\s\S]*?catch \(err\) \{[\s\S]*?next\(err\)/)
  })

  it('resolves executable capabilities from Agent Runtime', () => {
    expect(agentToolsClient).toMatch(/export async function getRuntimeCapability\(/)
    expect(agentToolsClient).toMatch(/api\/v1\/capabilities\/\$\{encodeURIComponent\(capabilityId\)\}/)
    expect(service).not.toMatch(/getCapability\(capabilityId, callerToken\)/)
  })
})
