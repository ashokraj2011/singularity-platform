import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const router = fs.readFileSync(path.join(process.cwd(), 'src/modules/work-items/work-items.router.ts'), 'utf8')

describe('work item target workflow template diagnostics contract', () => {
  it('classifies stale pre-bound target workflow template ids in API responses', () => {
    expect(router).toMatch(/function targetTemplateStatus\(target: WorkItemTargetForDiagnostics, template\?: WorkflowTemplateForDiagnostics\)/)
    expect(router).toMatch(/reason: 'MISSING_TEMPLATE'/)
    expect(router).toMatch(/reason: 'ARCHIVED_TEMPLATE'/)
    expect(router).toMatch(/reason: 'WORKBENCH_PROFILE_TEMPLATE'/)
    expect(router).toMatch(/reason: 'CAPABILITY_MISMATCH'/)
    expect(router).toMatch(/state: 'valid'/)
  })

  it('decorates list and detail WorkItem targets with workflowTemplateStatus', () => {
    expect(router).toMatch(/async function withTargetTemplateDiagnostics<T extends WorkItemForDiagnostics>\(items: T\[\]\)/)
    expect(router).toMatch(/workflowTemplateStatus: targetTemplateStatus\(target, byId\.get\(target\.childWorkflowTemplateId\)\)/)
    expect(router).toMatch(/const items = await withTargetTemplateDiagnostics\(visible\)[\s\S]*?res\.json\(\{ items, nextCursor/)
    expect(router).toMatch(/const \[diagnosed\] = await withTargetTemplateDiagnostics\(\[workItem\]\)[\s\S]*?res\.json\(diagnosed \?\? workItem\)/)
  })
})
