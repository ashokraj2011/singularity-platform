import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('workflow authorization hardening contracts', () => {
  it('defines typed resource actions and immutable run snapshots', () => {
    const authz = read('src/lib/permissions/workflowTemplate.ts')
    const schema = read('prisma/schema.prisma')
    expect(authz).toContain('export type WorkflowAction')
    expect(authz).toContain('workflow:template:publish')
    expect(authz).toContain('authorizationSnapshotDigest')
    expect(schema).toContain('model WorkflowAccessGrant')
    expect(schema).toContain('model WorkflowAuthorizationSnapshot')
  })

  it('protects lifecycle and workflow operation surfaces', () => {
    const lifecycle = read('src/modules/workflow/lifecycle.router.ts')
    const operations = read('src/modules/workflow-operations/workflow-operations.router.ts')
    const templates = read('src/modules/workflow/templates.router.ts')
    expect(lifecycle).toContain("assertInstancePermission(req.user!.userId, req.params.id, 'simulate')")
    expect(lifecycle).toContain("assertInstancePermission(req.user!.userId, req.params.id, 'replay')")
    expect(operations).toMatch(/assertWorkflowOperationsPermission\(req\.user\.userId, 'view', tenantId\)/)
    expect(operations).toMatch(/canViewWorkflowOperations\(req\.user\.userId, 'audit_view', tenantId\)/)
    expect(templates).toContain("assertTemplatePermission(req.user!.userId, req.params.id, 'view')")
    expect(templates).toContain('workflowAccessGrant')
    expect(templates).toContain("where: { id, status: 'DRAFT'")
    expect(templates).toContain('WORKFLOW_DESIGN_FROZEN')
  })

  it('protects trigger and routing configuration with capability-scoped decisions', () => {
    const routing = read('src/modules/work-items/work-item-routing.router.ts')
    const triggers = read('src/modules/workflow/triggers/triggers.router.ts')
    expect(routing).toContain('assertCapabilityPermission')
    expect(routing).toContain('canCapabilityPermission')
    expect(routing).toContain('tenantForRequest')
    expect(routing).toContain("workItemRoutingPoliciesRouter.delete('/:id'")
    expect(routing).toContain("workItemTriggersRouter.delete('/:id'")
    expect(triggers).toContain("assertTemplatePermission(req.user!.userId, body.templateId, 'edit')")
    expect(triggers).toContain('canViewTemplate')
  })

  it('protects generation plans, actuals, and baseline amendments', () => {
    const contractBound = read('src/modules/work-items/contract-bound.router.ts')
    expect(contractBound).toContain('assertGenerationProjectAccess')
    expect(contractBound).toContain('assertGenerationPlanAccess')
    expect(contractBound).toContain("assertGenerationPlanAccess(req, String(req.params.planId), 'edit')")
    expect(contractBound).toContain('await resolvePrimaryCapability(req, project.primaryCapabilityId)')
    expect(contractBound).toContain('await resolvePrimaryCapability(req, plan.specificationProject.primaryCapabilityId)')
    expect(contractBound).toContain('row.targetCapabilityId !== project.primaryCapabilityId')
    expect(contractBound).toContain('row.targetCapabilityId !== plan.specificationProject.primaryCapabilityId')
    expect(contractBound).toContain('Create a separate initiative or capture cross-capability impact as claims/evidence')
    expect(contractBound).toContain("req.body.status === 'APPLIED' ? 'edit' : 'approve'")
  })
})
