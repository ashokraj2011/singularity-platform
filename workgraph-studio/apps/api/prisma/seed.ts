import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

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

  // Sample Workflow: Business Initiative Delivery
  const template = await prisma.workflow.upsert({
    where: { id: '30000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '30000000-0000-0000-0000-000000000001',
      name: 'Business Initiative Delivery',
      description: 'Standard template for delivering business initiatives from intake to outcome',
      teamId: platformTeam.id,
    },
  })

  await prisma.workflowVersion.upsert({
    where: { templateId_version: { templateId: template.id, version: 1 } },
    update: {},
    create: {
      templateId: template.id,
      version: 1,
      graphSnapshot: {
        phases: [
          { name: 'Intake', displayOrder: 0 },
          { name: 'Impact Analysis', displayOrder: 1 },
          { name: 'Planning', displayOrder: 2 },
          { name: 'Execution', displayOrder: 3 },
          { name: 'Launch Review', displayOrder: 4 },
        ],
        nodes: [
          { nodeType: 'HUMAN_TASK', label: 'Define Business Intent', config: { assignmentMode: 'TEAM_QUEUE' } },
          { nodeType: 'AGENT_TASK', label: 'Generate Impact Analysis', config: { agentId: 'a0000000-0000-0000-0000-000000000001' } },
          { nodeType: 'APPROVAL', label: 'Review Impact Analysis', config: {} },
          { nodeType: 'AGENT_TASK', label: 'Generate Epic Bundle', config: { agentId: 'a0000000-0000-0000-0000-000000000002' } },
          { nodeType: 'APPROVAL', label: 'Approve Epic Bundle', config: {} },
          { nodeType: 'TOOL_REQUEST', label: 'Create Jira Epics', config: { toolId: 't0000000-0000-0000-0000-000000000001' } },
        ],
      },
    },
  })

  // Seed admin user
  const adminPasswordHash = await bcrypt.hash('admin123', 12)
  const admin = await prisma.user.upsert({
    where: { email: 'admin@workgraph.local' },
    update: {},
    create: {
      email: 'admin@workgraph.local',
      displayName: 'Admin User',
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
  const demoPasswordHash = await bcrypt.hash('demo123', 12)
  const demoUser = await prisma.user.upsert({
    where: { email: 'demo@workgraph.local' },
    update: {},
    create: {
      email: 'demo@workgraph.local',
      displayName: 'Demo User',
      passwordHash: demoPasswordHash,
      teamId: growthTeam.id,
    },
  })

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: demoUser.id, roleId: '00000000-0000-0000-0000-000000000003' } },
    update: {},
    create: { userId: demoUser.id, roleId: '00000000-0000-0000-0000-000000000003' },
  })

  console.log('Seed complete!')
  console.log('  Admin: admin@workgraph.local / admin123')
  console.log('  Demo:  demo@workgraph.local / demo123')
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
