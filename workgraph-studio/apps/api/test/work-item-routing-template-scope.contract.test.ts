import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const service = fs.readFileSync(path.join(process.cwd(), 'src/modules/work-items/work-item-routing.service.ts'), 'utf8')

describe('work item routing template scope contract', () => {
  it('filters caller-supplied workflow ids to active top-level templates in the target capability', () => {
    expect(service).toMatch(/if \(args\.workflowId\) \{[\s\S]*?prisma\.workflow\.findFirst/)
    expect(service).toMatch(/id: args\.workflowId,[\s\S]*?capabilityId: args\.capabilityId,[\s\S]*?archivedAt: null,[\s\S]*?status: \{ not: 'ARCHIVED' \},[\s\S]*?profile: \{ not: 'workbench' \}/)
    expect(service).toMatch(/Workbench-profile templates[\s\S]*?CALL_WORKFLOW node/)
  })

  it('excludes workbench-profile templates during automatic workflow selection', () => {
    expect(service).toMatch(/const workflowTypeKey = normalizeMetadataKey\(args\.workflowTypeKey \?\? args\.workItemTypeKey\)/)
    expect(service).toMatch(/workflowTypeKey: \{ in: \[workflowTypeKey, 'GENERAL'\] \},[\s\S]*?orderBy: \[\{ isDefaultForType: 'desc' \}/)
    expect(service).toMatch(/where: \{[\s\S]*?capabilityId: args\.capabilityId,[\s\S]*?archivedAt: null,[\s\S]*?status: \{ not: 'ARCHIVED' \},[\s\S]*?profile: \{ not: 'workbench' \}/)
  })
})
