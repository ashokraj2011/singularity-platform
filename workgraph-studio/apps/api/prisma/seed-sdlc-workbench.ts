/**
 * Proper SDLC workflow that produces the right catalog artifacts (M102).
 *
 * A standalone workbench-loop template (profile='workbench') whose six stages
 * each declare `expectedArtifacts` linked to the seeded ArtifactTemplate
 * catalog (seed-artifact-templates.ts). The workbench's createLoopStageArtifacts
 * path generates + captures + renders one artifact per declared kind, and —
 * because each artifact carries a `templateId` — buildLoopStageVars injects the
 * template's section skeleton into the agent prompt (M102 B-runtime), so the
 * generated docs follow the catalog structure (Design Doc → Components/Risks,
 * Test Report → Scope/Results/Coverage, etc.).
 *
 *   Requirements → Design → Develop → QA → Security → Release(terminal)
 *
 * Catalog mapping:
 *   Requirements → tmpl-requirements-spec     (requirements_spec)
 *   Design       → tmpl-design-document + tmpl-adr
 *   Develop      → developer_task_pack + actual_code_change (real MCP/git edits)
 *   QA           → tmpl-test-report           (test_report)
 *   Security     → tmpl-risk-assessment       (risk_assessment)
 *   Release      → tmpl-release-rollback-plan + tmpl-ops-runbook
 *
 * Idempotent: looked up by name, deleted+recreated. Run:
 *   npx tsx prisma/seed-sdlc-workbench.ts
 * (Prereq: run seed-artifact-templates.ts so the catalog templates exist.)
 */
import { PrismaClient, Prisma, type NodeType } from '@prisma/client'

const prisma = new PrismaClient()

const CAPABILITY_ID = process.env.SEED_CAPABILITY_ID ?? '1a7d3cf9-fada-41a8-8382-4122d3179ca7'
const TEAM_ID = process.env.SEED_TEAM_ID ?? '548af461-e7eb-449e-af0f-37760d1d0a66'
const PRODUCT_OWNER_AGENT = process.env.SEED_PO_AGENT ?? '885ae4d8-7e5a-4f8c-81c1-1672889ac776'
const ARCHITECT_AGENT = process.env.SEED_ARCH_AGENT ?? '19f65cc6-f2f2-4c42-a0ac-27d180da07e9'
const DEVELOPER_AGENT = process.env.SEED_DEV_AGENT ?? 'aaa33b61-651c-4d1b-91ad-266febccdcb6'
const QA_AGENT = process.env.SEED_QA_AGENT ?? 'b2e283d0-4df0-49ff-8404-3d67b09779c5'
const SECURITY_AGENT = process.env.SEED_SEC_AGENT ?? '0dc3d00f-6c7d-4f50-8d4b-2dae422a7d6f'
const DEVOPS_AGENT = process.env.SEED_DEVOPS_AGENT ?? '056f0ad7-185b-455a-86be-2c6576c4c2d9'

const SDLC_NAME = 'SDLC implementation loop'

interface ArtifactSpec { kind: string; title: string; format: string; required: boolean; templateId?: string }
interface StageSpec {
  key: string; label: string; agentRole: string; agentTemplateId: string
  toolPolicy: string; contextPolicy: string; repoAccess: boolean
  terminal: boolean; approvalRequired: boolean
  expectedArtifacts: ArtifactSpec[]; sendBackTo: string[]
  // Per-stage step budget (overrides the runtime default, e.g. 28 for a
  // mutating dev stage). Develop needs more headroom because the agent must
  // implement AND add/run unit tests AND self-review in one stage.
  limits?: { maxSteps?: number }
}

const SDLC_STAGES: StageSpec[] = [
  {
    key: 'REQUIREMENTS', label: 'Requirements', agentRole: 'PRODUCT_OWNER', agentTemplateId: PRODUCT_OWNER_AGENT,
    toolPolicy: 'NONE', contextPolicy: 'STORY_ONLY', repoAccess: false, terminal: false, approvalRequired: true,
    expectedArtifacts: [
      { kind: 'requirements_spec', title: 'Requirements & Acceptance Spec', format: 'MARKDOWN', required: true, templateId: 'tmpl-requirements-spec' },
    ],
    sendBackTo: [],
  },
  {
    key: 'DESIGN', label: 'Design', agentRole: 'ARCHITECT', agentTemplateId: ARCHITECT_AGENT,
    toolPolicy: 'READ_ONLY', contextPolicy: 'REPO_READ_ONLY', repoAccess: true, terminal: false, approvalRequired: true,
    expectedArtifacts: [
      { kind: 'design_document', title: 'Design Document', format: 'MARKDOWN', required: true, templateId: 'tmpl-design-document' },
      { kind: 'adr', title: 'Architecture Decision Record', format: 'MARKDOWN', required: false, templateId: 'tmpl-adr' },
    ],
    sendBackTo: ['REQUIREMENTS'],
  },
  {
    key: 'DEVELOP', label: 'Develop', agentRole: 'DEVELOPER', agentTemplateId: DEVELOPER_AGENT,
    toolPolicy: 'MUTATION', contextPolicy: 'CODE_EDIT', repoAccess: true, terminal: false, approvalRequired: true,
    // Implement + add/extend unit tests + run them + self-review in one stage
    // needs well above the default ~40-step dev budget (WORKBENCH_DEVELOPER_MAX_STEPS).
    limits: { maxSteps: 160 },
    expectedArtifacts: [
      { kind: 'developer_task_pack', title: 'Developer task pack', format: 'MARKDOWN', required: true },
      { kind: 'actual_code_change', title: 'Actual MCP/git code-change evidence', format: 'MARKDOWN', required: true },
      // Tests are written in Develop (not QA): the developer must add/extend unit
      // tests for the new behavior AND run them green before this stage completes.
      { kind: 'unit_tests', title: 'Unit Test Cases (added/updated) + passing run', format: 'MARKDOWN', required: true },
    ],
    sendBackTo: ['REQUIREMENTS', 'DESIGN'],
  },
  {
    key: 'QA', label: 'QA', agentRole: 'QA', agentTemplateId: QA_AGENT,
    toolPolicy: 'VERIFICATION', contextPolicy: 'VERIFY_ONLY', repoAccess: true, terminal: false, approvalRequired: true,
    expectedArtifacts: [
      { kind: 'test_report', title: 'Test Report', format: 'MARKDOWN', required: true, templateId: 'tmpl-test-report' },
    ],
    sendBackTo: ['DESIGN', 'DEVELOP'],
  },
  {
    key: 'SECURITY', label: 'Security Review', agentRole: 'SECURITY', agentTemplateId: SECURITY_AGENT,
    toolPolicy: 'READ_ONLY', contextPolicy: 'EVIDENCE_REVIEW', repoAccess: true, terminal: false, approvalRequired: true,
    expectedArtifacts: [
      { kind: 'risk_assessment', title: 'Risk Assessment', format: 'MARKDOWN', required: true, templateId: 'tmpl-risk-assessment' },
    ],
    sendBackTo: ['DESIGN', 'DEVELOP'],
  },
  {
    key: 'RELEASE', label: 'Release Readiness', agentRole: 'DEVOPS', agentTemplateId: DEVOPS_AGENT,
    toolPolicy: 'READ_ONLY', contextPolicy: 'EVIDENCE_REVIEW', repoAccess: true, terminal: true, approvalRequired: true,
    expectedArtifacts: [
      { kind: 'release_rollback_plan', title: 'Release & Rollback Plan', format: 'MARKDOWN', required: true, templateId: 'tmpl-release-rollback-plan' },
      { kind: 'ops_runbook', title: 'Operations Runbook', format: 'MARKDOWN', required: false, templateId: 'tmpl-ops-runbook' },
    ],
    sendBackTo: ['DEVELOP', 'QA', 'SECURITY'],
  },
]

async function main(): Promise<void> {
  console.log(`Seeding "${SDLC_NAME}" (proper SDLC workbench loop with catalog artifacts)…`)
  const prior = await prisma.workflow.findFirst({ where: { name: SDLC_NAME } })
  if (prior) { await prisma.workflow.delete({ where: { id: prior.id } }); console.log(`✓ removed prior (${prior.id})`) }

  const wf = await prisma.workflow.create({
    data: {
      name: SDLC_NAME,
      description: 'Full SDLC loop (Requirements → Design → Develop → QA → Security → Release) whose stages emit the catalog artifacts (Requirements Spec, Design Doc, ADR, Test Report, Risk Assessment, Release/Rollback, Runbook).',
      status: 'PUBLISHED', teamId: TEAM_ID, capabilityId: CAPABILITY_ID, profile: 'workbench',
      workflowTypeKey: 'SDLC', typeVersion: 1,
      variables: [] as unknown as Prisma.InputJsonValue,
      eligibleWorkItemTypes: [] as unknown as Prisma.InputJsonValue,
    },
  })
  console.log(`✓ workflow ${wf.id}`)

  const workbenchConfig = {
    profile: 'blueprint', gateMode: 'manual', sourceType: 'github',
    sourceUri: '{{instance.vars.repoUrl}}', sourceRef: '', goal: '{{instance.vars.story}}',
    fallbackGoal: 'Deliver the change through the full SDLC with the required artifacts.',
    capabilityId: CAPABILITY_ID,
    agentBindings: {
      productOwnerAgentTemplateId: PRODUCT_OWNER_AGENT, architectAgentTemplateId: ARCHITECT_AGENT,
      developerAgentTemplateId: DEVELOPER_AGENT, qaAgentTemplateId: QA_AGENT,
      securityAgentTemplateId: SECURITY_AGENT, devopsAgentTemplateId: DEVOPS_AGENT,
    },
    loopDefinition: {
      version: 1, name: SDLC_NAME, maxLoopsPerStage: 3, maxTotalSendBacks: 8,
      stages: SDLC_STAGES.map((stage, idx) => ({
        key: stage.key, label: stage.label, agentRole: stage.agentRole, agentTemplateId: stage.agentTemplateId,
        next: idx < SDLC_STAGES.length - 1 ? SDLC_STAGES[idx + 1]!.key : undefined,
        terminal: stage.terminal, required: true, approvalRequired: stage.approvalRequired,
        allowedSendBackTo: stage.sendBackTo, toolPolicy: stage.toolPolicy, contextPolicy: stage.contextPolicy, repoAccess: stage.repoAccess,
        ...(stage.limits ? { limits: stage.limits } : {}),
        // templateId rides the JSON loopDefinition → normalizeExpectedArtifacts →
        // renderExpectedArtifacts injects the catalog section skeleton (M102).
        expectedArtifacts: stage.expectedArtifacts.map(a => ({ kind: a.kind, title: a.title, required: a.required, format: a.format, templateId: a.templateId })),
      })),
    },
    outputs: { finalPackKey: 'finalSdlcPack' },
  }

  await prisma.workflowDesignNode.create({
    data: {
      workflowId: wf.id, nodeType: 'WORKBENCH_TASK' as NodeType, label: 'SDLC Workbench',
      positionX: 320, positionY: 220, executionLocation: 'SERVER',
      config: { assignmentMode: 'TEAM_QUEUE', workbench: workbenchConfig } as Prisma.InputJsonValue,
    },
  })
  console.log('  + WORKBENCH_TASK node (6-stage SDLC loop)')

  // First-class WorkbenchDefinition + stage rows so the designer canvas renders.
  // (WorkbenchExpectedArtifact.templateId is a follow-up migration — the JSON
  // loopDefinition above is the runnable, templateId-carrying source of truth.)
  const wbDef = await prisma.workbenchDefinition.create({
    data: {
      workflowNodeId: wf.id, name: SDLC_NAME, version: 1, goal: '', sourceType: 'github',
      capabilityId: CAPABILITY_ID, architectAgentTemplateId: ARCHITECT_AGENT,
      developerAgentTemplateId: DEVELOPER_AGENT, qaAgentTemplateId: QA_AGENT,
      maxLoopsPerStage: 3, maxTotalSendBacks: 8, gateMode: 'manual',
    },
  })
  const rowByKey: Record<string, string> = {}
  for (const [idx, stage] of SDLC_STAGES.entries()) {
    const row = await prisma.workbenchStage.create({
      data: {
        definitionId: wbDef.id, stageKey: stage.key, label: stage.label, agentRole: stage.agentRole,
        agentTemplateId: stage.agentTemplateId, ordinal: idx, required: true, terminal: stage.terminal,
        approvalRequired: stage.approvalRequired, repoAccess: stage.repoAccess, toolPolicy: stage.toolPolicy, contextPolicy: stage.contextPolicy,
      },
    })
    rowByKey[stage.key] = row.id
    for (const [artIdx, art] of stage.expectedArtifacts.entries()) {
      await prisma.workbenchExpectedArtifact.create({
        data: { stageId: row.id, kind: art.kind, title: art.title, format: art.format, required: art.required, ordinal: artIdx },
      })
    }
  }
  for (let i = 0; i < SDLC_STAGES.length - 1; i++) {
    await prisma.workbenchStageEdge.create({ data: { fromStageId: rowByKey[SDLC_STAGES[i]!.key]!, toStageId: rowByKey[SDLC_STAGES[i + 1]!.key]!, kind: 'FORWARD' } })
  }
  for (const stage of SDLC_STAGES) {
    for (const target of stage.sendBackTo) {
      await prisma.workbenchStageEdge.create({ data: { fromStageId: rowByKey[stage.key]!, toStageId: rowByKey[target]!, kind: 'SEND_BACK' } })
    }
  }
  console.log(`  + WorkbenchDefinition + ${SDLC_STAGES.length} stage rows`)
  console.log(`\n✓ "${SDLC_NAME}" seeded. Each stage emits its catalog artifact(s); templateId drives section structure.`)
}

main().catch(err => { console.error(err); process.exit(1) }).finally(async () => { await prisma.$disconnect() })
