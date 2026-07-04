import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const service = fs.readFileSync(path.join(process.cwd(), 'src/modules/work-items/work-items.service.ts'), 'utf8')

describe('work item create template scope contract', () => {
  it('normalizes and validates target capability ids before any persistence', () => {
    expect(service).toMatch(/const targets: WorkItemTargetInput\[\] = Array\.isArray\(input\.targets\)[\s\S]*?targetCapabilityId: String\(row\.targetCapabilityId \?\? ''\)\.trim\(\)/)
    expect(service).toMatch(/childWorkflowTemplateId: String\(row\.childWorkflowTemplateId \?\? ''\)\.trim\(\) \|\| undefined/)
    expect(service).toMatch(/if \(targets\.some\(\(target\) => !target\.targetCapabilityId\)\) \{[\s\S]*?WorkItem target capability id is required for every target/)
    expect(service).toMatch(/WorkItem target capability id is required for every target[\s\S]*?await assertStartableWorkItemTemplate[\s\S]*?const workItem = await prisma\.workItem\.create/)
  })

  it('preflights pre-bound target workflow templates before persisting a WorkItem', () => {
    expect(service).toMatch(/export async function createWorkItem\(input: CreateWorkItemInput, actorId\?: string \| null\)/)
    expect(service).toMatch(/if \(targets\.length === 0\) throw new ValidationError\('WorkItem requires at least one child capability target'\)/)
    expect(service).toMatch(/for \(const target of targets\) \{[\s\S]*?if \(!target\.childWorkflowTemplateId\) continue[\s\S]*?await assertStartableWorkItemTemplate\(\{[\s\S]*?templateId: target\.childWorkflowTemplateId,[\s\S]*?targetCapabilityId: target\.targetCapabilityId/)
    expect(service).toMatch(/await assertStartableWorkItemTemplate[\s\S]*?const workItem = await prisma\.workItem\.create/)
  })

  it('uses the same template availability, capability, and profile guard as manual start', () => {
    expect(service).toMatch(/async function assertStartableWorkItemTemplate\(args: \{[\s\S]*?templateId: string[\s\S]*?targetCapabilityId: string/)
    expect(service).toMatch(/Workflow template \$\{args\.templateId\} is not available for this WorkItem target/)
    expect(service).toMatch(/template\.capabilityId !== args\.targetCapabilityId/)
    expect(service).toMatch(/template\.profile === 'workbench'/)
  })
})
