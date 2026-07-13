import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { seedArtifactTemplates } from './seed-artifact-templates'
import { seedDemoWorkflows } from './seed-demo-workflows'
import { seedHumanWorkflows } from './seed-human-workflows'

const prisma = new PrismaClient()

// Seed identities are overridable via SEED_* env vars; the defaults reproduce the
// historical local/dev seed exactly. In a production-class env the default dev
// passwords are refused so an operator can't accidentally ship them.
const SEED_ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'admin@workgraph.local'
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'admin123'
const SEED_ADMIN_NAME = process.env.SEED_ADMIN_NAME || 'Admin User'
const SEED_DEMO_EMAIL = process.env.SEED_DEMO_EMAIL || 'demo@workgraph.local'
const SEED_DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || 'demo123'
const SEED_DEMO_NAME = process.env.SEED_DEMO_NAME || 'Demo User'

const DEFAULT_SEED_PASSWORDS = new Set(['admin123', 'demo123'])
if (process.env.NODE_ENV === 'production') {
  for (const [label, value] of [['SEED_ADMIN_PASSWORD', SEED_ADMIN_PASSWORD], ['SEED_DEMO_PASSWORD', SEED_DEMO_PASSWORD]] as const) {
    if (DEFAULT_SEED_PASSWORDS.has(value)) {
      throw new Error(`Refusing to seed the default ${label} in a production-class environment; set a strong ${label}.`)
    }
  }
}

async function main() {
  console.log('Seeding database...')

  // Departments
  const [engDept, marketingDept, salesDept] = await Promise.all([
    prisma.department.upsert({
      where: { id: '40000000-0000-0000-0000-000000000001' },
      update: {},
      create: { id: '40000000-0000-0000-0000-000000000001', name: 'Engineering' },
    }),
    prisma.department.upsert({
      where: { id: '40000000-0000-0000-0000-000000000002' },
      update: {},
      create: { id: '40000000-0000-0000-0000-000000000002', name: 'Marketing' },
    }),
    prisma.department.upsert({
      where: { id: '40000000-0000-0000-0000-000000000003' },
      update: {},
      create: { id: '40000000-0000-0000-0000-000000000003', name: 'Sales' },
    }),
  ])

  // Teams
  const [platformTeam, growthTeam] = await Promise.all([
    prisma.team.upsert({
      where: { id: '50000000-0000-0000-0000-000000000001' },
      update: {},
      create: { id: '50000000-0000-0000-0000-000000000001', name: 'Platform Team', departmentId: engDept.id },
    }),
    prisma.team.upsert({
      where: { id: '50000000-0000-0000-0000-000000000002' },
      update: {},
      create: { id: '50000000-0000-0000-0000-000000000002', name: 'Growth Team', departmentId: marketingDept.id },
    }),
  ])
  void salesDept

  // System Roles
  const roleData = [
    { id: '00000000-0000-0000-0000-000000000001', name: 'SYSTEM_ADMIN', description: 'Full system access', isSystemRole: true },
    { id: '00000000-0000-0000-0000-000000000002', name: 'WORKFLOW_DESIGNER', description: 'Can create and edit workflow templates', isSystemRole: true },
    { id: '00000000-0000-0000-0000-000000000003', name: 'TASK_WORKER', description: 'Can claim and complete tasks', isSystemRole: true },
    { id: '00000000-0000-0000-0000-000000000004', name: 'APPROVER', description: 'Can approve requests and consumables', isSystemRole: true },
    { id: '00000000-0000-0000-0000-000000000005', name: 'AGENT_OPERATOR', description: 'Can initiate and review agent runs', isSystemRole: true },
    { id: '00000000-0000-0000-0000-000000000006', name: 'TOOL_ADMIN', description: 'Can manage tools and approve tool runs', isSystemRole: true },
  ]

  for (const role of roleData) {
    await prisma.role.upsert({ where: { id: role.id }, update: {}, create: role })
  }

  // Approval is permission-driven. Keep the permission catalog and its local
  // role bindings in the database so operators can change approvers through
  // Identity without editing application code.
  const approvalPermissionData = [
    { name: 'workflow:approve', resource: 'workflow', action: 'approve', description: 'Approve workflow and WorkItem decisions' },
    { name: 'agent:approve', resource: 'agent', action: 'approve', description: 'Review and approve agent runs' },
    { name: 'tool:approve_execution', resource: 'tool', action: 'approve_execution', description: 'Approve tool execution' },
    { name: 'governance:approve', resource: 'governance', action: 'approve', description: 'Approve governance waivers' },
    { name: 'consumable:approve', resource: 'consumable', action: 'approve', description: 'Approve generated deliverables' },
    { name: 'platform:all', resource: 'platform', action: 'all', description: 'Unrestricted local platform permission' },
  ]
  const approvalPermissions = new Map<string, { id: string }>()
  for (const permission of approvalPermissionData) {
    const row = await prisma.permission.upsert({
      where: { name: permission.name },
      update: { resource: permission.resource, action: permission.action, description: permission.description },
      create: permission,
      select: { id: true },
    })
    approvalPermissions.set(permission.name, row)
  }
  const roleBindings: Array<{ roleId: string; permissionName: string }> = [
    { roleId: '00000000-0000-0000-0000-000000000001', permissionName: 'platform:all' },
    { roleId: '00000000-0000-0000-0000-000000000004', permissionName: 'workflow:approve' },
    { roleId: '00000000-0000-0000-0000-000000000004', permissionName: 'governance:approve' },
    { roleId: '00000000-0000-0000-0000-000000000004', permissionName: 'consumable:approve' },
    { roleId: '00000000-0000-0000-0000-000000000005', permissionName: 'agent:approve' },
    { roleId: '00000000-0000-0000-0000-000000000006', permissionName: 'tool:approve_execution' },
  ]
  for (const binding of roleBindings) {
    const permission = approvalPermissions.get(binding.permissionName)
    if (!permission) continue
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: binding.roleId, permissionId: permission.id } },
      update: {},
      create: { roleId: binding.roleId, permissionId: permission.id },
    })
  }

  // Core Skills
  const skillData = [
    { id: '10000000-0000-0000-0000-000000000001', name: 'Data Analysis', description: 'Analyze and interpret data', category: 'Analytics' },
    { id: '10000000-0000-0000-0000-000000000002', name: 'Customer Outreach', description: 'Customer communication and engagement', category: 'Sales' },
    { id: '10000000-0000-0000-0000-000000000003', name: 'Risk Assessment', description: 'Evaluate business and operational risk', category: 'Compliance' },
    { id: '10000000-0000-0000-0000-000000000004', name: 'Technical Writing', description: 'Create clear technical documentation', category: 'Communication' },
    { id: '10000000-0000-0000-0000-000000000005', name: 'Campaign Management', description: 'Manage marketing campaigns', category: 'Marketing' },
    { id: '10000000-0000-0000-0000-000000000006', name: 'Impact Analysis', description: 'Assess business and technical impact', category: 'Analysis' },
    { id: '10000000-0000-0000-0000-000000000007', name: 'User Story Writing', description: 'Write user stories and acceptance criteria', category: 'Product' },
  ]

  for (const skill of skillData) {
    await prisma.skill.upsert({ where: { id: skill.id }, update: {}, create: skill })
  }

  // Consumable Types
  const consumableTypes = [
    {
      id: '20000000-0000-0000-0000-000000000001',
      name: 'BusinessIntentBrief',
      description: 'Initial business intent and goals',
      schemaDef: { type: 'object', properties: { title: { type: 'string' }, goals: { type: 'array', items: { type: 'string' } }, sponsor: { type: 'string' } } },
    },
    {
      id: '20000000-0000-0000-0000-000000000002',
      name: 'ImpactAnalysisReport',
      description: 'Analysis of business and technical impact',
      schemaDef: { type: 'object', properties: { summary: { type: 'string' }, affectedSystems: { type: 'array', items: { type: 'string' } }, riskLevel: { type: 'string' } } },
    },
    {
      id: '20000000-0000-0000-0000-000000000003',
      name: 'EpicBundle',
      description: 'Collection of epics for delivery',
      schemaDef: { type: 'object', properties: { epics: { type: 'array' } } },
    },
    {
      id: '20000000-0000-0000-0000-000000000004',
      name: 'UserStoryBundle',
      description: 'Collection of user stories',
      schemaDef: { type: 'object', properties: { stories: { type: 'array' } } },
    },
    {
      id: '20000000-0000-0000-0000-000000000005',
      name: 'CustomerSegment',
      description: 'A defined customer segment',
      schemaDef: { type: 'object', properties: { segmentName: { type: 'string' }, criteria: { type: 'object' }, estimatedSize: { type: 'number' } } },
    },
    {
      id: '20000000-0000-0000-0000-000000000006',
      name: 'CampaignBrief',
      description: 'Marketing campaign specification',
      schemaDef: { type: 'object', properties: { campaignName: { type: 'string' }, targetSegment: { type: 'string' }, channels: { type: 'array' } } },
    },
    {
      id: '20000000-0000-0000-0000-000000000007',
      name: 'RiskAssessment',
      description: 'Risk assessment document',
      schemaDef: { type: 'object', properties: { risks: { type: 'array' }, overallRisk: { type: 'string' } } },
    },
    {
      id: '20000000-0000-0000-0000-000000000008',
      name: 'ApprovalDecision',
      description: 'Recorded approval decision',
      schemaDef: { type: 'object', properties: { decision: { type: 'string' }, conditions: { type: 'string' } } },
    },
    {
      id: '20000000-0000-0000-0000-000000000009',
      name: 'OutcomeReport',
      description: 'Measured outcome report',
      schemaDef: { type: 'object', properties: { metrics: { type: 'array' }, summary: { type: 'string' } } },
    },
  ]

  for (const ct of consumableTypes) {
    await prisma.consumableType.upsert({ where: { id: ct.id }, update: {}, create: ct })
  }

  // Agents
  const agentData = [
    {
      id: 'a0000000-0000-0000-0000-000000000001',
      name: 'ImpactAnalysisAgent',
      description: 'Generates draft impact analysis reports',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are an expert business analyst. Generate a thorough impact analysis based on the provided business intent. Include affected systems, risks, and recommendations.',
    },
    {
      id: 'a0000000-0000-0000-0000-000000000002',
      name: 'EpicGeneratorAgent',
      description: 'Generates draft epics from impact analysis',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are a product manager. Based on the impact analysis provided, generate a set of well-structured epics with clear titles and descriptions.',
    },
    {
      id: 'a0000000-0000-0000-0000-000000000003',
      name: 'UserStoryAgent',
      description: 'Generates user stories from epics',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are a product analyst. Generate detailed user stories in the format "As a [user], I want [goal], so that [benefit]" with acceptance criteria.',
    },
    {
      id: 'a0000000-0000-0000-0000-000000000004',
      name: 'RiskReviewAgent',
      description: 'Reviews and identifies risks',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are a risk analyst. Review the provided information and identify potential risks, their likelihood, impact, and mitigation strategies.',
    },
    {
      id: 'a0000000-0000-0000-0000-000000000005',
      name: 'StatusSummaryAgent',
      description: 'Generates status summaries',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'You are a project coordinator. Summarize the current status, completed work, and next steps clearly and concisely.',
    },
  ]

  for (const agent of agentData) {
    await prisma.agent.upsert({ where: { id: agent.id }, update: {}, create: agent })
  }

  // Tools
  const toolData = [
    {
      id: 't0000000-0000-0000-0000-000000000001',
      name: 'jira.createEpicDraft',
      description: 'Create a draft epic in Jira',
      riskLevel: 'MEDIUM' as const,
      requiresApproval: true,
    },
    {
      id: 't0000000-0000-0000-0000-000000000002',
      name: 'confluence.createPage',
      description: 'Create a page in Confluence',
      riskLevel: 'LOW' as const,
      requiresApproval: false,
    },
    {
      id: 't0000000-0000-0000-0000-000000000003',
      name: 'github.createPullRequest',
      description: 'Create a pull request on GitHub',
      riskLevel: 'MEDIUM' as const,
      requiresApproval: true,
    },
    {
      id: 't0000000-0000-0000-0000-000000000004',
      name: 'slack.sendMessage',
      description: 'Send a Slack message',
      riskLevel: 'LOW' as const,
      requiresApproval: false,
    },
  ]

  for (const tool of toolData) {
    await prisma.tool.upsert({ where: { id: tool.id }, update: {}, create: tool })
  }

  // Tool Actions
  await prisma.toolAction.upsert({
    where: { id: 'ta000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: 'ta000000-0000-0000-0000-000000000001',
      toolId: 't0000000-0000-0000-0000-000000000001',
      name: 'createEpicDraft',
      description: 'Create a draft epic',
      inputSchema: { type: 'object', properties: { projectKey: { type: 'string' }, summary: { type: 'string' }, description: { type: 'string' } }, required: ['projectKey', 'summary'] },
      outputSchema: { type: 'object', properties: { epicId: { type: 'string' }, epicUrl: { type: 'string' } } },
    },
  })

  // Mock execution runner
  await prisma.executionRunner.upsert({
    where: { id: '60000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '60000000-0000-0000-0000-000000000001',
      name: 'Mock Runner',
      runnerType: 'MOCK',
      config: { delay_ms: 300, success_rate: 1.0 },
    },
  })

  // (Legacy 'Business Initiative Delivery' sample removed — the curated demo
  //  workflow set now lives entirely in seedDemoWorkflows: SDLC, Bug Fix,
  //  Epic → Story, Approval Pipeline, Branching Review.)

  // Seed admin user
  const adminPasswordHash = await bcrypt.hash(SEED_ADMIN_PASSWORD, 12)
  const admin = await prisma.user.upsert({
    where: { email: SEED_ADMIN_EMAIL },
    update: {},
    create: {
      email: SEED_ADMIN_EMAIL,
      displayName: SEED_ADMIN_NAME,
      passwordHash: adminPasswordHash,
      teamId: platformTeam.id,
    },
  })

  // Assign SYSTEM_ADMIN role to admin
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: '00000000-0000-0000-0000-000000000001' } },
    update: {},
    create: { userId: admin.id, roleId: '00000000-0000-0000-0000-000000000001' },
  })

  // Demo user
  const demoPasswordHash = await bcrypt.hash(SEED_DEMO_PASSWORD, 12)
  const demoUser = await prisma.user.upsert({
    where: { email: SEED_DEMO_EMAIL },
    update: {},
    create: {
      email: SEED_DEMO_EMAIL,
      displayName: SEED_DEMO_NAME,
      passwordHash: demoPasswordHash,
      teamId: growthTeam.id,
    },
  })

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: demoUser.id, roleId: '00000000-0000-0000-0000-000000000003' } },
    update: {},
    create: { userId: demoUser.id, roleId: '00000000-0000-0000-0000-000000000003' },
  })

  // Standard artifact-template catalog (Test Report, Design Document, …).
  await seedArtifactTemplates(prisma, admin.id)

  // Demo workflows: SDLC + bug-fix workbench loops, sample workflows, routing
  // policies, and one completed blueprint session with artifacts.
  await seedDemoWorkflows(prisma)

  // Human-only workflows (no agents): Access Request approval loop + full
  // Change Request loop (branching, parallel Security/CAB review, timer, forms).
  await seedHumanWorkflows(prisma)

  // M42.0 — Feature-flag defaults for the Singularity Code Foundry.
  // Code Foundry is part of the core Platform Web surface, so local/demo
  // installs ship enabled. Production operators can still turn these off
  // through /api/admin/feature-flags before exposing the surface.
  const codeFoundryFlags: Array<{ key: string; enabled: boolean; description: string }> = [
    {
      key: 'code_foundry.enabled',
      enabled: true,
      description: 'Master switch for the Singularity Code Foundry. When OFF every Foundry entry point (CLI / REST / web) returns FEATURE_DISABLED.',
    },
    {
      key: 'code_foundry.greenfield.enabled',
      enabled: true,
      description: 'Greenfield mode: generate a brand-new service from a structured spec. Gated by the master switch.',
    },
    {
      key: 'code_foundry.brownfield.enabled',
      enabled: true,
      description: 'Brownfield enhancement mode: scan an existing repo and apply typed change recipes. Enabled for local/demo parity with the Foundry cockpit.',
    },
    {
      key: 'code_foundry.llm_patch.enabled',
      enabled: true,
      description: 'Allow the Foundry to dispatch LLM patch tasks when the deterministic generator leaves a gap. When OFF the deterministic spine still runs but the gap report is returned unresolved.',
    },
  ]
  // Optional (code-foundry) feature flags — never let this non-core step abort
  // the whole seed. If the feature_flags table is somehow absent (legacy schema
  // drift), log and continue rather than failing the demo seed.
  try {
    for (const f of codeFoundryFlags) {
      await prisma.featureFlag.upsert({
        where: { key: f.key },
        update: { description: f.description },  // never override admin-toggled `enabled` on re-seed
        create: { key: f.key, enabled: f.enabled, description: f.description },
      })
    }
  } catch (e) {
    console.warn(`  ⚠ feature-flag seed skipped (non-fatal): ${(e as Error).message}`)
  }

  // LLM gateway routing defaults — two connections active (cloud + Copilot) and the
  // touch-point rules: Blueprint Workbench → cloud gateway, Copilot workflows
  // (COPILOT_SDLC) → Copilot gateway. DEFAULT scope only; admins can re-point in the
  // LLM-routing canvas, and re-seed never clobbers those overrides.
  try {
    // Both gateways run on Claude Sonnet 4.6 (the `copilot` alias resolves to Sonnet
    // 4.6 in the model catalog; the actual code edit still runs on the GitHub Copilot
    // CLI via executor=copilot).
    const connections = [
      { alias: 'claude-sonnet-4-6', name: 'Cloud — Claude Sonnet 4.6',            provider: 'anthropic', model: 'claude-sonnet-4-6', credentialEnv: 'ANTHROPIC_API_KEY' },
      { alias: 'copilot',           name: 'Copilot SDLC governed LLM (Sonnet 4.6)', provider: 'anthropic', model: 'claude-sonnet-4-6', credentialEnv: 'ANTHROPIC_API_KEY' },
    ]
    for (const c of connections) {
      const existing = await prisma.llmConnection.findFirst({ where: { alias: c.alias, tenantId: null } })
      if (existing) {
        await prisma.llmConnection.update({
          where: { id: existing.id },
          data: { name: c.name, provider: c.provider, model: c.model, credentialEnv: c.credentialEnv, enabled: true },
        })
      } else {
        await prisma.llmConnection.create({ data: { ...c, enabled: true, tenantId: null } })
      }
    }
    const routingDefaults = [
      { touchPoint: 'WORKBENCH',    modelAlias: 'claude-sonnet-4-6' },
      { touchPoint: 'COPILOT_SDLC', modelAlias: 'copilot' },
    ]
    for (const r of routingDefaults) {
      const existing = await prisma.llmRouting.findFirst({ where: { tenantId: null, touchPoint: r.touchPoint, scopeType: 'DEFAULT', scopeId: '' } })
      if (existing) {
        // Assert the policy DEFAULT (Workbench + Copilot both → Sonnet 4.6).
        // Admins still override per user/capability and survive re-seed.
        await prisma.llmRouting.update({ where: { id: existing.id }, data: { modelAlias: r.modelAlias, enabled: true } })
      } else {
        await prisma.llmRouting.create({ data: { tenantId: null, touchPoint: r.touchPoint, scopeType: 'DEFAULT', scopeId: '', modelAlias: r.modelAlias, enabled: true } })
      }
    }
    console.log('  LLM routing seeded: WORKBENCH→claude-sonnet-4-6, COPILOT_SDLC→copilot(=Sonnet 4.6)')
  } catch (e) {
    console.warn(`  ⚠ llm-routing seed skipped (non-fatal): ${(e as Error).message}`)
  }

  console.log('Seed complete!')
  console.log(`  Admin: ${SEED_ADMIN_EMAIL} / ${SEED_ADMIN_PASSWORD}`)
  console.log(`  Demo:  ${SEED_DEMO_EMAIL} / ${SEED_DEMO_PASSWORD}`)
  console.log(`  Feature flags seeded: ${codeFoundryFlags.length} (Code Foundry defaults ON for local/demo)`)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
