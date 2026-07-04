import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const router = fs.readFileSync(path.join(process.cwd(), 'src/modules/work-items/work-item-routing.router.ts'), 'utf8')

describe('work item routing policy template scope contract', () => {
  it('validates policy workflow ids against availability, profile, and capability', () => {
    expect(router).toMatch(/async function assertRoutingPolicyWorkflowStartable\(capabilityId: string, workflowId\?: string \| null\): Promise<void>/)
    expect(router).toMatch(/Workflow \$\{workflowId\} is not available for WorkItem routing policies\./)
    expect(router).toMatch(/workbench-profile template; routing policies must target a main workflow/)
    expect(router).toMatch(/workflow\.capabilityId !== capabilityId/)
  })

  it('preflights routing policy create before persistence', () => {
    expect(router).toMatch(/workItemRoutingPoliciesRouter\.post\('\/'[\s\S]*?await assertRoutingPolicyWorkflowStartable\(body\.capabilityId, body\.workflowId\)[\s\S]*?prisma\.workItemRoutingPolicy\.create/)
  })

  it('preflights routing policy updates with the effective capability and workflow id', () => {
    expect(router).toMatch(/const current = await prisma\.workItemRoutingPolicy\.findUnique\({[\s\S]*?select: \{ capabilityId: true, workflowId: true \}/)
    expect(router).toMatch(/const effectiveCapabilityId = body\.capabilityId \?\? current\?\.capabilityId/)
    expect(router).toMatch(/const effectiveWorkflowId = body\.workflowId !== undefined \? body\.workflowId : current\?\.workflowId/)
    expect(router).toMatch(/await assertRoutingPolicyWorkflowStartable\(effectiveCapabilityId, effectiveWorkflowId\)[\s\S]*?prisma\.workItemRoutingPolicy\.update/)
  })

  it('returns workflow template diagnostics for existing routing policies', () => {
    expect(router).toMatch(/function routingPolicyWorkflowStatus\(policy: \{[\s\S]*?workflowId\?: string \| null/)
    expect(router).toMatch(/reason: 'MISSING_TEMPLATE'/)
    expect(router).toMatch(/reason: 'ARCHIVED_TEMPLATE'/)
    expect(router).toMatch(/reason: 'WORKBENCH_PROFILE_TEMPLATE'/)
    expect(router).toMatch(/reason: 'CAPABILITY_MISMATCH'/)
    expect(router).toMatch(/state: 'valid'/)
    expect(router).toMatch(/workflowTemplateStatus: routingPolicyWorkflowStatus\(item\)/)
    expect(router).toMatch(/include: \{[\s\S]*?workflow: \{[\s\S]*?capabilityId: true,[\s\S]*?archivedAt: true,[\s\S]*?status: true,[\s\S]*?profile: true/)
  })
})
