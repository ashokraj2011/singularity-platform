import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const service = fs.readFileSync(path.join(process.cwd(), 'src/modules/work-items/work-items.service.ts'), 'utf8')

describe('work item target start template scope contract', () => {
  it('validates template availability, target capability, and profile before cloning a child run', () => {
    expect(service).toMatch(/async function assertStartableWorkItemTemplate\(args: \{[\s\S]*?templateId: string[\s\S]*?targetCapabilityId: string/)
    expect(service).toMatch(/select: \{[\s\S]*?capabilityId: true,[\s\S]*?archivedAt: true,[\s\S]*?status: true,[\s\S]*?profile: true,[\s\S]*?name: true/)
    expect(service).toMatch(/Workflow template \$\{args\.templateId\} is not available for this WorkItem target/)
    expect(service).toMatch(/template\.capabilityId !== args\.targetCapabilityId/)
    expect(service).toMatch(/template\.profile === 'workbench'/)
  })

  it('runs the template preflight after authorization and before cloneDesignToRun', () => {
    expect(service).toMatch(/await assertTemplatePermission\(userId, templateId, 'start'\)[\s\S]*?await assertStartableWorkItemTemplate\(\{ templateId, targetCapabilityId: target\.targetCapabilityId \}\)[\s\S]*?cloneDesignToRun\(/)
  })
})
