import { afterEach, describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createProjectSchema, updateProjectSchema, archiveProjectSchema } from '../src/modules/studio/studio-projects.router'
import { describeCapabilityReassignmentBlockers, shapeProject } from '../src/modules/studio/studio-projects.service'

describe('studio project schemas', () => {
  it('requires a name and primary platform capability, then supplies portfolio defaults', () => {
    const parsed = createProjectSchema.safeParse({ name: 'Payments Reliability', primaryCapabilityId: 'payments' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.tokenBudget).toBe(250_000)
      expect(parsed.data.reviewCadenceDays).toBe(30)
      expect('impactedCapabilityIds' in parsed.data).toBe(false)
      expect('supportingCapabilityIds' in parsed.data).toBe(false)
      expect('consumedCapabilityIds' in parsed.data).toBe(false)
      expect('proposedCapabilityIds' in parsed.data).toBe(false)
    }
    expect(createProjectSchema.safeParse({ name: 'Payments Reliability' }).success).toBe(false)
    expect(createProjectSchema.safeParse({ name: '  ' }).success).toBe(false)
    expect(createProjectSchema.safeParse({ mission: 'no name' }).success).toBe(false)
  })

  it('rejects meaningless budgets, out-of-range scores, and secondary capability links', () => {
    const base = { name: 'Payments Reliability', primaryCapabilityId: 'payments' }
    expect(createProjectSchema.safeParse({ ...base, tokenBudget: 9_999 }).success).toBe(false)
    expect(createProjectSchema.safeParse({ ...base, businessValue: 6 }).success).toBe(false)
    expect(createProjectSchema.safeParse({ ...base, deliveryRisk: 0 }).success).toBe(false)
    expect(createProjectSchema.safeParse({ ...base, impactedCapabilityIds: ['billing'] }).success).toBe(false)
    expect(createProjectSchema.safeParse({ ...base, supportingCapabilityIds: ['billing'] }).success).toBe(false)
    expect(createProjectSchema.safeParse({ ...base, consumedCapabilityIds: ['billing'] }).success).toBe(false)
    expect(createProjectSchema.safeParse({ ...base, proposedCapabilityIds: ['payments'] }).success).toBe(false)
    expect(updateProjectSchema.safeParse({ impactedCapabilityIds: ['billing'] }).success).toBe(false)
  })

  it('updateProjectSchema allows a partial patch and a null mission (clear it)', () => {
    expect(updateProjectSchema.safeParse({}).success).toBe(true)
    expect(updateProjectSchema.safeParse({ mission: null }).success).toBe(true)
    expect(updateProjectSchema.safeParse({ name: 'Renamed' }).success).toBe(true)
  })

  it('summarizes capability reassignment blockers once execution planning has started', () => {
    expect(describeCapabilityReassignmentBlockers({
      workItems: 0,
      generationPlans: 0,
      lockedSpecificationVersions: 0,
    })).toEqual([])
    expect(describeCapabilityReassignmentBlockers({
      workItems: 1,
      generationPlans: 2,
      lockedSpecificationVersions: 1,
    })).toEqual([
      '1 attached work item',
      '2 generation plans',
      '1 reviewed specification version',
    ])
  })

  it('archiveProjectSchema defaults archived to true', () => {
    expect(archiveProjectSchema.parse({})).toEqual({ archived: true })
    expect(archiveProjectSchema.parse({ archived: false })).toEqual({ archived: false })
  })

  it('keeps the database invariant to one primary capability link per initiative', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
    const migration = readFileSync(join(process.cwd(), 'prisma/migrations/20260809000000_single_capability_initiatives/migration.sql'), 'utf8')
    const capabilityModel = schema.match(/model SpecificationProjectCapability \{[\s\S]*?\n\}/)?.[0] ?? ''
    const projectModel = schema.match(/model SpecificationProject \{[\s\S]*?\n\}/)?.[0] ?? ''
    const capabilityRoleEnum = schema.match(/enum ProjectCapabilityRole \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(projectModel).toContain('primaryCapabilityId String')
    expect(projectModel).toContain('primaryCapabilityName String')
    expect(projectModel).toContain('@@index([tenantId, primaryCapabilityId], map: "ix_specification_projects_tenant_primary_capability")')
    expect(schema).toContain('role           ProjectCapabilityRole @default(PRIMARY)')
    expect(capabilityRoleEnum).toContain('PRIMARY')
    expect(capabilityRoleEnum).not.toMatch(/IMPACTED|SUPPORTING|CONSUMES|PROPOSED/)
    expect(capabilityModel).toContain('@@unique([projectId], map: "ux_specification_project_capabilities_one_per_project")')
    expect(capabilityModel).not.toContain('@@unique([projectId, capabilityId])')
    expect(migration).toContain('Every Synthesis initiative must be attached to exactly one active platform capability')
    expect(migration).toContain('do not guess')
    expect(migration).not.toContain('fallback_capability')
    expect(migration).not.toContain('capabilities_cache')
    expect(migration).toContain('ALTER COLUMN "primaryCapabilityId" SET NOT NULL')
    expect(migration).toContain('ix_specification_projects_tenant_primary_capability')
    expect(migration).toContain('chk_specification_project_capabilities_primary_only')
    expect(migration).toContain('ux_specification_project_capabilities_one_per_project')
    expect(migration).toContain('workgraph_assert_single_capability_initiative')
    expect(migration).toContain('trg_specification_projects_single_capability')
    expect(migration).toContain('trg_specification_project_capabilities_single_capability')
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED')
    expect(migration).toContain('"capabilityId" = project_record."primaryCapabilityId"')
    expect(migration).toContain('DROP INDEX IF EXISTS "specification_project_capabilities_projectId_capabilityId_key"')
    const service = readFileSync(join(process.cwd(), 'src/modules/studio/studio-projects.service.ts'), 'utf8')
    expect(service).toContain('assertCapabilityReassignmentAllowed')
    expect(service).toContain('An initiative capability cannot be changed after execution planning has started.')
    expect(service).toContain('tx.workItem.count({ where: { projectId, tenantId: tenant } })')
    expect(service).toContain('tx.generationPlan.count({ where: { specificationProjectId: projectId, tenantId: tenant } })')
    expect(service).toContain("status: { in: ['IN_REVIEW', 'LOCKED', 'GENERATING', 'ACTIVE', 'APPROVED', 'SUPERSEDED'] }")
  })
})

describe('shapeProject', () => {
  afterEach(() => vi.useRealTimers())

  it('adds portfolio scores, budget burn, aging, and claim counts', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-16T00:00:00.000Z'))
    const shaped = shapeProject({
      id: 'p1',
      code: 'PRJ-ABCDE',
      name: 'X',
      primaryCapabilityId: 'cap-primary',
      capabilityLinks: [
        { id: 'link-1', capabilityId: 'cap-primary', capabilityName: 'Primary', role: 'PRIMARY', impactArea: null },
        { id: 'link-2', capabilityId: 'cap-secondary', capabilityName: 'Secondary', role: 'IMPACTED', impactArea: null },
      ],
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
      updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      targetDate: new Date('2026-07-01T00:00:00.000Z'),
      reviewCadenceDays: 30,
      businessValue: 5,
      customerImpact: 4,
      strategicAlignment: 4,
      urgency: 3,
      deliveryRisk: 4,
      technicalRisk: 3,
      regulatoryRisk: 2,
      confidence: 4,
      effort: 2,
      tokenBudget: 100_000,
      tokenUsed: 25_000,
      claims: [],
      workItems: [],
      impactAssessments: [
        { capabilityId: 'cap-primary', status: 'COMPLETED', updatedAt: new Date('2026-06-01T00:00:00.000Z') },
        { capabilityId: 'cap-secondary', status: 'COMPLETED', updatedAt: new Date('2026-06-02T00:00:00.000Z') },
      ],
      _count: { workItems: 4, claims: 7 },
    })
    expect(shaped).toMatchObject({
      assignedCapability: { id: 'cap-primary', name: 'cap-primary' },
      workItemCount: 4,
      claimCount: 7,
      ageDays: 76,
      inactiveDays: 45,
      agingStatus: 'OVERDUE',
      valueScore: 4,
      riskScore: 3,
      priorityScore: 1,
      tokenBudgetPercent: 25,
      impactAssessmentStatus: 'COMPLETED',
    })
    expect(shaped.capabilityLinks).toEqual([
      { id: 'link-1', capabilityId: 'cap-primary', capabilityName: 'Primary', role: 'PRIMARY', impactArea: null },
    ])
    expect(shaped.impactAssessments).toEqual([
      { capabilityId: 'cap-primary', status: 'COMPLETED', updatedAt: new Date('2026-06-01T00:00:00.000Z') },
    ])
    expect('_count' in shaped).toBe(false)
  })
})
